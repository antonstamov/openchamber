import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

const installResponse = z.object({
  success: z.literal(true),
  autoRestart: z.boolean().optional(),
  updateOwner: z.string().optional(),
  version: z.string().min(1).optional(),
  restartManager: z.string().optional(),
  serviceUnit: z.string().optional(),
  jobId: z.string().optional(),
  logPath: z.string().optional(),
});
const checkResponse = z.object({
  available: z.boolean(),
  currentVersion: z.string().optional(),
  error: z.string().optional(),
});
const healthResponse = z.object({
  openchamberVersion: z.string().min(1).optional(),
});
const errorResponse = z.object({ error: z.string(), code: z.string().optional() });

/**
 * Whether the restarted server really serves the new interface, not just the
 * new package metadata. The update check reads the version from package.json
 * on disk, which the package manager replaces before the restart completes,
 * while the running process still serves the old (or half-replaced) dist. A
 * reload on the check alone lands on a missing index.html. The health version
 * comes from the running process memory, so matching it against the checked
 * version proves the restart even without a known previous version; a 200
 * text/html document proves the static route serves again.
 */
async function isRestartedServerServingUI(
  fetchUpdate: typeof runtimeFetch,
  signal: AbortSignal | undefined,
  options: { expectedVersion?: string; previousVersion?: string },
): Promise<{ serving: boolean; healthMatched: boolean }> {
  const noMatch = { serving: false, healthMatched: false };
  const expectedVersion = options.expectedVersion === 'unknown' ? undefined : options.expectedVersion;
  const previousVersion = options.previousVersion === 'unknown' ? undefined : options.previousVersion;
  let healthMatched = false;
  try {
    const health = await fetchUpdate('/health', {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!health.ok) return noMatch;
    const parsed = healthResponse.safeParse(await health.json().catch(() => null));
    const version = parsed.success ? parsed.data.openchamberVersion : undefined;
    if (version === undefined || version.length === 0) return noMatch;
    if (expectedVersion !== undefined) {
      if (version !== expectedVersion) return noMatch;
    } else if (previousVersion !== undefined && version === previousVersion) {
      return noMatch;
    }
    healthMatched = true;
  } catch {
    return noMatch;
  }

  try {
    const document = await fetchUpdate('/', {
      headers: { Accept: 'text/html' },
      signal,
    });
    if (!document.ok) return { serving: false, healthMatched };
    const contentType = document.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return { serving: false, healthMatched };
  } catch {
    return { serving: false, healthMatched };
  }

  return { serving: true, healthMatched };
}

type RestartManagerInfo = {
  restartManager?: string;
  serviceUnit?: string;
  jobId?: string;
  logPath?: string;
};

type UpdateTarget = { owner: 'electron'; version: string } | ({ owner: 'package-manager' } & RestartManagerInfo);
type InstallResult =
  | { success: true; autoRestart: boolean; target: UpdateTarget }
  | { success: false; error?: string };
type UpdateStallStage = 'install' | 'restart' | 'serve';
type AppliedResult =
  | { status: 'applied' }
  | ({ status: 'timeout' } & Partial<{ stage: UpdateStallStage; manualCommand: string } & RestartManagerInfo>)
  | { status: 'failed'; error: string };

export async function installWebUpdate(fetchUpdate = runtimeFetch): Promise<InstallResult> {
  try {
    const response = await fetchUpdate('/api/openchamber/update-install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = errorResponse.safeParse(payload);
      return { success: false, error: error.success ? error.data.error : undefined };
    }
    const parsed = installResponse.safeParse(payload);
    if (!parsed.success) return { success: false };
    const data = parsed.data;
    if (data.updateOwner === 'electron-updater') {
      if (!data.version) return { success: false };
      return { success: true, autoRestart: data.autoRestart !== false, target: { owner: 'electron', version: data.version } };
    }
    const target: UpdateTarget = { owner: 'package-manager' };
    if (data.restartManager) target.restartManager = data.restartManager;
    if (data.serviceUnit) target.serviceUnit = data.serviceUnit;
    if (data.jobId) target.jobId = data.jobId;
    if (data.logPath) target.logPath = data.logPath;
    return {
      success: true,
      autoRestart: data.autoRestart !== false,
      target,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : undefined };
  }
}

export async function waitForUpdateApplied(
  target: UpdateTarget,
  previousVersion?: string,
  { fetchUpdate = runtimeFetch, maxWaitMs = 10 * 60 * 1000, intervalMs = 2000 } = {},
): Promise<AppliedResult> {
  const deadline = Date.now() + maxWaitMs;
  let diskFlipped = false;
  let healthNew = false;
  while (Date.now() < deadline) {
    const signal = AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now())));
    try {
      const response = await fetchUpdate('/api/openchamber/update-check?appType=web&reportUsage=false&updateStatus=true', {
        method: 'GET', headers: { Accept: 'application/json' }, signal,
      });
      if (response.ok) {
        const parsed = checkResponse.safeParse(await response.json());
        if (parsed.success && !parsed.data.error) {
          const data = parsed.data;
          const applied = target.owner === 'electron'
            ? data.currentVersion === target.version
            : data.available === false || (previousVersion !== undefined && data.currentVersion !== undefined && data.currentVersion !== previousVersion);
          if (applied) {
            // The electron updater proves its target version above and keeps
            // its own behavior. A package-manager install must also prove the
            // restarted server serves the interface: the check flips when
            // package.json lands on disk, before the restart serves dist.
            if (target.owner === 'package-manager') {
              diskFlipped = true;
              const probe = await isRestartedServerServingUI(fetchUpdate, signal, {
                expectedVersion: data.currentVersion,
                previousVersion,
              });
              if (probe.serving) return { status: 'applied' };
              if (probe.healthMatched) healthNew = true;
              // Not ready yet: keep polling within the deadline.
            } else {
              return { status: 'applied' };
            }
          }
        }
      } else {
        const parsed = errorResponse.safeParse(await response.json().catch(() => null));
        if (parsed.success && parsed.data.code === 'DESKTOP_UPDATE_RESTART_FAILED') {
          return { status: 'failed', error: parsed.data.error };
        }
        if (target.owner === 'package-manager' && (response.status === 401 || response.status === 403)) {
          const probe = await isRestartedServerServingUI(fetchUpdate, signal, { previousVersion });
          if (probe.serving) return { status: 'applied' };
          if (probe.healthMatched) healthNew = true;
        }
      }
    } catch {
      // A restarting host can disconnect or time out; retry within the deadline.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  if (target.owner === 'electron') {
    return { status: 'timeout' };
  }
  const stage: UpdateStallStage = healthNew ? 'serve' : diskFlipped ? 'restart' : 'install';
  const timeout: Extract<AppliedResult, { status: 'timeout' }> = { status: 'timeout', stage };
  if (target.owner === 'package-manager') {
    if (target.restartManager) timeout.restartManager = target.restartManager;
    if (target.serviceUnit) timeout.serviceUnit = target.serviceUnit;
    if (target.jobId) timeout.jobId = target.jobId;
    if (target.logPath) timeout.logPath = target.logPath;
  }
  if (stage === 'restart' && target.owner === 'package-manager'
    && target.restartManager === 'systemd' && target.serviceUnit) {
    timeout.manualCommand = `systemctl --user restart ${target.serviceUnit}`;
  }
  return timeout;
}
