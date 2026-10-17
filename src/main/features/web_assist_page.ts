/**
 * Fixed-script DOM adapter for the isolated Web Assist page.
 *
 * Model input is serialized as data into reviewed scripts; callers cannot
 * provide JavaScript. Element paths stay in main-process memory and the model
 * receives only short snapshot-scoped references.
 */

import { displayBrowserUrl } from './web_assist_url';

export type WebAssistPageAction =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'scroll'
  | 'drag'
  | 'upload'
  | 'press'
  | 'hover'
  | 'double_click'
  | 'right_click';

export interface WebAssistElementSignature {
  tag: string;
  type: string;
  role: string;
  label: string;
}

export interface WebAssistRawElement {
  path: number[];
  signature: WebAssistElementSignature;
  tag: string;
  role: string;
  label: string;
  input_type: string;
  placeholder: string;
  href: string;
  disabled: boolean;
  checked: boolean | null;
  sensitive: boolean;
  fillable: boolean;
  options: string[];
  option_count?: number;
  identity?: number;
  documentToken?: string;
}

export interface WebAssistRawObservation {
  ok: true;
  title: string;
  document_kind?: 'non_html';
  content_type?: string;
  text: string;
  text_offset: number;
  text_total: number;
  text_next_offset: number | null;
  elements: WebAssistRawElement[];
  element_offset: number;
  element_count: number;
  element_next_offset: number | null;
  elements_truncated: boolean;
  text_truncated: boolean;
}

export interface WebAssistStoredElementRef {
  identity?: number;
  documentToken?: string;
  path: number[];
  signature: WebAssistElementSignature;
}

export type WebAssistPageScope = 'browser' | 'connector_setup';

/** Where in the page a caller wants to read from. Per-call size does not
 *  change; these only move the window, so the default reply is what it was. */
export interface WebAssistObserveWindow {
  textOffset?: number;
  elementOffset?: number;
  frameId?: string;
  /** Estimated tokens the whole result may fill (host-side only; the page
   *  script never sees it). Omitted means the ordinary per-result ceiling. */
  tokenBudget?: number;
}

