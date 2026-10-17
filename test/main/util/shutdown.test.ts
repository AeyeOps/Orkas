import { describe, expect, it, vi } from 'vitest';
import { createShutdownCoordinator } from '../../../src/main/util/shutdown';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('application shutdown durability and latency', () => {
  it('coalesces a quit emitted synchronously by local cleanup', async () => {
    let reentered: Promise<void> | undefined;
    let calls = 0;
    const shutdown = createShutdownCoordinator({
      localTasks: [{ name: 'local', run: () => {
        if (++calls === 1) reentered = shutdown.prepare();
      } }], onFailure: vi.fn(),
    });
    const pending = shutdown.prepare();
    await pending;
    expect(calls).toBe(1);
    expect(reentered).toBe(pending);
  });

  it('finishes independent local saves together before normal exit', async () => {
    const search = gate();
    const browser = gate();
    const started: string[] = [];
    const shutdown = createShutdownCoordinator({
      localTasks: [
        { name: 'search', run: () => { started.push('search'); return search.promise; } },
        { name: 'browser', run: () => { started.push('browser'); return browser.promise; } },
      ], onFailure: vi.fn(),
    });
    const pending = shutdown.prepare();
    await Promise.resolve();
    expect(started).toEqual(['search', 'browser']);
    search.release();
    await Promise.resolve();
    expect(shutdown.complete).toBe(false);
    browser.release();
    await pending;
    expect(shutdown.complete).toBe(true);
  });


  it('drains remaining local saves and reports a failed cleanup once', async () => {
    const saved = gate();
    const onFailure = vi.fn();
    const shutdown = createShutdownCoordinator({
      localTasks: [
        { name: 'broken', run: () => { throw new Error('controlled failure'); } },
        { name: 'browser', run: () => saved.promise },
      ], onFailure,
    });
    const pending = shutdown.prepare();
    await Promise.resolve();
    expect(shutdown.complete).toBe(false);
    saved.release();
    await pending;
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('broken');
    expect(shutdown.complete).toBe(true);
  });

});
