import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A daily slot missed while the host slept must not vanish silently.
 *
 * On Linux (and macOS) Node timers ride CLOCK_MONOTONIC / mach_absolute_time,
 * which freeze across suspend, so a timer armed before sleep fires late by the
 * whole sleep. When the process additionally restarts before that late firing
 * (the WSL case: systemd restart at 18:33 for a slot armed for 11:30), the
 * fresh sync recomputes nextRunAt from now and the missed occurrence is gone
 * without a trace: lastScheduledFor still names the previous day.
 *
 * The runtime must detect the overdue persisted slot on sync and, unless the
 * task opts out with runIfMissed: false, dispatch it once through the normal
 * scheduled claim path.
 */

import { createScheduledTasksRuntime } from './runtime.js';

const opencode = { sessionCreates: [] };

const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const installOpenCodeFetch = () => {
  globalThis.fetch = vi.fn(async (input) => {
    const { pathname } = new URL(input);
    if (pathname === '/api/session') {
      opencode.sessionCreates.push(Date.now());
      return jsonResponse({ data: { id: `sess-${opencode.sessionCreates.length}` } });
    }
    if (pathname === '/api/command') return jsonResponse({ data: [] });
    return jsonResponse({ data: {} });
  });
};

const UTC = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo, d, h, mi, s);

const MISSED_SLOT = UTC(2026, 0, 2, 11, 30, 0);
const PREVIOUS_SLOT = UTC(2026, 0, 1, 11, 30, 0);
const AFTER_SLOT = UTC(2026, 0, 2, 15, 55, 0);

const makeTask = (overrides = {}) => ({
  id: 'task-1',
  name: 'Daily check-in',
  enabled: true,
  schedule: { kind: 'daily', times: ['11:30'], timezone: 'UTC' },
  execution: { prompt: 'Check systems', providerID: 'openai', modelID: 'gpt-4o' },
  state: {
    createdAt: UTC(2026, 0, 1, 0, 0, 0),
    updatedAt: PREVIOUS_SLOT,
    lastStatus: 'sent',
    lastRunAt: PREVIOUS_SLOT,
    lastScheduledFor: PREVIOUS_SLOT,
    lastSessionId: 'sess-old',
    nextRunAt: MISSED_SLOT,
  },
  ...overrides,
});