function safeOffset(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// The host selects the existing controller contract; page/model data cannot widen it.
export function webAssistObserveScript(
  scope: WebAssistPageScope = 'browser',
  window: WebAssistObserveWindow = {},
): string {
  return String.raw`
(() => {

  const MAX_ELEMENTS = 80;
  const MAX_TEXT = 6000;
  const TEXT_FROM = ${safeOffset(window.textOffset)};
  const ELEMENT_FROM = ${safeOffset(window.elementOffset)};
  const normalize = (value, cap = 240) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const labelFor = (element) => {
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText) : [];
    return normalize(
      element.getAttribute('aria-label')
      || labels.join(' ')
      || (element.tagName !== 'TEXTAREA' && !element.isContentEditable ? element.innerText : '')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.getAttribute('alt')
      || element.getAttribute('name')
      || element.tagName,
    );
  };
  const structuralPath = (element) => {
    const path = [];
    let node = element;
    while (node && node !== document) {
      const parent = node.parentNode;
      if (!parent) return [];
      const children = parent.children ? Array.from(parent.children) : [];
      const index = children.indexOf(node);
      if (index < 0) return [];
      path.unshift(index);
      if (parent instanceof ShadowRoot) {
        path.unshift(-1);
        node = parent.host;
      } else {
        node = parent;
      }
    }
    return path;
  };
  const sensitiveControl = (element) => {
    const type = String(element.type || '').toLowerCase();
    const autocomplete = String(element.autocomplete || element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
    return type === 'password'
      || autocomplete.includes('current-password')
      || autocomplete.includes('new-password')
      || autocomplete.includes('one-time-code')
      || autocomplete.some((token) => token.startsWith('cc-'));
  };
  const identities = globalThis.__orkasBrowserNodes ||= { nodes: new WeakMap(), refs: new Map(), next: 1, token: crypto.randomUUID() };
  for (const [id, ref] of identities.refs) if (!ref.deref()) identities.refs.delete(id);
  const identityFor = element => {
    let id = identities.nodes.get(element);
    if (!id) { id = identities.next++; identities.nodes.set(element, id); identities.refs.set(id, new WeakRef(element)); }
    return id;
  };
  const selectors = [
    'a[href]', 'button', 'input', 'select', 'textarea', '[contenteditable]:not([contenteditable="false"])', '[onclick]', '[tabindex]', 'canvas',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="tab"]', '[role="menuitem"]', '[role="combobox"]',
    '[role="slider"]', '[role="listbox"]', '[role="grid"]', '[draggable="true"]', '[role="treeitem"]', '[role="option"]', '[role="switch"]', '[role="menuitemcheckbox"]',
  ].join(',');
  const candidates = [];
  const seen = new Set();
  const collect = (root) => {
    for (const element of root.querySelectorAll(selectors)) {
      if (seen.has(element)) continue;
      seen.add(element);
      candidates.push(element);
      if (element.shadowRoot) collect(element.shadowRoot);
    }
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) collect(host.shadowRoot);
      if (!seen.has(host)) {
        const style = getComputedStyle(host);
        if (['auto', 'scroll'].includes(style.overflowY) || ['auto', 'scroll'].includes(style.overflowX)) {
          seen.add(host); candidates.push(host);
        }
      }
    }
  };
  collect(document);
  const rows = [];
  for (const element of candidates) {
    // Sites commonly hide their file input behind an Attach button. Upload
    // needs a ref to that input; it does not send pointer input to it.
    const uploadInput = element.tagName === 'INPUT'
      && String(element.type).toLowerCase() === 'file';
    if (!isVisible(element) && !uploadInput) continue;
    const path = structuralPath(element);
    if (!path.length) continue;
    const tag = element.tagName.toLowerCase();
    const role = normalize(element.getAttribute('role'), 40);
    const inputType = normalize(element.getAttribute('type') || element.type, 40).toLowerCase();
    const label = labelFor(element);
    const sensitive = sensitiveControl(element);
    const isFile = tag === 'input' && inputType === 'file';
    const fillable = !isFile && !element.readOnly && (
      tag === 'textarea'
      || element.isContentEditable
      || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(inputType))
    );
    let href = '';
    if (tag === 'a' && element.href) {
      try {
        const parsed = new URL(element.href, location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          parsed.username = ''; parsed.password = '';
          href = (${displayBrowserUrl.toString()})(parsed.toString());
        }
      } catch { /* omit malformed link */ }
    }
    const options = tag === 'select'
      ? Array.from(element.options || []).slice(0, 30).map((option) => normalize(option.label || option.text, 160))
      : [];
    rows.push({
      identity: identityFor(element),
      documentToken: identities.token,
      option_count: tag === 'select' ? element.options.length : 0,
      path,
      signature: { tag, type: inputType, role, label },
      tag,
      role,
      label,
      input_type: inputType,
      placeholder: normalize(element.getAttribute('placeholder'), 160),
      href,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      checked: (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio'))
        ? Boolean(element.checked)
        : null,
      sensitive,
      fillable,
      options,
    });
  }
  // A document that is not HTML *is* its payload. The code/pre strip further
  // down is aimed at a code block someone embedded in a page; applying it to a
  // whole JSON or text document made that entire class read as a blank page,
  // which a caller could not tell from a page that genuinely had nothing.
  // Form values are read separately through snapshot-scoped field references.
  //
  // Chromium renders JSON and text/plain into a single <pre>. XML gets a tree
  // viewer with no such element, so that reports the kind and no payload rather
  // than pretending; CSV and octet-stream are downloads and never arrive here.
  const contentType = String(document.contentType || '').toLowerCase();
  if (contentType && contentType.indexOf('html') < 0) {
    const holder = document.querySelector('pre');
    // Strip control characters but keep newlines and tabs: the shape of a
    // document is part of reading it.
    const payload = holder
      ? String(holder.textContent || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      : '';
    const from = Math.min(TEXT_FROM, payload.length);
    const chunk = payload.slice(from, from + MAX_TEXT);
    const chunkEnd = from + chunk.length;
    return {
      ok: true,
      title: normalize(document.title, 240),
      document_kind: 'non_html',
      content_type: normalize(contentType, 80),
      text: chunk,
      text_offset: from,
      text_total: payload.length,
      text_next_offset: chunkEnd < payload.length ? chunkEnd : null,
      text_truncated: chunkEnd < payload.length,
      elements: [],
      element_offset: 0,
      element_count: 0,
      element_next_offset: null,
      elements_truncated: false,
    };
  }
  // Read each visible text node once, including table cells, ordinary divs and
  // open shadow roots. Ancestor textContent duplicated nested rows and included
  // hidden descendants; a tag whitelist silently dropped most console data.
  // Keep form subtrees separate, and retain block/row and cell boundaries.
  const parts = [];
  const skippedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT',
    ]);
  const stack = document.body ? [{ node: document.body, hidden: false }] : [];
  const visited = new Set();
  while (stack.length) {
    const entry = stack.pop();
    if (entry.separator) { parts.push(entry.separator); continue; }
    const node = entry.node;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.nodeType === 3) {
      if (!entry.hidden) parts.push(String(node.nodeValue || '').replace(/[\u0000-\u0020\u007f]+/g, ' '));
      continue;
    }
    if (!(node instanceof Element)) continue;
    if (skippedTags.has(node.tagName) || node.isContentEditable) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.contentVisibility === 'hidden') continue;
    const hidden = style.visibility === 'hidden' || style.visibility === 'collapse';
    const role = node.getAttribute('role');
    const separator = (style.display === 'table-cell' || role === 'cell' || role === 'gridcell' || role === 'columnheader') ? '\t'
      : (node.tagName === 'BR' || ['block', 'flex', 'grid', 'list-item', 'table-row'].includes(style.display) || role === 'row') ? '\n' : '';
    if (separator) parts.push(separator);
    if (separator) stack.push({ separator });
    // A shadow host's rendered children replace its light DOM. Slots expose
    // assigned nodes, with the ordinary fallback when nothing is assigned.
    let children = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
    if (node.tagName === 'SLOT') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) children = assigned;
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], hidden });
  }
  const joined = parts.join('').replace(/ *\t */g, '\t').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const textFrom = Math.min(TEXT_FROM, joined.length);
  const text = joined.slice(textFrom, textFrom + MAX_TEXT);
  const textEnd = textFrom + text.length;
  const elementFrom = Math.min(ELEMENT_FROM, rows.length);
  const elements = rows.slice(elementFrom, elementFrom + MAX_ELEMENTS);
  const elementEnd = elementFrom + elements.length;
  return {
    ok: true,
    title: normalize(document.title, 240),
    text,
    text_offset: textFrom,
    text_total: joined.length,
    text_next_offset: textEnd < joined.length ? textEnd : null,
    elements,
    element_offset: elementFrom,
    element_count: rows.length,
    element_next_offset: elementEnd < rows.length ? elementEnd : null,
    elements_truncated: elementEnd < rows.length,
    text_truncated: textEnd < joined.length,
  };
})()
`;
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildWebAssistActionScript(input: {
  ref?: WebAssistStoredElementRef;
  action: WebAssistPageAction | 'read_value' | 'options';
  values?: string[];
  optionOffset?: number;
  text?: string;
  textOffset?: number;
  direction?: 'up' | 'down' | 'top' | 'bottom' | 'left' | 'right';
}, scope: WebAssistPageScope = 'browser', options: {
  /** Prepare a checked pointer target for the host's native input path. */
  preparePointer?: boolean;
} = {}): string {
  const payload = scriptJson(input);
  return String.raw`
(() => {
  const request = ${payload};

  const preparePointer = ${options.preparePointer === true};
  const normalize = (value, cap = 240) => String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
  const resolvePath = (path) => {
    let node = document;
    for (const segment of path) {
      if (segment === -1) {
        if (!node || !node.shadowRoot) return null;
        node = node.shadowRoot;
        continue;
      }
      if (!node || !node.children || !node.children[segment]) return null;
      node = node.children[segment];
    }
    return node instanceof Element ? node : null;
  };
  const labelFor = (element) => {
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText) : [];
    return normalize(
      element.getAttribute('aria-label')
      || labels.join(' ')
      || (element.tagName !== 'TEXTAREA' && !element.isContentEditable ? element.innerText : '')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.getAttribute('alt')
      || element.getAttribute('name')
      || element.tagName,
    );
  };
  const sensitiveControl = (element) => {
    const type = String(element.type || '').toLowerCase();
    const autocomplete = String(element.autocomplete || element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
    return type === 'password'
      || autocomplete.includes('current-password')
      || autocomplete.includes('new-password')
      || autocomplete.includes('one-time-code')
      || autocomplete.some((token) => token.startsWith('cc-'));
  };
  if (request.action === 'scroll' && !request.ref) {
    const distance = Math.max(240, Math.floor(window.innerHeight * 0.72));
    if (request.direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else if (request.direction === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    else window.scrollBy({ top: ['left', 'right'].includes(request.direction) ? 0 : request.direction === 'up' ? -distance : distance, left: request.direction === 'left' ? -distance : request.direction === 'right' ? distance : 0, behavior: 'instant' });
    return { ok: true, outcome: 'acted', action: request.action };
  }
  if (request.ref?.documentToken && request.ref.documentToken !== globalThis.__orkasBrowserNodes?.token) return { ok: false, code: 'stale_element', error: 'The page changed; observe it again.' };
  const element = request.ref.identity
    ? globalThis.__orkasBrowserNodes?.refs.get(request.ref.identity)?.deref()
    : resolvePath(request.ref.path);
  if (!element || element.isConnected === false) return { ok: false, code: 'stale_element', error: 'The page changed; observe it again.' };
  const current = {
    tag: element.tagName.toLowerCase(),
    type: normalize(element.getAttribute('type') || element.type, 40).toLowerCase(),
    role: normalize(element.getAttribute('role'), 40),
    label: labelFor(element),
  };
  const expected = request.ref.signature;
  if (current.tag !== expected.tag || current.type !== expected.type || current.role !== expected.role
      || (!request.ref.identity && expected.label && current.label !== expected.label)) {
    return { ok: false, code: 'stale_element', error: 'The page changed; observe it again.' };
  }
  const optionDisabled = option => option.disabled
    || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled);
  if (request.action === 'options') {
    if (current.tag !== 'select' || sensitiveControl(element)) return { ok: false, code: 'unsupported_element', error: 'This control does not expose selectable options.' };
    const start = Math.min(Number(request.optionOffset || 0), element.options.length);
    const options = Array.from(element.options).slice(start, start + 80).map((option, index) => ({ index: start + index, label: normalize(option.label || option.text, 160), value: option.value, selected: option.selected, disabled: optionDisabled(option) }));
    return { ok: true, options, multiple: element.multiple, option_count: element.options.length, option_next_offset: start + options.length < element.options.length ? start + options.length : null, untrusted_content: true };
  }
  if (request.action === 'read_value') {
    if (sensitiveControl(element) || (current.tag === 'input' && ['hidden', 'file'].includes(current.type))) {
      return { ok: false, code: 'value_not_readable', error: 'This field does not expose its value.' };
    }
    if (!['input', 'textarea', 'select'].includes(current.tag) && !element.isContentEditable) {
      return { ok: false, code: 'unsupported_element', error: 'This control has no form value.' };
    }
    const value = String(element.isContentEditable ? element.innerText : element.value);
    const offset = Number(request.textOffset || 0);
    if (offset > value.length) return { ok: false, code: 'invalid_offset', value_total: value.length, error: 'The offset is past the field value.' };
    const text = value.slice(offset, offset + 6000);
    const end = offset + text.length;
    return { ok: true, value: text, value_offset: offset, value_total: value.length,
      value_next_offset: end < value.length ? end : null, value_truncated: end < value.length,
      ...(current.tag === 'select' ? { selected_options: Array.from(element.selectedOptions || []).slice(0, 30).map(option => normalize(option.label || option.text, 160)) } : {}),
      untrusted_content: true };
  }
  if (request.action === 'scroll') {
    const distance = Math.max(240, Math.floor(element.clientHeight * 0.72));
    if (request.direction === 'top') element.scrollTo({ top: 0, behavior: 'instant' });
    else if (request.direction === 'bottom') element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
    else element.scrollBy({ top: ['left', 'right'].includes(request.direction) ? 0 : request.direction === 'up' ? -distance : distance, left: request.direction === 'left' ? -distance : request.direction === 'right' ? distance : 0, behavior: 'instant' });
    return { ok: true, outcome: 'acted', action: 'scroll' };
  }
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
    return { ok: false, code: 'element_disabled', error: 'This element is disabled.' };
  }
  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const pointerTarget = () => {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return { ok: false, code: 'element_not_visible', error: 'The control is not visible in the page.' };
    const x = (left + right) / 2, y = (top + bottom) / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit || (hit !== element && !element.contains(hit))) return { ok: false, code: 'element_obscured', error: 'Another element covers this control.' };
    return { ok: true, pointer: { x, y, width: window.innerWidth, height: window.innerHeight } };
  };
  if (['click', 'drag', 'hover', 'double_click', 'right_click'].includes(request.action)) {
    if (preparePointer) return pointerTarget();
    if (request.action === 'drag') return { ok: false, code: 'invalid_action', error: 'Drag requires native page input.' };
    element.focus();
    element.click();
    return { ok: true, outcome: 'acted', action: request.action };
  }
  if (request.action === 'press') { element.focus(); return { ok: true, outcome: 'focused' }; }
  if (request.action === 'upload') {
    if (current.tag !== 'input' || current.type !== 'file') return { ok: false, code: 'unsupported_element', error: 'This control is not a file input.' };
    return element;
  }
  if (request.action === 'fill') {
    const text = String(request.text == null ? '' : request.text);
    const inputFillable = current.tag === 'input'
      && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(current.type);
    if (!inputFillable && current.tag !== 'textarea' && !element.isContentEditable) {
      return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
    }
    if (element.readOnly) return { ok: false, code: 'element_readonly', error: 'This field is read-only.' };
    // Focus handlers can restore a controlled field from its component state.
    // Focus first, then recheck the target before changing any text.
    element.focus();
    const active = element.getRootNode().activeElement;
    if (active !== element || !element.isConnected
        || element.disabled || element.readOnly || String(element.type || '').toLowerCase() !== current.type) {
      return { ok: false, code: 'stale_element', error: 'The field changed while focusing; observe it again.' };
    }
    const textEntry = current.tag === 'textarea' || element.isContentEditable
      || (current.tag === 'input' && ['text', 'password', 'search', 'tel', 'url', 'email', 'number'].includes(current.type));
    if (current.tag === 'textarea' && text.length > 2000) {
      // Large multiline insertText commands repeatedly relayout textareas.
      // Use the native value setter and the input event consumed by controlled fields.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, text);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    } else if (textEntry) {
      if (element.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else element.select();
      // Chromium's editing command emits the native InputEvent understood by
      // controlled inputs and editors. It stays in this reviewed, synchronous
      // script so a focus change cannot redirect a later host insertText call.
      // A single multiline insertText repeatedly lays out each new paragraph.
      // Escaped plain text via insertHTML keeps Chromium's native editing events
      // and undo transaction while parsing all long-editor line breaks together.
      const longEditor = element.isContentEditable && text.length > 2000;
      const insertion = longEditor
        ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
        : text;
      const edited = document.execCommand(text ? (longEditor ? 'insertHTML' : 'insertText') : 'delete', false, insertion);
      if (!edited) return { ok: false, code: 'fill_rejected', error: 'The page did not accept the edit; observe it again.' };
    } else if (current.tag === 'textarea' || current.tag === 'input') {
      const proto = current.tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
      setter.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } else {
      return { ok: false, code: 'unsupported_element', error: 'This field cannot be filled.' };
    }
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return Promise.resolve().then(() => {
      const actual = element.isContentEditable ? element.innerText : element.value;
      if (!element.isConnected || actual !== text) {
        return { ok: false, code: 'fill_rejected', error: 'The page did not retain the requested text; observe it again.' };
      }
      return { ok: true, outcome: 'acted', action: request.action };
    });
  }
  if (request.action === 'select') {
    if (current.tag !== 'select') return { ok: false, code: 'unsupported_element', error: 'This is not a select field.' };
    const requested = Array.isArray(request.values) ? request.values : [String(request.text == null ? '' : request.text)];
    if (!requested.length || (!element.multiple && requested.length !== 1)) return { ok: false, code: 'invalid_selection', error: 'Choose one option unless this field allows multiple selections.' };
    const options = Array.from(element.options || []);
    const selected = [];
    for (const value of requested) {
      const exact = options.filter(option => option.value === value);
      const matches = exact.length ? exact : options.filter(option => normalize(option.label || option.text, 160) === value);
      if (matches.length !== 1) return { ok: false, code: 'option_not_unique', error: 'Use one exact option value from options.' };
      if (optionDisabled(matches[0])) return { ok: false, code: 'element_disabled', error: 'This option is disabled.' };
      selected.push(matches[0]);
    }
    for (const option of options) option.selected = selected.includes(option);
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return Promise.resolve().then(() => {
      const actual = Array.from(element.options || []).filter(option => option.selected);
      if (!element.isConnected || actual.length !== selected.length || selected.some(option => !actual.includes(option))) return { ok: false, code: 'selection_rejected', error: 'The page did not retain the requested selection.' };
      return { ok: true, outcome: 'acted', action: request.action };
    });
  }
  if (request.action === 'check' || request.action === 'uncheck') {
    if (current.tag !== 'input' || !['checkbox', 'radio'].includes(current.type)) {
      return { ok: false, code: 'unsupported_element', error: 'This is not a checkbox or radio control.' };
    }
    const desired = request.action === 'check';
    if (current.type === 'radio' && !desired) {
      return { ok: false, code: 'unsupported_element', error: 'A radio control cannot be unchecked directly.' };
    }
    if (Boolean(element.checked) !== desired) {
      if (preparePointer) return pointerTarget();
      element.click();
    }
    return { ok: true, outcome: 'acted', action: request.action };
  }
  return { ok: false, code: 'invalid_action', error: 'Unsupported page action.' };
})()
`;
}

export function buildWebAssistTextConditionScript(text: string): string {
  const expected = scriptJson(text);
  return String.raw`
(() => {
  const expected = String(${expected}).replace(/\s+/g, ' ').trim();
  const body = String(document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
  return expected.length > 0 && body.includes(expected);
})()
`;
}

export function sanitizeWebAssistObservation(
  raw: unknown,
  pageId: string,
  displayUrl: string,
): {
  publicSnapshot: Record<string, unknown>;
  refs: Map<string, WebAssistStoredElementRef>;
  /** Every link this observation actually showed. A later navigation to one of
   *  them followed the page; a destination absent from this set was composed by
   *  the caller, which is the shape an exfiltration attempt has to take. */
  hrefs: Set<string>;
} | null {
  if (!raw || typeof raw !== 'object' || (raw as { ok?: unknown }).ok !== true) return null;
  const source = raw as Partial<WebAssistRawObservation>;
  const rows = Array.isArray(source.elements) ? source.elements.slice(0, 80) : [];
  const elementOffset = Math.max(0, Math.floor(Number(source.element_offset)) || 0);
  const refs = new Map<string, WebAssistStoredElementRef>();
  const hrefs = new Set<string>();
  for (const row of rows) {
    const href = row && typeof row.href === 'string' ? row.href.trim() : '';
    if (href) hrefs.add(href);
  }
  const elements = rows.flatMap((row, index) => {
    if (!row || !Array.isArray(row.path) || !row.signature) return [];
    const ref = `e${elementOffset + index + 1}`;
    refs.set(ref, {
      ...(Number.isInteger(row.identity) ? { identity: row.identity, documentToken: row.documentToken } : {}),
      path: row.path.filter((part) => Number.isInteger(part)).slice(0, 80),
      signature: {
        tag: String(row.signature.tag || '').slice(0, 40),
        type: String(row.signature.type || '').slice(0, 40),
        role: String(row.signature.role || '').slice(0, 40),
        label: String(row.signature.label || '').slice(0, 240),
      },
    });
    // Only values that differ from the default are sent: an absent text field
    // is empty, an absent flag is false and an absent `checked` means the
    // element is not a checkbox or radio. Defaults were about half of an
    // observation's tokens and carried no information.
    const tag = String(row.tag || '').slice(0, 40);
    const element: Record<string, unknown> = { ref, tag };
    const setText = (key: string, value: unknown, cap?: number) => {
      const text = cap === undefined ? String(value || '') : String(value || '').slice(0, cap);
      if (text) element[key] = text;
    };
    setText('role', row.role, 40);
    setText('label', row.label, 240);
    setText('input_type', row.input_type, 40);
    setText('placeholder', row.placeholder, 160);
    setText('href', row.href);
    if (row.disabled === true) element.disabled = true;
    if (typeof row.checked === 'boolean') element.checked = row.checked;
    if (row.sensitive === true) element.sensitive = true;
    if (row.fillable === true) element.fillable = true;
    // A select reports its option count even when it is empty.
    if (tag === 'select' && Number.isInteger(row.option_count)) element.option_count = row.option_count;
    const options = Array.isArray(row.options)
      ? row.options.slice(0, 30).map((option) => String(option).slice(0, 160))
      : [];
    if (options.length) element.options = options;
    return [element];
  });
  return {
    publicSnapshot: {
      page_id: pageId,
      title: String(source.title || '').slice(0, 240),
      display_url: displayUrl,
      ...(source.document_kind === 'non_html'
        ? {
          document_kind: 'non_html',
          content_type: String(source.content_type || '').slice(0, 80),
        }
        : {}),
      text: String(source.text || '').slice(0, 6000),
      text_offset: Math.max(0, Math.floor(Number(source.text_offset)) || 0),
      text_total: Math.max(0, Math.floor(Number(source.text_total)) || 0),
      text_truncated: source.text_truncated === true,
      ...(Number.isFinite(Number(source.text_next_offset)) && source.text_next_offset !== null
        ? { text_next_offset: Math.max(0, Math.floor(Number(source.text_next_offset))) }
        : {}),
      elements,
      element_offset: elementOffset,
      element_count: Math.max(elements.length + elementOffset, Number(source.element_count) || 0),
      elements_truncated: source.elements_truncated === true,
      ...(Number.isFinite(Number(source.element_next_offset)) && source.element_next_offset !== null
        ? { element_next_offset: Math.max(0, Math.floor(Number(source.element_next_offset))) }
        : {}),
      untrusted_content: true,
    },
    refs,
    hrefs,
  };
}
