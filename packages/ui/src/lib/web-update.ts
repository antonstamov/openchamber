import { z } from 'zod';
import { runtimeFetch } from './runtime-fetch';

const installResponse = z.object({
  success: z.literal(true),
  autoRestart: z.boolean().optional(),
  updateOwner: z.string().optional(),
  version: z.string().min(1).optional(),
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
): Promise<boolean> {
  const expectedVersion = options.expectedVersion === 'unknown' ? undefined : options.expectedVersion;
  const previousVersion = options.previousVersion === 'unknown' ? undefined : options.previousVersion;
  try {
    const health = await fetchUpdate('/health', {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!health.ok) return false;
    const parsed = healthResponse.safeParse(await health.json().catch(() => null));
    const version = parsed.success ? parsed.data.openchamberVersion : undefined;
    if (version === undefined || version.length === 0) return false;
    if (expectedVersion !== undefined) {
      if (version !== expectedVersion) return false;
    } else if (previousVersion !== undefined && version === previousVersion) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const document = await fetchUpdate('/', {
      headers: { Accept: 'text/html' },
      signal,
    });
    if (!document.ok) return false;
    const contentType = document.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return false;
  } catch {
    return false;
  }

  return true;
}

type UpdateTarget = { owner: 'electron'; version: string } | { owner: 'package-manager' };
type InstallResult =
  | { success: true; autoRestart: boolean; target: UpdateTarget }
  | { success: false; error?: string };
type AppliedResult = { status: 'applied' } | { status: 'timeout' } | { status: 'failed'; error: string };

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
    return { success: true, autoRestart: data.autoRestart !== false, target: { owner: 'package-manager' } };
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
              const serving = await isRestartedServerServingUI(fetchUpdate, signal, {
                expectedVersion: data.currentVersion,
                previousVersion,
              });
              if (serving) return { status: 'applied' };
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
        // Package-manager restarts can replace the browser session. A native
        // update must still prove its target version after authentication.
        if (target.owner === 'package-manager' && (response.status === 401 || response.status === 403)) {
          const serving = await isRestartedServerServingUI(fetchUpdate, signal, { previousVersion });
          if (serving) return { status: 'applied' };
        }
      }
    } catch {
      // A restarting host can disconnect or time out; retry within the deadline.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  return { status: 'timeout' };
}
