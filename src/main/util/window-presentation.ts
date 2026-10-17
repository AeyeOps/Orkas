interface PresentationWindow {
  on(event: string, listener: () => void): unknown;
  webContents: {
    on(event: string, listener: () => void): unknown;
    isDestroyed(): boolean;
    send(channel: string, payload: { active: boolean }): void;
  };
}

/** Native presentation signals complement Page Visibility: embedded views or
 * a hidden-at-launch window can keep Chromium's document state visible.
 * This channel changes rendering only; no task or persistence handle travels.
 */
export function installWindowPresentationEvents(win: PresentationWindow): void {
  // Electron considers hidden-at-launch documents visible until a lifecycle
  // transition. Keep that first-paint contract, including isolated E2E windows.
  let active = true;
  const publish = () => {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('conversations:window-visibility', { active });
    }
  };
  const update = (value: boolean) => {
    if (active === value) return;
    active = value;
    publish();
  };
  // Focus does not determine visibility: a user can read a streaming reply
  // beside another app. Suspend only when the window is hidden or minimized.
  for (const event of ['hide', 'minimize']) win.on(event, () => update(false));
  for (const event of ['show', 'restore']) win.on(event, () => update(true));
  // A renderer reload must recover the last native state, including a hide
  // that happened before its push listener was ready.
  win.webContents.on('did-finish-load', publish);
}
