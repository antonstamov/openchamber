/**
 * Markdown loops — portable scheduled-task definitions.
 *
 * Loops are git-commit-able markdown files with YAML frontmatter, discovered
 * from `.agents/loops/*.md` (project scope, including ancestor directories up
 * to the worktree root) and `~/.agents/loops/*.md` (user scope), mirroring the
 * skills discovery pattern (`packages/web/server/lib/opencode/skills.js`).
 *
 * File format:
 *
 *   ---
 *   name: daily-digest
 *   schedule: "0 9 * * *"
 *   enabled: true
 *   model: opencode/big-pickle
 *   agent: plan
 *   timezone: Europe/Kyiv
 *   ---
 *   Summarize repository changes since yesterday and post the digest.
 *
 * Field mapping (see packages/ui/src/lib/scheduledTasksApi.ts):
 *   name     -> task.name
 *   schedule -> task.schedule.kind "cron" + task.schedule.cron
 *   enabled  -> task.enabled (default false — loops only run when the file
 *               explicitly enables them, so discovery never auto-executes
 *               repository content)
 *   model    -> split into task.execution.providerID / task.execution.modelID
 *   agent    -> task.execution.agent (optional)
 *   timezone -> task.schedule.timezone (optional, defaults to the server zone)
  *   runIfMissed -> task.runIfMissed (optional boolean, default run)
 *   body     -> task.execution.prompt
 *
 * `thinking_level` and `goalEnabled`/`goalTokenBudget` are not part of the
 * portable format (they are UI-only today); editing them in the file has no
 * effect and they remain JSON/UI-only.
 *
 * Runtime state (lastRunAt, nextRunAt, lastStatus, ...) is never written to
 * the markdown file; it continues to live in the project config/state store.
 */

import { asNonEmptyString } from '../shared/guards.js';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseMdFile, writeMdFile } from '../opencode/markdown-files.js';
import { getAncestors, findWorktreeRoot } from '../opencode/config-files.js';
import { MAX_TASK_NAME_LENGTH } from '../projects/task-text-limits.js';
import { directoryReachability } from '../directory-reachability/index.js';
import { controlErrorFields } from '../openchamber-control/error.js';
import { isBoolean } from '../shared/object-guards.js';

export interface LoopDefinition {
  name: string;
  enabled: boolean;
  runIfMissed?: boolean;
  schedule: { kind: 'cron'; cron: string; timezone?: string };
  execution: { prompt: string; providerID: string; modelID: string; agent?: string };
}

export interface LoopFile {
  filePath: string;
  scope: 'user' | 'project';
}

export interface DiscoveredLoop extends LoopFile {
  definition: LoopDefinition | null;
  fingerprint?: string;
}

const isLoopFrontmatter = (value: unknown): value is {
  name?: unknown;
  schedule?: unknown;
  model?: unknown;
  timezone?: unknown;
  agent?: unknown;
  enabled?: unknown;
  runIfMissed?: unknown;
} => Boolean(value && typeof value === 'object');

const LOOP_DIR_NAME = 'loops';
const USER_LOOP_ROOT = () => path.join(os.homedir(), '.agents', LOOP_DIR_NAME);

const splitProviderModel = (value: string | null) => {
  const raw = value;
  if (!raw) {
    return null;
  }
  const separator = raw.indexOf('/');
  if (separator <= 0 || separator === raw.length - 1) {
    return null;
  }
  return {
    providerId: raw.slice(0, separator).trim(),
    modelId: raw.slice(separator + 1).trim(),
  };
};

