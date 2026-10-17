/** Evaluator-owned completion facts. Console navigation is one valid route,
 * not a user requirement; only the saved application is the deliverable. */
export interface BrowserReceipt {
  name?: string;
  operation?: string;
  action?: string;
  ok?: boolean;
  failed: boolean;
}

export interface ConnectorCompletionEvidence {
  terminal?: string;
  overflow?: boolean;
  savedObserved?: boolean;
  receipts?: readonly BrowserReceipt[];
}

export interface ApplicationSave { callback: string; trusted: boolean }

export function isSavedBrowserReadback(
  call: Pick<BrowserReceipt, 'name' | 'operation'> | undefined,
  result: { ok?: unknown; text?: unknown },
  failed: boolean,
): boolean {
  const observed = (call?.name === 'inner_browser' && call.operation === 'observe')
    || (call?.name === 'connector_setup' && call.operation === 'page_observe');
  return observed
    && !failed && result.ok === true && typeof result.text === 'string'
    && result.text.includes('Application saved');
}

export function connectorCompletionAccepted(
  evidence: ConnectorCompletionEvidence | undefined,
  saved: readonly ApplicationSave[],
): boolean {
  return evidence?.terminal === 'completed' && evidence.overflow === false
    && evidence.savedObserved === true && saved.length === 1
    && saved[0].callback === 'https://merchant.example/callback' && saved[0].trusted === true
    && evidence.receipts?.some(receipt => ((receipt.name === 'inner_browser' && receipt.operation === 'act')
      || (receipt.name === 'connector_setup' && receipt.operation === 'page_act')) && receipt.action === 'click'
      && receipt.ok === true && !receipt.failed) === true;
}

/** A real human verified the existing draft; the assistant must continue in
 * that same document. Reopening a fresh form can pass the save gate alone. */
export function connectorHandbackAccepted(
  evidence: ConnectorCompletionEvidence | undefined,
  saved: readonly ApplicationSave[],
  facts: { humanControlled: boolean; verifications: readonly ApplicationSave[];
    applicationLoads: number; sameTab: boolean },
): boolean {
  return facts.humanControlled && facts.sameTab && facts.applicationLoads === 1
    && facts.verifications.length === 1 && facts.verifications[0].trusted
    && facts.verifications[0].callback === 'https://merchant.example/callback'
    && connectorCompletionAccepted(evidence, saved);
}

export function connectorSilentHandbackAccepted(
  evidence: (ConnectorCompletionEvidence & { userMessages?: number }) | undefined,
  saved: readonly ApplicationSave[],
  facts: Parameters<typeof connectorHandbackAccepted>[2],
): boolean {
  return evidence?.userMessages === 1 && connectorHandbackAccepted(evidence, saved, facts);
}
