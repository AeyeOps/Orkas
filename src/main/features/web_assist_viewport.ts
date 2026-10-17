/** Per-tab renderer zoom. webFrame uses temporary zoom; webContents zoom
 * alone would change every same-origin tab in the shared login session. */
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron';
import { withOperationTimeout } from '../util/operation-timeout';

interface Viewport {
  factor: number;
  ready: boolean;
  revision: number;
  wake?: () => void;
  receipt?: { revision: number; frame: string; resolve: (applied: boolean) => void };
  update?: Promise<void>;
}
const viewports = new WeakMap<WebContents, Viewport>();
let registered = false;

/** The session preload also runs in windows that never get a viewport, such as
 * the passkey tunnel. Always release their synchronous factor call at full scale. */
export function configureWebAssistViewport(): void {
  if (registered) return;
  registered = true;
  ipcMain.on('web-assist:viewport-factor', event => {
    if (!viewports.has(event.sender)) event.returnValue = 1;
  });
}

export function attachWebAssistViewport(contents: WebContents, factor: number): void {
  const state: Viewport = { factor, ready: false, revision: 0 };
  viewports.set(contents, state);
  const main = (event: IpcMainEvent) => !contents.isDestroyed() && event.sender === contents && Boolean(event.senderFrame)
    && event.senderFrame?.frameToken === contents.mainFrame?.frameToken;
  const initial = (event: IpcMainEvent) => { event.returnValue = main(event) ? state.factor : 1; };
  const ready = (event: IpcMainEvent) => {
    if (!main(event)) return;
    state.ready = true;
    state.wake?.();
  };
  const applied = (event: IpcMainEvent, revision: unknown) => {
    if (!state.receipt || !main(event) || revision !== state.receipt.revision
      || event.senderFrame.frameToken !== state.receipt.frame) return;
    state.receipt.resolve(true);
  };
  // The current document stays in place until a replacement commits, and a
  // cancelled navigation (download, blocked scheme, 204) never commits one.
  // Keep serving it; a replacement re-handshakes through viewport-factor and
  // viewport-ready, and receipts are checked against the sending frame.
  const navigation = (_event: unknown, _url: string, sameDocument: boolean, mainFrame: boolean) => {
    if (!mainFrame || sameDocument) return;
    state.receipt?.resolve(false);
  };
  const dispose = () => {
    viewports.delete(contents);
    state.wake?.();
    state.receipt?.resolve(false);
    contents.ipc.removeListener('web-assist:viewport-factor', initial);
    contents.ipc.removeListener('web-assist:viewport-ready', ready);
    contents.ipc.removeListener('web-assist:viewport-applied', applied);
    contents.removeListener('did-start-navigation', navigation);
  };
  contents.ipc.on('web-assist:viewport-factor', initial);
  contents.ipc.on('web-assist:viewport-ready', ready);
  contents.ipc.on('web-assist:viewport-applied', applied);
  contents.on('did-start-navigation', navigation);
  contents.once('destroyed', dispose);
}

export function setWebAssistViewport(contents: WebContents, factor: number): Promise<void> {
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1) return Promise.reject(new Error('browser_viewport_unavailable'));
  const state = viewports.get(contents);
  if (!state) return Promise.reject(new Error('browser_viewport_unavailable'));
  state.factor = factor;
  if (state.update) return state.update;
  // One acknowledgement in flight; resize bursts retain only the latest scale.
  state.update = (async () => {
    try {
      for (;;) {
        if (!state.ready) await withOperationTimeout(new Promise<void>(resolve => { state.wake = resolve; }),
          { timeoutMs: 5000, code: 'browser_viewport_timeout', stage: 'browser viewport' });
        if (contents.isDestroyed()) throw new Error('browser_viewport_unavailable');
        const factor = state.factor, revision = ++state.revision, frame = contents.mainFrame.frameToken;
        const receipt = new Promise<boolean>(resolve => {
          state.receipt = { revision, frame, resolve };
        });
        contents.send('web-assist:viewport', revision, factor);
        const applied = await withOperationTimeout(receipt, { timeoutMs: 5000, code: 'browser_viewport_timeout', stage: 'browser viewport' });
        state.receipt = undefined;
        if (contents.isDestroyed()) throw new Error('browser_viewport_unavailable');
        // Navigation releases a pending wait, but only the renderer's receipt
        // proves that observation/input may use the requested layout.
        if (applied && state.ready && state.factor === factor && contents.mainFrame.frameToken === frame) return;
      }
    } finally {
      state.update = undefined;
      state.wake = undefined;
      state.receipt = undefined;
    }
  })();
  return state.update;
}
