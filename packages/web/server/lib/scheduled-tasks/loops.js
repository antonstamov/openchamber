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
import { parseMdFile, writeMdFile, getAncestors, findWorktreeRoot } from '../opencode/shared.js';
import { MAX_TASK_NAME_LENGTH } from '../projects/project-config.js';

const LOOP_DIR_NAME = 'loops';
const USER_LOOP_ROOT = () => path.join(os.homedir(), '.agents', LOOP_DIR_NAME);

const splitProviderModel = (value) => {
  const raw = asNonEmptyString(value);
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

export const parseLoopDefinition = (filePath) => {
  let parsed;
  try {
    parsed = parseMdFile(filePath);
  } catch (error) {
    console.warn(`[loops] skipped malformed loop file ${filePath}:`, error?.message ?? error);
    return null;
  }

  const frontmatter = parsed.frontmatter && typeof parsed.frontmatter === 'object'
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

  const providerModel = splitProviderModel(frontmatter.model);
  if (!providerModel) {
    console.warn(`[loops] skipped ${filePath}: frontmatter "model" must be "provider/model"`);
    return null;
  }

  const timezone = asNonEmptyString(frontmatter.timezone);
  const agent = asNonEmptyString(frontmatter.agent);

  // Optional: run the slot once when it was missed while the host slept or
  // was down. Absent preserves the stored choice and reads as true.
  // Deliberately outside the approval fingerprint: it changes when an
  // overdue run fires, not what runs, so adding the field must not
  // invalidate existing machine approvals.
  const runIfMissed = typeof frontmatter.runIfMissed === 'boolean' ? frontmatter.runIfMissed : undefined;

  return {
    name,
    enabled: typeof frontmatter.enabled === 'boolean' ? frontmatter.enabled : false,
    ...(runIfMissed !== undefined ? { runIfMissed } : {}),
    schedule: {
      kind: 'cron',
      cron,
      ...(timezone ? { timezone } : {}),
    },
    execution: {
      prompt,
      providerID: providerModel.providerId,
      modelID: providerModel.modelId,
      ...(agent ? { agent } : {}),
    },
  };
};

export const loopFingerprint = (definition) => createHash('sha256')
  .update(JSON.stringify({ name: definition.name, schedule: definition.schedule, execution: definition.execution }))
  .digest('hex');

export const setLoopFileEnabled = (filePath, enabled) => {
  if (!parseLoopDefinition(filePath)) {
    return false;
  }
  const { frontmatter, body } = parseMdFile(filePath);
  writeMdFile(filePath, { ...frontmatter, enabled: Boolean(enabled) }, body);
  return true;
};

const walkLoopMdFiles = (rootDir) => {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }
  try {
    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(rootDir, entry.name))
      .sort();
  } catch {
    return [];
  }
};

export const discoverLoopFiles = (projectPath) => {
  const files = [];
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

export const discoverLoops = (projectPath) => {
  const byName = new Map();
  const loops = [];
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
