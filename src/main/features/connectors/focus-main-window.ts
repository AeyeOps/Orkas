import { BrowserWindow } from 'electron';

export function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  // Background windows deliberately opt out of desktop activation. Keep
  // callback delivery independent from showing that window.
  if (!win || !win.isFocusable()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
