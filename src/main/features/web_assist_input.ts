/** Target-scoped Chromium input. No window activation or system input is used. */
import type { Input, MouseInputEvent, WebContents } from 'electron';
import { OperationTimeoutError, withOperationTimeout } from '../util/operation-timeout';

import { interruptOnWebAssistDialog, WebAssistDialogOpenedError } from './web_assist_dialogs';
import { ownsWebAssistDebugger } from './web_assist_protocol';

type Result = Record<string, unknown>;
type Point = { x: number; y: number; width: number; height: number; eventPoint?: { x: number; y: number; transform?: number[] } };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const FRAME_CHECK_MS = 150;
const WAKE_FRAME_MS = 1500;
const WAKE_SETTLE_MS = 800;

/** Native mouse moves are delivered with animation frames. A task page whose
 *  document was created while its view was hidden (opened or navigated while
 *  the user watched another task, or under a minimised or hidden window)
 *  never produces one, so its first move is never acknowledged.
 *  backgroundThrottling:false only keeps a widget that has painted from being
 *  hidden again, which is why a page the user has seen once stays clickable.
 *  Reasserting it wakes some platforms. On Windows Electron 42, a short focus
 *  emulation pulse is also needed. It makes the document virtually visible,
 *  without showing the view or activating a window. Rendering continues after
 *  disabling emulation. Detach a session created by this wake operation;
 *  preserve the existing frame-controller session without virtual focus.
 *  Do not overwrite another debugger's unknown emulation state.
 *
 *  Input within about half a second of a woken page's navigation can be
 *  acknowledged but dropped; keep the measured 800 ms settle before input.
 *  `frame` reports false only when no frame arrived in time. */
export async function wakeWebAssistRendering(
  contents: WebContents,
  frame: (timeoutMs: number) => Promise<boolean>,
  canEmulateFocus: () => boolean = () => true,
): Promise<'rendering' | 'woken' | 'not_rendered'> {
  if (await frame(FRAME_CHECK_MS)) return 'rendering';
  contents.setBackgroundThrottling(false);
  if (!await frame(WAKE_FRAME_MS)) {
    if (!canEmulateFocus() || (contents.debugger.isAttached() && !ownsWebAssistDebugger(contents))) return 'not_rendered';
    const focus = (enabled: boolean) => withOperationTimeout(
      contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled }),
      { timeoutMs: WAKE_FRAME_MS, code: 'input_timeout', stage: 'browser rendering' },
    );
    const attachedHere = !contents.debugger.isAttached();
    try {
      if (attachedHere) contents.debugger.attach('1.3');
      try {
        await focus(true);
        await frame(WAKE_FRAME_MS);
      } finally {
        try {
          if (!contents.isDestroyed() && contents.debugger.isAttached()) await focus(false);
        } finally {
          if (attachedHere && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
        }
      }
    } catch (error) {
      // A busy renderer can also stall DevTools commands. No pointer was sent,
      // so preserve the same pre-input refusal and explicit retry path.
      if (error instanceof OperationTimeoutError) return 'not_rendered';
      throw error;
    }
    // Verify the page keeps rendering after releasing the temporary session.
    if (!await frame(WAKE_FRAME_MS)) return 'not_rendered';
  }
  await pause(WAKE_SETTLE_MS);
  return 'woken';
}
const pendingPointer = new WeakMap<WebContents, { x: number; y: number; type: MouseInputEvent['type']; button?: string; eventPoint?: { x: number; y: number } }>();
/** Consume one matching native event, never an entire in-flight command window. */
export function consumeWebAssistPointerEvent(contents: WebContents, input: MouseInputEvent): boolean {
  const expected = pendingPointer.get(contents);
  if (!expected || input.type !== expected.type || (expected.button && input.button !== expected.button)) return false;
  const matches = (point: { x: number; y: number }) => Math.abs(input.x - point.x) < 1 && Math.abs(input.y - point.y) < 1;
  if (!matches(expected) && !(expected.eventPoint && matches(expected.eventPoint))) return false;
  pendingPointer.delete(contents);
  return true;
}

