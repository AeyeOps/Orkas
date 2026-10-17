import { describe, expect, it } from 'vitest';
import { runInNewContext, createContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { buildWebAssistPointScript, webAssistVisualStampScript } from '../../../src/main/features/web_assist_visual';

describe('screenshot coordinate preparation', () => {
  it('pins the hit target and rejects changed documents, scroll and viewport before input', () => {
    let hit: object = {};
    const page = createContext({ crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, innerWidth: 1280, innerHeight: 960, scrollX: 0, scrollY: 0, devicePixelRatio: 2,
      document: { elementFromPoint: () => hit } });
    const stamp = runInNewContext(webAssistVisualStampScript, page);
    const run = (identity?: number) => runInNewContext(buildWebAssistPointScript(stamp, [27, 41], identity), page);
    const initial = run(); expect(initial).toMatchObject({ ok: true, pointer: { x: 27, y: 41, width: 1280, height: 960 } });
    expect(run(initial.pointer.identity).ok).toBe(true);
    hit = {}; expect(run(initial.pointer.identity)).toMatchObject({ ok: false, code: 'stale_element' });
    for (const property of ['innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'devicePixelRatio']) {
      const before = page[property]; page[property] = Number(before) + 1;
      expect(run()).toMatchObject({ ok: false, code: 'stale_page' }); page[property] = before;
    }
    page.__orkasVisualDocument = undefined; expect(run()).toMatchObject({ ok: false, code: 'stale_page' });
    runInNewContext(webAssistVisualStampScript, page); expect(run()).toMatchObject({ ok: false, code: 'stale_page' });
  });
  it('uses the deepest open-shadow hit and rejects an empty point', () => {
    let child: object | null = {};
    const host = { shadowRoot: { elementFromPoint: () => child } };
    let root: object | null = host;
    const page = createContext({ crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, innerWidth: 500, innerHeight: 400, scrollX: 0, scrollY: 0, devicePixelRatio: 2,
      document: { elementFromPoint: () => root } });
    const stamp = runInNewContext(webAssistVisualStampScript, page);
    const script = (id?: number) => buildWebAssistPointScript(stamp, [5, 6], id);
    const first = runInNewContext(script(), page);
    child = {}; expect(runInNewContext(script(first.pointer.identity), page)).toMatchObject({ ok: false, code: 'stale_element' });
    root = null; expect(runInNewContext(script(), page)).toMatchObject({ ok: false, code: 'invalid_point' });
  });
});
