import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { dispatchWebAssistPointer, consumeWebAssistPointerEvent, wakeWebAssistRendering, dispatchWebAssistKeys, consumeWebAssistKeyEvent } from '../../../src/main/features/web_assist_input';

const target = { ok: true, pointer: { x: 200, y: 100, width: 1280, height: 800 } };
function page(send = async (_method: string, _params: Record<string, unknown>) => ({}), attached = false) {
  return {
    isDestroyed: () => false,
    debugger: { isAttached: () => attached, attach: vi.fn(() => { attached = true; }),
      detach: vi.fn(() => { attached = false; }), sendCommand: vi.fn(send) },
  } as unknown as WebContents;
}
afterEach(() => vi.useRealTimers());

describe('target-scoped browser pointer failure recovery', () => {
  it('matches frame-local native receipts while preserving human input during a transformed drag', async () => {
    vi.useFakeTimers();
    const framed = { ok: true, pointer: { x: 300, y: 200, width: 1280, height: 800,
      eventPoint: { x: 40, y: 30, transform: [2, 0, 0, 2] } } };
    const contents = page(async (_method, params) => {
      const type = params.type === 'mousePressed' ? 'mouseDown' : params.type === 'mouseReleased' ? 'mouseUp' : 'mouseMove';
      const receipt = { type, button: 'left', x: 40 + 2 * (Number(params.x) - 300), y: 30 } as any;
      expect(consumeWebAssistPointerEvent(contents, { ...receipt, x: receipt.x + 10 })).toBe(false);
      expect(consumeWebAssistPointerEvent(contents, { ...receipt, type: 'mouseWheel' })).toBe(false);
      expect(consumeWebAssistPointerEvent(contents, receipt)).toBe(true);
      expect(consumeWebAssistPointerEvent(contents, receipt)).toBe(false);
      return {};
    });
    const result = dispatchWebAssistPointer(contents, async () => framed, () => null, () => 0.5, { x: 120, y: 0 });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ ok: true });
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 420, y: 200, button: 'left', buttons: 0, clickCount: 1 });
  });

  it('never mistakes human presses for AI input while a native acknowledgement is pending', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const contents = page(async (_method, params) => {
      if (params.type === 'mousePressed') {
        expect(consumeWebAssistPointerEvent(contents, { type: 'mouseDown', button: 'left', x: 10, y: 10 })).toBe(false);
        expect(consumeWebAssistPointerEvent(contents, { type: 'mouseDown', button: 'left', x: 100, y: 50 })).toBe(true);
        await new Promise<void>(resolve => { release = resolve; });
      }
      return {};
    });
    const result = dispatchWebAssistPointer(contents, async () => target, () => null, () => 0.5);
    await vi.advanceTimersByTimeAsync(50);
    expect(release).toBeTypeOf('function');
    // A second physical click at the same position is human input even before acknowledgement.
    expect(consumeWebAssistPointerEvent(contents, { type: 'mouseDown', button: 'left', x: 100, y: 50 })).toBe(false);
    release!();
    expect(await result).toMatchObject({ ok: true });
  });

  it('waits for a transient cover to clear and delivers exactly one click', async () => {
    vi.useFakeTimers();
    const contents = page();
    const prepare = vi.fn().mockResolvedValueOnce({ ok: false, code: 'element_obscured' }).mockResolvedValue(target);
    const result = dispatchWebAssistPointer(contents, prepare, () => null, () => 1);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ ok: true });
    expect(vi.mocked(contents.debugger.sendCommand).mock.calls.map(([, params]) => params.type))
      .toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('reports an unready target when the last covered-page check exhausts the deadline', async () => {
    vi.useFakeTimers();
    const contents = page();
    let checks = 0;
    const result = dispatchWebAssistPointer(contents, async () => {
      if (++checks > 1) await new Promise(resolve => setTimeout(resolve, 2000));
      return { ok: false, code: 'element_obscured' };
    }, () => null, () => 1);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ ok: false, code: 'element_not_ready' });
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
    const retry = dispatchWebAssistPointer(contents, async () => target, () => null, () => 1);
    await vi.runAllTimersAsync();
    expect(await retry).toMatchObject({ ok: true });
  });

  it('delivers native drags across the viewport boundary without a browser endpoint restriction', async () => {
    vi.useFakeTimers();
    const contents = page();
    const outside = dispatchWebAssistPointer(contents, async () => target, () => null, () => 1, { x: -201, y: 0 });
    await vi.runAllTimersAsync();
    expect(await outside).toMatchObject({ ok: true });
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', { type: 'mouseReleased', x: -1, y: 100, button: 'left', buttons: 0, clickCount: 1 });
    const corrected = dispatchWebAssistPointer(contents, async () => target, () => null, () => 1, { x: -200, y: 0 });
    await vi.runAllTimersAsync();
    expect(await corrected).toMatchObject({ ok: true });
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 0, y: 100, button: 'left', buttons: 0, clickCount: 1 });
  });

  it('times out a stalled hover recheck without pressing or detaching another debugger', async () => {
    vi.useFakeTimers();
    const contents = page(undefined, true);
    const prepare = vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(target)
      .mockImplementation(() => new Promise(() => {}));
    const result = dispatchWebAssistPointer(contents, prepare, () => null, () => 0.5);
    const rejected = expect(result).rejects.toMatchObject({ code: 'input_timeout' });
    await vi.runAllTimersAsync();
    await rejected;
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(1);
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 100 });
    expect(contents.debugger.detach).not.toHaveBeenCalled();
    expect(consumeWebAssistPointerEvent(contents, { type: 'mouseDown', button: 'left', x: 100, y: 50 })).toBe(false);
  });

  it('releases a held pointer after a failed move without replaying the press', async () => {
    vi.useFakeTimers();
    let pressed = false;
    const contents = page(async (_method, params) => {
      expect(consumeWebAssistPointerEvent(contents, { type: 'mouseDown', button: 'left', x: 100, y: 50 })).toBe(params.type === 'mousePressed');
      if (params.type === 'mousePressed') pressed = true;
      if (params.type === 'mouseMoved' && pressed) throw new Error('renderer disappeared');
      return {};
    });
    const result = dispatchWebAssistPointer(contents, async () => target, () => null, () => 0.5, { x: 160, y: 0 });
    const rejected = expect(result).rejects.toThrow('renderer disappeared');
    await vi.runAllTimersAsync();
    await rejected;
    const types = vi.mocked(contents.debugger.sendCommand).mock.calls.map(([, params]) => params.type);
    expect(types).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseReleased']);
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
    expect(consumeWebAssistPointerEvent(contents, { type: 'mouseDown', button: 'left', x: 100, y: 50 })).toBe(false);
  });

  it('rejects a resized target after hover without sending a press', async () => {
    vi.useFakeTimers();
    let scale = 0.5;
    const contents = page(async () => { scale = 1; return {}; });
    const result = dispatchWebAssistPointer(contents, async () => target, () => null, () => scale);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ ok: false, code: 'page_changed' });
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });
});

