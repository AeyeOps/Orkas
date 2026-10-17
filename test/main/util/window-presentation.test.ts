import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installWindowPresentationEvents } from '../../../src/main/util/window-presentation';

function windowFixture() {
  const window = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), send: vi.fn() });
  const win = Object.assign(window, { webContents: contents });
  installWindowPresentationEvents(win);
  return { win, contents, states: () => contents.send.mock.calls.map(call => call[1]) };
}

describe('native window presentation for task transcripts', () => {
  it.each([['hide', 'show'], ['minimize', 'restore']])(
    'suspends on %s and resumes on %s independently of Chromium visibility', (background, foreground) => {
      const { win, contents, states } = windowFixture();
      win.emit(background);
      win.emit(background);
      win.emit(foreground);
      expect(states()).toEqual([{ active: false }, { active: true }]);
      expect(contents.send.mock.calls.every(call => call[0] === 'conversations:window-visibility')).toBe(true);
    },
  );

  it('keeps a visible unfocused transcript streaming without publishing a suspension', () => {
    const { win, contents, states } = windowFixture();
    contents.emit('did-finish-load');
    win.emit('blur');
    contents.emit('did-finish-load');
    win.emit('focus');
    expect(states()).toEqual([{ active: true }, { active: true }]);
  });

  it.each(['hide', 'minimize'])('does not let focus resume a transcript suspended by %s', event => {
    const { win, contents, states } = windowFixture();
    win.emit(event);
    win.emit('blur');
    win.emit('focus');
    contents.emit('did-finish-load');
    expect(states()).toEqual([{ active: false }, { active: false }]);
  });

  it('restores the latest background state after a renderer reload without replaying lifecycle transitions', () => {
    const { win, contents, states } = windowFixture();
    win.emit('hide');
    contents.send.mockClear();
    contents.emit('did-finish-load');
    expect(states()).toEqual([{ active: false }]);
    win.emit('show');
    expect(states()).toEqual([{ active: false }, { active: true }]);
  });

  it('leaves the initial hidden-at-launch first paint available and never sends to destroyed contents', () => {
    const { win, contents, states } = windowFixture();
    contents.emit('did-finish-load');
    expect(states()).toEqual([{ active: true }]);
    contents.isDestroyed.mockReturnValue(true);
    win.emit('hide');
    contents.emit('did-finish-load');
    expect(states()).toEqual([{ active: true }]);
  });
});