/** In-memory project config with real claim semantics (mirrors the #2710 file). */
const createSharedProjectConfigRuntime = (initialTask) => {
  let currentTask = structuredClone(initialTask);

  const applyPatch = (patch) => {
    const nextState = { ...(currentTask.state || {}), ...patch, updatedAt: Date.now() };
    for (const key of ['nextRunAt', 'lastRunAt', 'lastDurationMs', 'lastScheduledFor', 'lastError', 'lastSessionId']) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] === undefined) {
        delete nextState[key];
      }
    }
    currentTask = { ...currentTask, state: nextState };
    return currentTask;
  };

  return {
    state: () => structuredClone(currentTask),
    listScheduledTasks: vi.fn(async () => [structuredClone(currentTask)]),
    reconcileLoopTasks: vi.fn(async () => [structuredClone(currentTask)]),
    updateScheduledTaskState: vi.fn(async (_pid, _tid, patch) => {
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    updateScheduledTaskStateIf: vi.fn(async (_pid, _tid, predicate, patch) => {
      if (!predicate(structuredClone(currentTask))) {
        return { task: structuredClone(currentTask), updated: false };
      }
      const task = applyPatch(patch);
      return { task: structuredClone(task), updated: true };
    }),
    upsertScheduledTask: vi.fn(async (_pid, input) => {
      // Mirror the real normalize: a missing state object keeps the stored one.
      const { state: inputState, ...rest } = input ?? {};
      currentTask = structuredClone({
        ...currentTask,
        ...rest,
        id: currentTask.id,
        ...(inputState === undefined ? {} : { state: inputState }),
      });
      return { task: structuredClone(currentTask), created: false };
    }),
  };
};

const createRuntimeDeps = (projectConfigRuntime) => ({
  projectConfigRuntime,
  listProjects: vi.fn(async () => [{ id: 'p1', path: '/repo' }]),
  buildOpenCodeUrl: () => 'http://127.0.0.1:9999/',
  getOpenCodeAuthHeaders: () => ({}),
  waitForOpenCodeReady: async () => {},
  emitTaskRunEvent: vi.fn(),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

beforeEach(() => {
  opencode.sessionCreates.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AFTER_SLOT));
  installOpenCodeFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Scheduling reads must go through Date.now(): the short-sleep tests below
// pin it with vi.spyOn while the fake timer queue advances separately, which
// simulates a monotonic clock frozen across suspend. A bare new Date() in the
// scheduling path would silently break that simulation (it follows the fake
// clock, currently parked at AFTER_SLOT).
describe('missed scheduled occurrence', () => {
  it('dispatches the overdue slot once on startup by default', async () => {
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask());
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(1);
      const state = projectConfigRuntime.state().state;
      expect(state.lastScheduledFor).toBe(MISSED_SLOT);
      expect(state.lastStatus).toBe('sent');
      expect(state.nextRunAt).toBe(UTC(2026, 0, 3, 11, 30, 0));
    } finally {
      runtime.stop();
    }
  });

  it('leaves the overdue slot behind when runIfMissed is false', async () => {
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({ runIfMissed: false }));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(0);
      const state = projectConfigRuntime.state().state;
      expect(state.lastScheduledFor).toBe(PREVIOUS_SLOT);
      expect(state.nextRunAt).toBe(UTC(2026, 0, 3, 11, 30, 0));
    } finally {
      runtime.stop();
    }
  });

  it('does not dispatch the overdue slot twice when a sync lands mid-run', async () => {
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask());
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await runtime.syncProject('p1');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(1);
    } finally {
      runtime.stop();
    }
  });

  it('dispatches a slot missed by seconds on restart, not just by hours', async () => {
    vi.setSystemTime(new Date(MISSED_SLOT + 3_000));
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask());
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(1);
      const state = projectConfigRuntime.state().state;
      expect(state.lastScheduledFor).toBe(MISSED_SLOT);
      expect(state.nextRunAt).toBe(UTC(2026, 0, 3, 11, 30, 0));
    } finally {
      runtime.stop();
    }
  });

  it('consumes an opted-out one-time task instead of stranding it enabled', async () => {
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      runIfMissed: false,
      schedule: { kind: 'once', date: '2026-01-02', time: '11:30', timezone: 'UTC' },
    }));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(0);
      const stored = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored).toHaveLength(1);
      expect(stored[0].enabled).toBe(false);
      expect(stored[0].state.lastStatus).toBe('skipped');
      expect(stored[0].state.nextRunAt).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });

  it('retries the missed slot on the next start when the first run never claimed it', async () => {
    // Crash between queue and claim must not advance nextRunAt.
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask());
    const origIf = projectConfigRuntime.updateScheduledTaskStateIf;
    let gated = true;
    const claimGate = new Promise(() => {});
    projectConfigRuntime.updateScheduledTaskStateIf = vi.fn(async (...args) => {
      if (gated) await claimGate;
      return origIf(...args);
    });
    const first = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await first.start();
      await vi.advanceTimersByTimeAsync(500);
      // The catch-up is queued and stuck before the claim: the advance must
      // not have been persisted yet, or the slot could never be retried.
      expect(projectConfigRuntime.state().state.nextRunAt).toBe(MISSED_SLOT);
    } finally {
      first.stop();
    }
    gated = false;
    const second = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await second.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(1);
      const state = projectConfigRuntime.state().state;
      expect(state.lastScheduledFor).toBe(MISSED_SLOT);
      expect(state.nextRunAt).toBe(UTC(2026, 0, 3, 11, 30, 0));
    } finally {
      second.stop();
    }
  });

  it('skips a late-firing opted-out timer and re-arms the next slot', async () => {
    // A short sleep the heartbeat does not treat as suspend: the wall clock
    // jumps past the armed slot while its timer is still pending. Fake timers
    // move Date.now along with the queue, so the test pins Date.now
    // separately to simulate the frozen monotonic clock waking up late.
    // Invariant under test: every scheduling read uses Date.now(), never a
    // bare new Date() (which would follow the fake clock instead).
    vi.setSystemTime(new Date(UTC(2026, 0, 2, 11, 29, 0)));
    let now = UTC(2026, 0, 2, 11, 29, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      runIfMissed: false,
      schedule: { kind: 'daily', times: ['11:30'], timezone: 'UTC' },
      state: {
        createdAt: UTC(2026, 0, 1, 0, 0, 0),
        updatedAt: PREVIOUS_SLOT,
        lastStatus: 'sent',
        lastRunAt: PREVIOUS_SLOT,
        lastScheduledFor: PREVIOUS_SLOT,
        lastSessionId: 'ses_old',
        nextRunAt: UTC(2026, 0, 2, 11, 30, 0),
      },
    }));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      now = UTC(2026, 0, 2, 11, 32, 0);
      // Past the armed 60s timer even with its 0-2s jitter.
      await vi.advanceTimersByTimeAsync(65_000);

      expect(opencode.sessionCreates).toHaveLength(0);
      // Skipped, not stranded: the next future slot is armed instead.
      expect(projectConfigRuntime.state().state.lastScheduledFor).toBe(PREVIOUS_SLOT);
      expect(projectConfigRuntime.state().state.nextRunAt).toBe(UTC(2026, 0, 3, 11, 30, 0));
    } finally {
      runtime.stop();
    }
  });

  it('consumes an opted-out one-time task whose late timer fires instead of re-arming it', async () => {
    // Same pinned-clock setup as the tests above: the timer fires late.
    let now = UTC(2026, 0, 2, 11, 29, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      runIfMissed: false,
      schedule: { kind: 'once', date: '2026-01-02', time: '11:30', timezone: 'UTC' },
      state: {
        createdAt: UTC(2026, 0, 1, 0, 0, 0),
        updatedAt: PREVIOUS_SLOT,
        lastStatus: 'sent',
        lastRunAt: PREVIOUS_SLOT,
        lastScheduledFor: PREVIOUS_SLOT,
        lastSessionId: 'ses_old',
        nextRunAt: UTC(2026, 0, 2, 11, 30, 0),
      },
    }));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      now = UTC(2026, 0, 2, 11, 32, 0);
      await vi.advanceTimersByTimeAsync(65_000);

      expect(opencode.sessionCreates).toHaveLength(0);
      const stored = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored[0].enabled).toBe(false);
      expect(stored[0].state.lastStatus).toBe('skipped');
      expect(stored[0].state.nextRunAt).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });

  it('still runs a late-firing timer when the task did not opt out', async () => {
    let now = UTC(2026, 0, 2, 11, 29, 0);
    // NOTE: the pinned Date.now below deliberately diverges from the fake
    // clock (which stays at AFTER_SLOT): every scheduling read in runtime.js
    // goes through Date.now(), and that invariant is what makes this
    // frozen-monotonic-clock simulation faithful. A bare new Date() read in
    // the scheduling path would silently break it.
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      schedule: { kind: 'daily', times: ['11:30'], timezone: 'UTC' },
      state: {
        createdAt: UTC(2026, 0, 1, 0, 0, 0),
        updatedAt: PREVIOUS_SLOT,
        lastStatus: 'sent',
        lastRunAt: PREVIOUS_SLOT,
        lastScheduledFor: PREVIOUS_SLOT,
        lastSessionId: 'ses_old',
        nextRunAt: UTC(2026, 0, 2, 11, 30, 0),
      },
    }));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      now = UTC(2026, 0, 2, 11, 32, 0);
      await vi.advanceTimersByTimeAsync(65_000);
      // The run is queued by the timer callback near the end of the window;
      // flush microtasks only (no timers) so the async dispatch finishes.
      for (let i = 0; i < 1000 && opencode.sessionCreates.length === 0; i += 1) {
        await Promise.resolve();
      }

      expect(opencode.sessionCreates).toHaveLength(1);
    } finally {
      runtime.stop();
    }
  });

  it('keeps the overdue slot when consuming it fails, so the next sync retries', async () => {
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      runIfMissed: false,
      schedule: { kind: 'once', date: '2026-01-02', time: '11:30', timezone: 'UTC' },
    }));
    // The guarded state write fails once: nothing is persisted, so the
    // overdue slot must survive for the next sync to retry.
    projectConfigRuntime.updateScheduledTaskStateIf.mockRejectedValueOnce(new Error('lock timeout'));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(0);
      expect(projectConfigRuntime.state().state.nextRunAt).toBe(MISSED_SLOT);
      expect(projectConfigRuntime.state().state.lastStatus).not.toBe('skipped');

      // Next sync retries and now succeeds.
      await runtime.syncProject('p1');
      await vi.advanceTimersByTimeAsync(2_000);

      const stored = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored[0].enabled).toBe(false);
      expect(stored[0].state.lastStatus).toBe('skipped');
      expect(stored[0].state.nextRunAt).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });

  it('records skipped on a disabled run that never got its terminal state', async () => {
    // Crash between the consume disable and its state write leaves a
    // disabled once task with an overdue slot and a stale status.
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      enabled: false,
      runIfMissed: false,
      schedule: { kind: 'once', date: '2026-01-02', time: '11:30', timezone: 'UTC' },
      state: {
        createdAt: UTC(2026, 0, 1, 0, 0, 0),
        updatedAt: PREVIOUS_SLOT,
        lastStatus: 'sent',
        lastRunAt: PREVIOUS_SLOT,
        lastScheduledFor: PREVIOUS_SLOT,
        lastSessionId: 'ses_old',
        nextRunAt: MISSED_SLOT,
      },
    }));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(0);
      const stored = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored[0].enabled).toBe(false);
      expect(stored[0].state.lastStatus).toBe('skipped');
      expect(stored[0].state.nextRunAt).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });

  it('finishes the disable when a crash left a skipped marker without it', async () => {
    // Crash between the consume marker and its disable leaves an enabled
    // once task with a skipped status and no slot: no retry is possible, so
    // the next sync finishes the disable instead of stranding it enabled.
    const projectConfigRuntime = createSharedProjectConfigRuntime(makeTask({
      enabled: true,
      runIfMissed: false,
      schedule: { kind: 'once', date: '2026-01-02', time: '11:30', timezone: 'UTC' },
      state: {
        createdAt: UTC(2026, 0, 1, 0, 0, 0),
        updatedAt: PREVIOUS_SLOT,
        lastStatus: 'skipped',
        lastRunAt: PREVIOUS_SLOT,
        lastScheduledFor: PREVIOUS_SLOT,
        lastSessionId: 'ses_old',
      },
    }));
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(opencode.sessionCreates).toHaveLength(0);
      const stored = await projectConfigRuntime.listScheduledTasks('p1');
      expect(stored[0].enabled).toBe(false);
      expect(stored[0].state.lastStatus).toBe('skipped');
      expect(stored[0].state.nextRunAt).toBeUndefined();
    } finally {
      runtime.stop();
    }
  });
});

describe('suspend detection heartbeat', () => {
  it('resyncs projects after a sleep-sized clock gap', async () => {
    const projectConfigRuntime = {
      listScheduledTasks: vi.fn(async () => []),
      reconcileLoopTasks: vi.fn(async () => []),
      updateScheduledTaskState: vi.fn(async () => ({ task: null })),
      updateScheduledTaskStateIf: vi.fn(async () => ({ task: null, updated: false })),
    };
    const runtime = createScheduledTasksRuntime(createRuntimeDeps(projectConfigRuntime));
    try {
      await runtime.start();
      expect(projectConfigRuntime.reconcileLoopTasks).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(61_000);
      expect(projectConfigRuntime.reconcileLoopTasks).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date(AFTER_SLOT + 8 * 3_600_000));
      await vi.advanceTimersByTimeAsync(61_000);
      expect(projectConfigRuntime.reconcileLoopTasks).toHaveBeenCalledTimes(2);
    } finally {
      runtime.stop();
    }
  });
});