describe('rendering a hidden page before native input', () => {
  it('wakes a page that ignores throttling without retaining focus emulation or a debugger', async () => {
    vi.useFakeTimers();
    let rendering = false;
    let focused = false;
    const contents = page(async (method, params) => {
      expect(method).toBe('Emulation.setFocusEmulationEnabled');
      focused = params.enabled === true;
      return {};
    });
    contents.setBackgroundThrottling = vi.fn();
    const result = wakeWebAssistRendering(contents, async () => {
      if (focused) rendering = true;
      return rendering;
    });
    await vi.runAllTimersAsync();
    expect(await result).toBe('woken');
    expect(focused).toBe(false);
    expect(contents.debugger.isAttached()).toBe(false);
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(2);
  });

  it('withholds input when the page still cannot render after the temporary focus is released', async () => {
    const contents = page();
    contents.setBackgroundThrottling = vi.fn();
    expect(await wakeWebAssistRendering(contents, async () => false)).toBe('not_rendered');
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false });
    expect(contents.debugger.isAttached()).toBe(false);
  });

  it('preserves another debugger and its unknown emulation state', async () => {
    const contents = page(undefined, true);
    contents.setBackgroundThrottling = vi.fn();
    expect(await wakeWebAssistRendering(contents, async () => false)).toBe('not_rendered');
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
    expect(contents.debugger.detach).not.toHaveBeenCalled();
    expect(contents.debugger.isAttached()).toBe(true);
  });

  it('does not emulate focus when the page or task is no longer eligible after waiting', async () => {
    const contents = page();
    contents.setBackgroundThrottling = vi.fn();
    let eligible = true;
    expect(await wakeWebAssistRendering(contents, async () => {
      eligible = false;
      return false;
    }, () => eligible)).toBe('not_rendered');
    expect(contents.debugger.attach).not.toHaveBeenCalled();
  });

  it.each([true, false])('releases its debugger if the focus command enabled=%s stalls', async (enabled) => {
    vi.useFakeTimers();
    const contents = page(async (_method, params) => {
      if (params.enabled === enabled) return new Promise(() => {});
      return {};
    });
    contents.setBackgroundThrottling = vi.fn();
    const result = wakeWebAssistRendering(contents, async () => false);
    await vi.runAllTimersAsync();
    expect(await result).toBe('not_rendered');
    expect(contents.debugger.isAttached()).toBe(false);
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false });
  });

  it('shows a never-rendered page and holds input past the window where it is dropped', async () => {
    vi.useFakeTimers();
    let rendering = false;
    const contents = { setBackgroundThrottling: vi.fn((allowed: boolean) => { if (!allowed) rendering = true; }) } as unknown as WebContents;
    let state: string | undefined;
    const waking = wakeWebAssistRendering(contents, async () => rendering).then(value => { state = value; });
    // Measured: input within about half a second of a woken page's navigation is dropped.
    await vi.advanceTimersByTimeAsync(600);
    expect(contents.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(state).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    await waking;
    expect(state).toBe('woken');
  });
});