export const parseLoopDefinition = (filePath: string): LoopDefinition | null => {
  let parsed;
  try {
    parsed = parseMdFile(filePath);
  } catch (error) {
    console.warn(`[loops] skipped malformed loop file ${filePath}:`, controlErrorFields(error)?.message ?? error);
    return null;
  }

  const frontmatter = isLoopFrontmatter(parsed.frontmatter)
    ? parsed.frontmatter
    : {};
  const name = asNonEmptyString(frontmatter.name);
  if (!name) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "name" is required`);
    return null;
  }
  if (name.length > MAX_TASK_NAME_LENGTH) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "name" exceeds ${MAX_TASK_NAME_LENGTH} characters`);
    return null;
  }

  const cron = asNonEmptyString(frontmatter.schedule);
  if (!cron) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "schedule" (cron expression) is required`);
    return null;
  }

  const prompt = asNonEmptyString(parsed.body);
  if (!prompt) {
    console.warn(`[loops] skipped ${filePath}: markdown body (the execution prompt) is required`);
    return null;
  }

  const providerModel = splitProviderModel(asNonEmptyString(frontmatter.model));
  if (!providerModel) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "model" must be "provider/model"`);
    return null;
  }

  const timezone = asNonEmptyString(frontmatter.timezone);
  const agent = asNonEmptyString(frontmatter.agent);
  const schedule: LoopDefinition['schedule'] = { kind: 'cron', cron };
  if (timezone) schedule.timezone = timezone;
  const execution: LoopDefinition['execution'] = {
    prompt,
    providerID: providerModel.providerId,
    modelID: providerModel.modelId,
  };
  if (agent) execution.agent = agent;

  // Optional: run the slot once when it was missed while the host slept or
  // was down. Absent preserves the stored choice and reads as true.
  // Deliberately outside the approval fingerprint: it changes when an
  // overdue run fires, not what runs, so adding the field must not
  // invalidate existing machine approvals.
  const runIfMissed = typeof frontmatter.runIfMissed === 'boolean' ? frontmatter.runIfMissed : undefined;

  return {
    name,
    enabled: isBoolean(frontmatter.enabled) ? frontmatter.enabled : false,
    ...(runIfMissed !== undefined ? { runIfMissed } : {}),
    schedule,
    execution,
  };
};

export const loopFingerprint = (definition: LoopDefinition) => createHash('sha256')
  .update(JSON.stringify({ name: definition.name, schedule: definition.schedule, execution: definition.execution }))
  .digest('hex');

export const setLoopFileEnabled = (filePath: string, enabled: boolean) => {
  if (!parseLoopDefinition(filePath)) {
    return false;
  }
  const { frontmatter, body } = parseMdFile(filePath);
  writeMdFile(filePath, { ...(frontmatter ?? {}), enabled: Boolean(enabled) }, body);
  return true;
};

const walkLoopMdFiles = (rootDir: string) => {
  if (!rootDir) {
    return [];
  }
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(rootDir, entry.name))
      .sort();
  } catch (error) {
    const code = controlErrorFields(error)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
};

export const discoverLoopFiles = (projectPath: string | null | undefined) => {
  const files: LoopFile[] = [];
  for (const filePath of walkLoopMdFiles(USER_LOOP_ROOT())) {
    files.push({ filePath, scope: 'user' });
  }
  if (projectPath) {
    const worktreeRoot = findWorktreeRoot(projectPath) || path.resolve(projectPath);
    for (const ancestor of getAncestors(projectPath, worktreeRoot)) {
      const root = path.join(ancestor, '.agents', LOOP_DIR_NAME);
      for (const filePath of walkLoopMdFiles(root)) {
        files.push({ filePath, scope: 'project' });
      }
    }
  }
  return files;
};

export const discoverLoops = (projectPath: string | null | undefined) => {
  const byName = new Map<string, DiscoveredLoop>();
  const loops: DiscoveredLoop[] = [];
  for (const { filePath, scope } of discoverLoopFiles(projectPath)) {
    const definition = parseLoopDefinition(filePath);
    if (!definition) {
      loops.push({ scope, filePath, definition: null });
      continue;
    }
    const existing = byName.get(definition.name);
    if (existing && (existing.scope === 'project' || scope === 'user')) {
      continue;
    }
    byName.set(definition.name, { scope, filePath, definition, fingerprint: loopFingerprint(definition) });
  }
  for (const entry of byName.values()) {
    loops.push(entry);
  }
  return loops;
};

export const readProjectLoops = async (projectPath: string, logger: { warn?: (message: string, details: { projectPath: string; error: string }) => void }) => {
  if (await directoryReachability.isUnreachable(projectPath)) return null;
  const roots = [USER_LOOP_ROOT(), ...getAncestors(projectPath, findWorktreeRoot(projectPath) || projectPath).map((folder) => path.join(folder, '.agents', LOOP_DIR_NAME))];
  if ((await Promise.all(roots.map(directoryReachability.isUnreachable))).includes(true)) return null;
  try {
    return discoverLoops(projectPath);
  } catch (error) {
    logger.warn?.('[ScheduledTasks] kept the saved loop tasks: their folder could not be read', {
      projectPath,
      error: String(controlErrorFields(error)?.message ?? error),
    });
    return null;
  }
};
