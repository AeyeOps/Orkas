import { describe, expect, it } from 'vitest';
import { connectorCompletionAccepted, connectorHandbackAccepted, connectorSilentHandbackAccepted, isSavedBrowserReadback,
  type ConnectorCompletionEvidence } from '../e2e/fixtures/connector-autonomy-evidence';

const evidence: ConnectorCompletionEvidence = { terminal: 'completed', overflow: false, savedObserved: true,
  receipts: [{ name: 'inner_browser', operation: 'act', action: 'click', ok: true, failed: false }] };
const saved = [{ callback: 'https://merchant.example/callback', trusted: true }];
const handback = { humanControlled: true, verifications: saved, applicationLoads: 1, sameTab: true };

describe('merchant application completion evidence', () => {
  it('rejects a synthetic acknowledgement in silent handback completion', () => {
    expect(connectorSilentHandbackAccepted({ ...evidence, userMessages: 1 }, saved, handback)).toBe(true);
    for (const userMessages of [undefined, 0, 2])
      expect(connectorSilentHandbackAccepted({ ...evidence, userMessages }, saved, handback)).toBe(false);
    expect(connectorSilentHandbackAccepted({ ...evidence, userMessages: 1 }, [], handback)).toBe(false);
  });
  it('requires a trusted human handback and continuation of the existing draft', () => {
    expect(connectorHandbackAccepted(evidence, saved, handback)).toBe(true);
    for (const change of [
      { humanControlled: false }, { sameTab: false }, { applicationLoads: 2 }, { verifications: [] },
      { verifications: [...saved, ...saved] }, { verifications: [{ ...saved[0], trusted: false }] },
      { verifications: [{ ...saved[0], callback: 'https://wrong.example/callback' }] },
    ]) expect(connectorHandbackAccepted(evidence, saved, { ...handback, ...change })).toBe(false);
    expect(connectorHandbackAccepted(evidence, [], handback)).toBe(false);
    expect(connectorHandbackAccepted({ ...evidence, savedObserved: false }, saved, handback)).toBe(false);
  });
  it('accepts a trusted browser save and readback without prescribing a Console route', () => {
    expect(connectorCompletionAccepted(evidence, saved)).toBe(true);
    // The diagnostic probe reached the form through permitted native navigation
    // and recovered from a wait timeout before observing the saved result.
    expect(connectorCompletionAccepted({ ...evidence, receipts: [
      { name: 'inner_browser', operation: 'wait', ok: false, failed: true }, ...evidence.receipts!,
    ] }, saved)).toBe(true);
  });
  it('rejects prose, early human handoff, direct fetch, wrong data and duplicate submission', () => {
    expect(connectorCompletionAccepted(evidence, [])).toBe(false);
    expect(connectorCompletionAccepted(evidence, [{ ...saved[0], trusted: false }])).toBe(false);
    expect(connectorCompletionAccepted(evidence, [{ ...saved[0], callback: 'https://wrong.example/callback' }])).toBe(false);
    expect(connectorCompletionAccepted(evidence, [...saved, ...saved])).toBe(false);
  });
  it.each([
    { terminal: 'failed' }, { terminal: undefined }, { overflow: true }, { overflow: undefined },
    { savedObserved: false }, { receipts: [] },
    { receipts: [{ name: 'web_fetch', operation: 'act', action: 'click', ok: true, failed: false }] },
    { receipts: [{ name: 'inner_browser', operation: 'act', action: 'click', ok: false, failed: true }] },
  ])('rejects incomplete or non-browser evidence: %j', change => {
    expect(connectorCompletionAccepted({ ...evidence, ...change }, saved)).toBe(false);
  });
  it('binds readback to a successful browser observation rather than another tool or echoed output', () => {
    const result = { ok: true, text: 'Merchant application\nApplication saved' };
    expect(isSavedBrowserReadback({ name: 'inner_browser', operation: 'observe' }, result, false)).toBe(true);
    expect(isSavedBrowserReadback({ name: 'web_fetch', operation: 'observe' }, result, false)).toBe(false);
    expect(isSavedBrowserReadback(undefined, result, false)).toBe(false);
    expect(isSavedBrowserReadback({ name: 'inner_browser', operation: 'read_value' }, result, false)).toBe(false);
    expect(isSavedBrowserReadback({ name: 'inner_browser', operation: 'observe' }, result, true)).toBe(false);
    expect(isSavedBrowserReadback({ name: 'inner_browser', operation: 'observe' }, { ...result, ok: false }, false)).toBe(false);
    expect(isSavedBrowserReadback({ name: 'inner_browser', operation: 'observe' }, { ok: true, text: 'Not saved' }, false)).toBe(false);
  });
  it('accepts connector-controlled browser submission with the same independent provider receipt', () => {
    const connectorEvidence = { ...evidence, receipts: [
      { name: 'connector_setup', operation: 'page_act', action: 'click', ok: true, failed: false },
    ] };
    expect(connectorCompletionAccepted(connectorEvidence, saved)).toBe(true);
    expect(connectorCompletionAccepted(connectorEvidence, [])).toBe(false);
    expect(connectorCompletionAccepted(connectorEvidence, [...saved, ...saved])).toBe(false);
    expect(connectorCompletionAccepted(connectorEvidence, [{ ...saved[0], trusted: false }])).toBe(false);
    expect(connectorCompletionAccepted({ ...connectorEvidence, savedObserved: false }, saved)).toBe(false);
    expect(connectorCompletionAccepted({ ...connectorEvidence, receipts: [
      { ...connectorEvidence.receipts[0], ok: false, failed: true },
    ] }, saved)).toBe(false);
  });
  it('accepts successful connector browser observation', () => {
    const call = { name: 'connector_setup', operation: 'page_observe' };
    const result = { ok: true, text: 'Merchant application\nApplication saved' };
    expect(isSavedBrowserReadback(call, result, false)).toBe(true);
    expect(isSavedBrowserReadback(call, result, true)).toBe(false);
    expect(isSavedBrowserReadback(call, { ...result, ok: false }, false)).toBe(false);
    expect(isSavedBrowserReadback(call, { ok: true }, false)).toBe(false);
  });
  it('rejects operations from another tool namespace and connector status prose', () => {
    for (const call of [
      { name: 'inner_browser', operation: 'page_observe' },
      { name: 'connector_setup', operation: 'observe' },
      { name: 'connector_setup', operation: 'status' },
      // Actions and waits return control receipts, not observed page text.
      { name: 'inner_browser', operation: 'act' },
      { name: 'inner_browser', operation: 'wait' },
      { name: 'connector_setup', operation: 'page_act' },
      { name: 'connector_setup', operation: 'page_wait' },
    ]) expect(isSavedBrowserReadback(call, { ok: true, text: 'Application saved' }, false)).toBe(false);
    for (const call of [
      { name: 'inner_browser', operation: 'page_act' },
      { name: 'connector_setup', operation: 'act' },
      { name: 'connector_setup', operation: 'status' },
    ]) expect(connectorCompletionAccepted({ ...evidence, receipts: [
      { ...call, action: 'click', ok: true, failed: false },
    ] }, saved)).toBe(false);
  });
});
