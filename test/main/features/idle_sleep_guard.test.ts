import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: mocks.info, warn: mocks.warn }) }));

import {
  IDLE_SLEEP_GUARD_INTERVAL_MS,
  startIdleSleepGuard,
} from '../../../src/main/features/idle_sleep_guard';

function fakeBlocker() {
  let nextId = 1;
  const held = new Set<number>();
  return {
    held,
    start: vi.fn((_type: 'prevent-app-suspension') => {
      const id = nextId++;
      held.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => { held.delete(id); }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('keeping the computer awake while Agent work runs', () => {
  it('never blocks idle sleep while nothing runs', () => {
    const blocker = fakeBlocker();
    const guard = startIdleSleepGuard({ blocker, hasActiveWork: () => false });
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS * 5);
    expect(blocker.start).not.toHaveBeenCalled();
    guard.stop();
  });

  it('holds one app-suspension blocker for the whole run and releases it after the run ends', () => {
    const blocker = fakeBlocker();
    let active = true;
    const guard = startIdleSleepGuard({ blocker, hasActiveWork: () => active });

    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS * 3);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(blocker.held.size).toBe(1);

    active = false;
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS);
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(blocker.held.size).toBe(0);

    active = true;
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS);
    expect(blocker.start).toHaveBeenCalledTimes(2);
    expect(blocker.held.size).toBe(1);
    guard.stop();
  });

  it('picks up work that starts while the app is idle within one interval', () => {
    const blocker = fakeBlocker();
    let active = false;
    const guard = startIdleSleepGuard({ blocker, hasActiveWork: () => active });
    active = true;
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS - 1);
    expect(blocker.start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(blocker.start).toHaveBeenCalledTimes(1);
    guard.stop();
  });

  it('releases the blocker and stops polling when the app quits', () => {
    const blocker = fakeBlocker();
    const hasActiveWork = vi.fn(() => true);
    const guard = startIdleSleepGuard({ blocker, hasActiveWork });
    guard.stop();
    guard.stop();
    expect(blocker.stop).toHaveBeenCalledTimes(1);
    expect(blocker.held.size).toBe(0);
    const checks = hasActiveWork.mock.calls.length;
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS * 5);
    guard.sync();
    expect(hasActiveWork).toHaveBeenCalledTimes(checks);
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });

  it('does not keep the machine awake when the work signal cannot be read', () => {
    const blocker = fakeBlocker();
    let broken = false;
    const guard = startIdleSleepGuard({
      blocker,
      hasActiveWork: () => {
        if (broken) throw new Error('bus unavailable');
        return true;
      },
    });
    expect(blocker.held.size).toBe(1);
    broken = true;
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS);
    expect(blocker.held.size).toBe(0);
    guard.stop();
  });

  it('retries on the next tick when the system refuses the blocker, without throwing', () => {
    const blocker = fakeBlocker();
    blocker.start.mockImplementationOnce(() => { throw new Error('assertion refused'); });
    const guard = startIdleSleepGuard({ blocker, hasActiveWork: () => true });
    expect(blocker.held.size).toBe(0);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(IDLE_SLEEP_GUARD_INTERVAL_MS);
    expect(blocker.start).toHaveBeenCalledTimes(2);
    expect(blocker.held.size).toBe(1);
    guard.stop();
  });
});
