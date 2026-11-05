import React from 'react';

import { useUpdateStore } from '@/stores/useUpdateStore';

// TEMP-RU-BUILD: see the polling effect below.
const RU_LOCAL_BUILD_PAUSE_POLLING = true;

export function useUpdatePolling() {
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const checkForUpdatesRef = React.useRef(checkForUpdates);

  React.useEffect(() => {
    checkForUpdatesRef.current = checkForUpdates;
  }, [checkForUpdates]);

  React.useEffect(() => {
    // TEMP-RU-BUILD: automatic checks read the upstream feed and would swap
    // this local Russian build for the English release. Polling stays off
    // until the fork feed lands; manual "Check for updates" in
    // Settings → About still works. Remove this block with the fork change.
    if (RU_LOCAL_BUILD_PAUSE_POLLING) return;
    const initialDelayMs = 3000;
    const defaultIntervalMs = 60 * 60 * 1000;
    const minIntervalMs = 5 * 60 * 1000;
    const maxIntervalMs = 24 * 60 * 60 * 1000;
    let disposed = false;
    let timer: number | null = null;

    const clampIntervalMs = (seconds: number): number => {
      const ms = Math.round(seconds * 1000);
      return Math.max(minIntervalMs, Math.min(maxIntervalMs, ms));
    };

    const scheduleNext = (delayMs: number) => {
      if (disposed) return;
      timer = window.setTimeout(async () => {
        const suggestedSec = await checkForUpdatesRef.current();
        const nextDelay = typeof suggestedSec === 'number' && Number.isFinite(suggestedSec)
          ? clampIntervalMs(suggestedSec)
          : defaultIntervalMs;
        scheduleNext(nextDelay);
      }, delayMs);
    };

    scheduleNext(initialDelayMs);

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);
}
