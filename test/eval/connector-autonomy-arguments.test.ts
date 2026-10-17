import { describe, expect, it } from 'vitest';
import { BrowserArgumentAudit, browserArgumentContext } from '../e2e/fixtures/connector-autonomy-arguments';
import { ToolInputDiagnostics } from '../../src/core-agent/src/providers/tool-input-diagnostics';

const tools = [{ name: 'inner_browser', inputSchema: { properties: {
  page_id: {}, element_ref: {}, operation: { enum: ['observe', 'act', 'read_value'] },
  page_action: { enum: ['click', 'fill', 'scroll'] },
} } }];
const call = (input: Record<string, unknown>) => ({ id: 'call-private', name: 'inner_browser', input });
function context() {
  const value = browserArgumentContext(tools);
  value.addReceipt('inner_browser', { ok: true, page_id: 'page-private', elements: [{ ref: 'e1' }] }, false);
  return value;
}

describe('browser argument causal evidence', () => {
  it('preserves malformed whole-input evidence instead of crashing the audit', () => {
    for (const input of [null, undefined, [], {}]) {
      const audit = new BrowserArgumentAudit();
      const proposal = { ...call({}), input: input as any };
      audit.record(1, context(), proposal);
      audit.runtime(proposal, false);
      expect(audit.snapshot()[0]).toMatchObject({ providerInputObject: input !== null && input !== undefined && !Array.isArray(input),
        providerHasPageId: false, runtimeHasPageId: false });
    }
  });
  it('locates parameter changes at runtime tool-start independently of later history', () => {
    const audit = new BrowserArgumentAudit();
    const proposal = call({ operation: 'act', page_id: 'page-private', element_ref: 'e1' });
    audit.record(1, context(), proposal);
    expect(audit.snapshot()[0]).not.toHaveProperty('runtimeHasPageId');
    audit.runtime(call({ operation: 'act', element_ref: 'e2' }), false);
    audit.history(proposal);
    audit.runtime(proposal, false);
    expect(audit.snapshot()[0]).toMatchObject({ providerHasPageId: true, providerHasElementRef: true,
      runtimeSkipped: false, runtimeHasPageIdKey: false, runtimeHasPageId: false,
      runtimeHasElementRef: true, runtimePageIdMatchesProvider: false, runtimeElementRefMatchesProvider: false,
      historyHasPageId: true, historyHasElementRef: true });
  });

  it('distinguishes skipped, malformed and unmatched runtime evidence without reporting values', () => {
    const audit = new BrowserArgumentAudit();
    const proposal = call({ page_id: 'page-private', element_ref: 'e1' });
    audit.record(1, context(), proposal);
    audit.runtime(call({ page_id: ' ', element_ref: null }), true);
    expect(audit.snapshot()[0]).toMatchObject({ runtimeSkipped: true, runtimeHasPageIdKey: true,
      runtimeHasPageId: false, runtimeHasElementRefKey: true, runtimeHasElementRef: false });
    for (const value of ['page-private', 'e1', 'call-private']) expect(JSON.stringify(audit.snapshot())).not.toContain(value);
    const unmatched = new BrowserArgumentAudit();
    unmatched.runtime(proposal, false);
    expect(unmatched.snapshot()).toEqual([]);
    unmatched.record(1, context(), proposal);
    unmatched.runtime({ ...proposal, name: 'connector_setup' }, false);
    expect(unmatched.overflow).toBe(true);
  });

  it('distinguishes an omitted provider parameter from missing model-visible evidence', () => {
    const args = { operation: 'act', page_action: 'fill', element_ref: 'e1' };
    expect(context().facts(call(args))).toMatchObject({ contextHasPageId: true, contextHasElementRef: true,
      schemaHasPageId: true, providerHasPageId: false, providerHasElementRef: true });
    // A different Agent/request must not inherit another request's page context.
    expect(browserArgumentContext(tools).facts(call(args))).toMatchObject({ contextHasPageId: false, contextHasElementRef: false });
    expect(browserArgumentContext([]).facts(call(args))).toMatchObject({ schemaHasPageId: false, schemaHasElementRef: false });
  });

  it('detects downstream field loss and preserves the first history observation', () => {
    const audit = new BrowserArgumentAudit();
    const proposal = call({ operation: 'act', page_action: 'fill', page_id: 'page-private', element_ref: 'e1' });
    audit.record(3, context(), proposal);
    expect(audit.snapshot()[0]).not.toHaveProperty('historyHasPageId');
    audit.history(call({ operation: 'act', element_ref: 'e1' }));
    audit.history(proposal);
    expect(audit.snapshot()[0]).toMatchObject({ request: 3, providerHasPageId: true, providerHasElementRef: true,
      historyHasPageId: false, historyHasElementRef: true });
  });

  it('distinguishes an absent key from blank or malformed parameter values', () => {
    expect(context().facts(call({}))).toMatchObject({ providerHasPageIdKey: false, providerHasPageId: false });
    for (const page_id of [' ', null, 7]) {
      expect(context().facts(call({ page_id }))).toMatchObject({ providerHasPageIdKey: true, providerHasPageId: false });
    }
  });

  it('binds an element reference to its page instead of accepting a reference from another page', () => {
    const value = context();
    value.addReceipt('connector_setup', { ok: true, page_id: 'another-page', elements: [{ ref: 'e2' }] }, false);
    expect(value.facts(call({ page_id: 'page-private', element_ref: 'e1' }))).toMatchObject({ pageIdInContext: true, elementRefOnPageInContext: true });
    expect(value.facts(call({ page_id: 'page-private', element_ref: 'e2' }))).toMatchObject({ pageIdInContext: true, elementRefOnPageInContext: false });
    expect(value.facts(call({ page_id: 'unknown-page', element_ref: 'e1' }))).toMatchObject({ pageIdInContext: false, elementRefOnPageInContext: false });
  });

  it('distinguishes screenshot coordinates from element-based actions', () => {
    const value = browserArgumentContext(tools);
    value.addReceipt('inner_browser', { ok: true, page_id: 'pixels-page' }, false);
    expect(value.facts(call({ operation: 'act', page_action: 'click', page_id: 'pixels-page', point: [140, 100] })))
      .toMatchObject({ contextHasPageId: true, contextHasElementRef: false, providerHasPoint: true,
        providerHasElementRef: false, pageIdInContext: true });
  });

  it('does not use failed receipts, other tools or page text as page evidence', () => {
    const value = browserArgumentContext(tools);
    value.addReceipt('web_fetch', { ok: true, page_id: 'page-private', elements: [{ ref: 'e1' }] }, false);
    value.addReceipt('inner_browser', { ok: false, page_id: 'page-private' }, false);
    value.addReceipt('inner_browser', { ok: true, page_id: 'page-private' }, true);
    value.addReceipt('inner_browser', { ok: true, text: 'page_id=page-private element_ref=e1' }, false);
    expect(value.facts(call({}))).toMatchObject({ contextHasPageId: false, contextHasElementRef: false });
  });

  it('retains existing strict input diagnostics without claiming absent evidence is a match', () => {
    const args = { operation: 'act', page_id: 'page-private' };
    const diagnostics = new ToolInputDiagnostics(false);
    diagnostics.start(0); diagnostics.delta(0, JSON.stringify(args)); diagnostics.end(0, args);
    expect(context().facts(call(args))).toMatchObject({ inputDiagnostic: { stream_json: 'strict', parsed_input_matches: true } });
    expect(context().facts(call({ ...args }))).not.toHaveProperty('inputDiagnostic');
  });

  it('reports bounded or ambiguous evidence as incomplete instead of overwriting a proposal', () => {
    const audit = new BrowserArgumentAudit();
    for (let index = 0; index < 128; index++) audit.record(index + 1, context(), { ...call({}), id: `call-${index}` });
    audit.record(129, context(), call({}));
    expect(audit.overflow).toBe(true);
    expect(audit.snapshot()).toHaveLength(128);
    const duplicate = new BrowserArgumentAudit();
    duplicate.record(1, context(), call({})); duplicate.record(2, context(), call({ page_id: 'page-private' }));
    expect(duplicate.overflow).toBe(true);
    expect(duplicate.snapshot()[0]).toMatchObject({ request: 1, providerHasPageId: false });
    const value = context();
    value.addReceipt('inner_browser', { ok: true, page_id: 'too-many-controls', elements: Array.from({ length: 81 }, () => ({ ref: 'e1' })) }, false);
    expect(value.facts(call({}))).toMatchObject({ contextComplete: false });
  });

  it('does not retain private values or arbitrary model text in report facts', () => {
    const audit = new BrowserArgumentAudit();
    audit.record(1, context(), call({ operation: '/private/secret-operation', page_action: 'secret-action',
      page_id: 'page-private', element_ref: 'e1', text: 'secret-content', file_paths: ['/private/secret-file'] }));
    const report = JSON.stringify(audit.snapshot());
    for (const secret of ['call-private', 'page-private', 'e1', 'secret-content', 'secret-operation', 'secret-action', 'secret-file']) {
      expect(report).not.toContain(secret);
    }
    expect(audit.snapshot()[0]).not.toHaveProperty('operation');
    expect(audit.snapshot()[0]).not.toHaveProperty('action');
  });
});