describe('native keyboard and pointer controls', () => {
  it.each(['hover', 'double_click', 'right_click'] as const)('dispatches %s through the target page only', async mode => {
    vi.useFakeTimers(); const contents = page();
    const result = dispatchWebAssistPointer(contents, async () => target, () => null, () => 1, undefined, undefined, mode);
    await vi.runAllTimersAsync(); expect(await result).toMatchObject({ ok: true });
    const events = vi.mocked(contents.debugger.sendCommand).mock.calls.map(([, args]) => args);
    if (mode === 'hover') expect(events).toEqual([{ type: 'mouseMoved', x: 200, y: 100 }]);
    else if (mode === 'double_click') expect(events.filter(e => e.type === 'mousePressed').map(e => e.clickCount)).toEqual([1, 2]);
    else expect(events.filter(e => e.type === 'mousePressed')).toMatchObject([{ button: 'right', buttons: 2 }]);
  });
  it('recognizes only its own native key events, leaving physical input with the user', async () => {
    let contents: WebContents;
    contents = page(async (_method, params) => {
      expect(consumeWebAssistKeyEvent(contents, { type: params.type, key: 'b' } as any)).toBe(false);
      expect(consumeWebAssistKeyEvent(contents, { type: params.type, key: 'a' } as any)).toBe(true);
      expect(consumeWebAssistKeyEvent(contents, { type: params.type, key: 'a' } as any)).toBe(false);
      return {};
    });
    expect(await dispatchWebAssistKeys(contents, 'Control+a', () => null)).toMatchObject({ ok: true });
    expect(contents.debugger.sendCommand).toHaveBeenCalledTimes(2);
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'a', modifiers: 2 }));
  });
  it('rejects unsupported key syntax and cancellation before dispatch', async () => {
    const contents = page();
    expect(await dispatchWebAssistKeys(contents, 'Unknown+Enter', () => null)).toMatchObject({ code: 'invalid_keys' });
    expect(await dispatchWebAssistKeys(contents, 'Enter', () => ({ ok: false, code: 'task_run_ended' }))).toMatchObject({ code: 'task_run_ended' });
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled();
  });
  it('releases a possibly held key when native key-down fails without replaying the press', async () => {
    const contents = page(async (_method, params) => { if (params.type === 'keyDown') throw new Error('fixture dispatch failure'); return {}; });
    await expect(dispatchWebAssistKeys(contents, 'Enter', () => null)).rejects.toThrow('fixture dispatch failure');
    expect(vi.mocked(contents.debugger.sendCommand).mock.calls.map(([, args]) => args.type)).toEqual(['keyDown', 'keyUp']);
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
  });
});