export async function dispatchWebAssistPointer(
  contents: WebContents,
  prepare: () => Promise<Result>,
  validate: () => Result | null,
  scale: () => number,
  drag?: { x: number; y: number },
  onDispatch?: () => void,
  mode: string = 'click',
): Promise<Result> {
  const deadline = Date.now() + 2000;
  const command = async (method: string, params: Record<string, unknown>) => {
    const type = params.type === 'mousePressed' ? 'mouseDown' : params.type === 'mouseReleased' ? 'mouseUp' : 'mouseMove';
    const local = point?.eventPoint;
    const [xx, xy, yx, yy] = local?.transform || [1, 0, 0, 1];
    const dx = Number(params.x) - point!.x, dy = Number(params.y) - point!.y;
    pendingPointer.set(contents, { x: Number(params.x) * factor, y: Number(params.y) * factor, type,
      ...(local ? { eventPoint: { x: local.x + xx * dx + xy * dy, y: local.y + yx * dx + yy * dy } } : {}),
      ...(type !== 'mouseMove' ? { button: String(params.button || 'left') } : {}) });
    try {
      return await interruptOnWebAssistDialog(contents, () => withOperationTimeout(contents.debugger.sendCommand(method, params),
        { timeoutMs: 2000, code: 'input_timeout', stage: 'browser input' }));
    } finally { pendingPointer.delete(contents); }
  };
  let previous: Point | undefined;
  let point: Point | undefined;
  // Wait only before input. Never replay a dispatched click or drag.
  while (Date.now() < deadline) {
    const invalid = validate();
    if (invalid) return invalid;
    let result: Result;
    try {
      result = await withOperationTimeout(prepare(), {
        timeoutMs: Math.max(1, deadline - Date.now()), code: 'input_timeout', stage: 'browser target',
      });
    } catch (error) {
      if (!(error instanceof OperationTimeoutError)) throw error;
      point = undefined;
      break;
    }
    if (!result.pointer) {
      if (!['element_obscured', 'element_not_visible'].includes(String(result.code))) return result;
      previous = undefined;
    } else {
      point = result.pointer as Point;
      if (![point.x, point.y, point.width, point.height].every(Number.isFinite)) {
        return { ok: false, code: 'action_failed', error: 'The control position is unavailable.' };
      }
      if (previous && Math.abs(previous.x - point.x) < 0.5 && Math.abs(previous.y - point.y) < 0.5) break;
      previous = point;
      point = undefined;
    }
    await pause(50);
  }
  if (!point) return { ok: false, code: 'element_not_ready', error: 'The control is moving, hidden or covered; observe the page again.' };
  const invalid = validate();
  if (invalid) return invalid;
  const end = { x: point.x + (drag?.x || 0), y: point.y + (drag?.y || 0) };
  const factor = scale();
  const attachedHere = !contents.debugger.isAttached();
  let pressed = false;
  // CDP accepts page CSS coordinates and applies page zoom itself. Native
  // receipts use viewport pixels, converted separately above.
  let last = { x: point.x, y: point.y };
  const release = async (clickCount: number) => {
    try {
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: mode === 'right_click' ? 'right' : 'left', buttons: 0, clickCount });
    } catch (error) {
      if (error instanceof WebAssistDialogOpenedError) pressed = false;
      throw error;
    }
    pressed = false;
  };
  try {
    if (attachedHere) contents.debugger.attach('1.3');
    onDispatch?.();
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...last });
    if (mode === 'hover') return { ok: true, outcome: 'acted', action: 'hover' };
    // Hover handlers can replace or cover a control. Check again before pressing.
    const ready = await withOperationTimeout(prepare(), {
      timeoutMs: 2000, code: 'input_timeout', stage: 'browser target',
    });
    const hovered = ready.pointer as Point | undefined;
    if (!hovered || hovered.x !== point.x || hovered.y !== point.y) {
      return ready.ok === false ? ready : { ok: false, code: 'stale_element', error: 'The control moved; observe the page again.' };
    }
    const cancelled = validate();
    if (cancelled) return cancelled;
    if (scale() !== factor) return { ok: false, code: 'page_changed', error: 'The page resized; observe it again.' };
    pressed = true;
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...last, button: mode === 'right_click' ? 'right' : 'left', buttons: mode === 'right_click' ? 2 : 1, clickCount: 1 });
    if (drag) {
      for (let step = 1; step <= 12; step++) {
        const stopped = validate();
        if (stopped) return stopped;
        if (scale() !== factor) return { ok: false, code: 'page_changed', error: 'The page resized during the drag; observe it again.' };
        last = { x: point.x + drag.x * step / 12, y: point.y + drag.y * step / 12 };
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...last, button: 'left', buttons: 1 });
        await pause(16);
      }
    }
    await release(1);
    if (mode === 'double_click') {
      const invalid = validate(); if (invalid) return invalid;
      pressed = true;
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...last, button: 'left', buttons: 1, clickCount: 2 });
      await release(2);
    }
    return { ok: true, outcome: 'acted' };
  } finally {
    // Release even after cancellation so a page cannot keep a stuck pointer.
    if (pressed && !contents.isDestroyed()) {
      try { await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: mode === 'right_click' ? 'right' : 'left', buttons: 0, clickCount: 1 }); } catch { /* page may have gone */ }
    }
    if (attachedHere && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

const pendingKeys = new WeakMap<WebContents, { key: string; type: string }>();
export function consumeWebAssistKeyEvent(contents: WebContents, input: Input): boolean {
  const expected = pendingKeys.get(contents);
  if (!expected || expected.type !== input.type || expected.key.toLowerCase() !== String(input.key || '').toLowerCase()) return false;
  pendingKeys.delete(contents);
  return true;
}

/** Explicit key syntax, not intent inference; no global/system keyboard input. */
export async function dispatchWebAssistKeys(
  contents: WebContents, chord: string, validate: () => Result | null, onDispatch?: () => void,
): Promise<Result> {
  const parts = chord.split('+');
  const modifiersByName: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };
  let modifiers = 0;
  for (const modifier of parts.slice(0, -1)) {
    if (!modifiersByName[modifier]) return { ok: false, code: 'invalid_keys', error: 'Use a key or explicit modifier chord.' };
    modifiers |= modifiersByName[modifier];
  }
  const name = parts.at(-1) || '';
  const keyCodes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  const virtualKey = keyCodes[name] || (name.length === 1 ? name.toUpperCase().charCodeAt(0) : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(name) ? 111 + Number(name.slice(1)) : 0);
  if (!virtualKey) return { ok: false, code: 'invalid_keys', error: 'The key is unsupported.' };
  const key = name === 'Space' ? ' ' : name;
  const text = !(modifiers & 7) ? name.length === 1 ? name : name === 'Space' ? ' ' : name === 'Enter' ? '\r' : undefined : undefined;
  const params = { key, modifiers, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, ...(text ? { text, unmodifiedText: text } : {}) };
  const attachedHere = !contents.debugger.isAttached();
  const stopped = validate(); if (stopped) return stopped;
  let down = false;
  const send = async (type: 'keyDown' | 'keyUp') => {
    pendingKeys.set(contents, { key, type });
    try { await interruptOnWebAssistDialog(contents, () => withOperationTimeout(contents.debugger.sendCommand('Input.dispatchKeyEvent', { type, ...params }), { timeoutMs: 2000, code: 'input_timeout', stage: 'browser keyboard' })); }
    catch (error) {
      if (type === 'keyUp' && error instanceof WebAssistDialogOpenedError) down = false;
      throw error;
    } finally { pendingKeys.delete(contents); }
  };
  try {
    if (attachedHere) contents.debugger.attach('1.3');
    onDispatch?.(); down = true;
    await send('keyDown');
    await send('keyUp'); down = false;
    return { ok: true, outcome: 'acted', action: 'press' };
  } finally {
    if (down && !contents.isDestroyed()) await send('keyUp').catch(() => {});
    if (attachedHere && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
