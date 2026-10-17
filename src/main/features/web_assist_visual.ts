/** Fixed isolated-world scripts for screenshot-scoped viewport input. */
export interface WebAssistVisualStamp { token: string; width: number; height: number; scrollX: number; scrollY: number; pixelRatio: number }
export const webAssistVisualStampScript = String.raw`(() => {
  const state = globalThis.__orkasVisualDocument ||= { token: crypto.getRandomValues(new Uint32Array(4)).join('-'), nodes: new WeakMap(), next: 1 };
  return { token: state.token, width: innerWidth, height: innerHeight, scrollX, scrollY, pixelRatio: devicePixelRatio };
})()`;
export function buildWebAssistPointScript(stamp: WebAssistVisualStamp, point: number[], identity?: number): string {
  return String.raw`(() => {
    const expected = ${JSON.stringify(stamp)}, point = ${JSON.stringify(point)}, identity = ${JSON.stringify(identity ?? null)};
    const state = globalThis.__orkasVisualDocument;
    if (!state || state.token !== expected.token || innerWidth !== expected.width || innerHeight !== expected.height
      || scrollX !== expected.scrollX || scrollY !== expected.scrollY || devicePixelRatio !== expected.pixelRatio) {
      return { ok: false, code: 'stale_page', error: 'The screenshot viewport changed; take another screenshot.' };
    }
    let hit = document.elementFromPoint(point[0], point[1]);
    while (hit?.shadowRoot) {
      const child = hit.shadowRoot.elementFromPoint(point[0], point[1]);
      if (!child || child === hit) break;
      hit = child;
    }
    if (!hit) return { ok: false, code: 'invalid_point', error: 'No page target exists at this point.' };
    let id = state.nodes.get(hit);
    if (!id) { id = state.next++; state.nodes.set(hit, id); }
    if (identity !== null && identity !== id) return { ok: false, code: 'stale_element', error: 'The point target changed before input.' };
    return { ok: true, pointer: { x: point[0], y: point[1], width: innerWidth, height: innerHeight, identity: id } };
  })()`;
}