// A synchronous dialog freezes Chromium before native input acknowledgement.
// These cases reject duplicate releases/keypresses independently of tool output.
describe('native input yielding to browser dialog decisions', () => {
  it.each([1, 2])('does not replay a double-click release when dialog %s blocks its acknowledgement', async releaseIndex => {
    const { EventEmitter } = await import('node:events');
    const { attachWebAssistDialogs, WebAssistDialogOpenedError } = await import('../../../src/main/features/web_assist_dialogs');
    let releases = 0, acknowledge!: () => void;
    const emitter = new EventEmitter();
    emitter.on('-run-dialog', () => { throw new Error('Native UI must not open'); });
    const contents = Object.assign(emitter, page(async (_method, params) => {
      if (params.type === 'mouseReleased' && ++releases === releaseIndex) {
        return new Promise<void>(resolve => {
          acknowledge = resolve;
          emitter.emit('-run-dialog', { dialogType: 'confirm', messageText: 'Continue?', defaultPromptText: '' }, () => resolve());
        });
      }
      return {};
    }));
    const dialogs = attachWebAssistDialogs(contents, () => 'run', () => {})!;
    await expect(dispatchWebAssistPointer(contents, async () => target, () => null, () => 1, undefined, undefined, 'double_click'))
      .rejects.toBeInstanceOf(WebAssistDialogOpenedError);
    expect(releases).toBe(releaseIndex);
    dialogs.act(dialogs.pending()!.id, 'click', 'e2'); acknowledge();
    await Promise.resolve();
    expect(releases).toBe(releaseIndex);
    dialogs.dispose();
  });

  it.each(['keyDown', 'keyUp'])('releases a key once when %s opens a synchronous dialog', async trigger => {
    const { EventEmitter } = await import('node:events');
    const { attachWebAssistDialogs, WebAssistDialogOpenedError } = await import('../../../src/main/features/web_assist_dialogs');
    const emitter = new EventEmitter();
    emitter.on('-run-dialog', () => { throw new Error('Native UI must not open'); });
    const sent: string[] = [];
    const contents = Object.assign(emitter, page(async (_method, params) => {
      sent.push(String(params.type));
      if (params.type === trigger) return new Promise<void>(resolve => {
        emitter.emit('-run-dialog', { dialogType: 'confirm', messageText: 'Continue?', defaultPromptText: '' }, () => resolve());
      });
      return {};
    }));
    const dialogs = attachWebAssistDialogs(contents, () => 'run', () => {})!;
    await expect(dispatchWebAssistKeys(contents, 'Enter', () => null)).rejects.toBeInstanceOf(WebAssistDialogOpenedError);
    expect(sent).toEqual(['keyDown', 'keyUp']);
    dialogs.act(dialogs.pending()!.id, 'click', 'e2');
    await Promise.resolve();
    expect(sent).toEqual(['keyDown', 'keyUp']);
    dialogs.dispose();
  });
});
