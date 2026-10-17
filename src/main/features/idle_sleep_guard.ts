import { createLogger } from '../logger';

const log = createLogger('idle-sleep-guard');

/** The part of Electron's `powerSaveBlocker` this guard uses. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export interface IdleSleepGuardOptions {
  blocker: PowerSaveBlockerLike;
  /** The bus's in-memory "work is running" signal (also used by the window
   * close confirmation); it must stay cheap because it is polled. */
  hasActiveWork: () => boolean;
  intervalMs?: number;
}

export interface IdleSleepGuard {
  /** Re-evaluate now (also runs on every interval tick). */
  sync(): void;
  /** Stop polling and release the blocker. Idempotent. */
  stop(): void;
}

export const IDLE_SLEEP_GUARD_INTERVAL_MS = 10_000;

/**
 * Keep the computer out of idle sleep while Agent work runs, so a task the
 * user started and walked away from is not frozen when the machine idles.
 *
 * Uses `prevent-app-suspension`: the display may still turn off, and sleep
 * the user asks for (menu, lid, power button) still happens. The blocker is
 * held only while `hasActiveWork()` is true and released on the first tick
 * after the last run ends, so an idle app never keeps the machine awake.
 */
export function startIdleSleepGuard(opts: IdleSleepGuardOptions): IdleSleepGuard {
  const { blocker, hasActiveWork, intervalMs = IDLE_SLEEP_GUARD_INTERVAL_MS } = opts;
  let blockerId: number | null = null;
  let stopped = false;

  const release = (): void => {
    if (blockerId === null) return;
    const id = blockerId;
    blockerId = null;
    try {
      blocker.stop(id);
      log.info('idle sleep allowed: no Agent work is running');
    } catch (err) {
      log.warn('releasing the idle sleep blocker failed', { error: (err as Error)?.message || String(err) });
    }
  };

  const sync = (): void => {
    if (stopped) return;
    let active = false;
    try {
      active = hasActiveWork();
    } catch {
      // An unreadable signal must not pin the machine awake.
      active = false;
    }
    if (!active) {
      release();
      return;
    }
    if (blockerId !== null) return;
    try {
      blockerId = blocker.start('prevent-app-suspension');
      log.info('preventing idle sleep while Agent work runs');
    } catch (err) {
      // Retried on the next tick; a failure here never affects the run itself.
      log.warn('preventing idle sleep failed', { error: (err as Error)?.message || String(err) });
    }
  };

  const timer = setInterval(sync, intervalMs);
  timer.unref?.();
  sync();

  return {
    sync,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      release();
    },
  };
}
