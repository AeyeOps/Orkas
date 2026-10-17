/** Evaluator-only facts at the provider boundary. Values/refs remain transient;
 * reports contain booleans, closed schema enums and request ordinals only. */
import { toolInputDiagnostic } from '../../../src/core-agent/src/providers/tool-input-diagnostics';

type Tool = { name: string; inputSchema?: { properties?: Record<string, { enum?: unknown[] }> } };
type Call = { id: string; name: string; input: Record<string, unknown> };
const browserTool = (name: string) => name === 'inner_browser' || name === 'connector_setup';
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function browserArgumentContext(tools: readonly Tool[]) {
  const pages = new Map<string, Set<string>>();
  const definitions = new Map(tools.filter(tool => browserTool(tool.name)).map(tool => [tool.name, tool.inputSchema?.properties]));
  let pagesWithRefs = 0;
  let complete = true;
  return {
    addReceipt(name: string | undefined, receipt: any, failed: boolean) {
      if (!name || !browserTool(name) || failed || receipt?.ok !== true || !present(receipt.page_id)) return;
      // These are the existing host's observation bounds, not new actor quotas.
      if (receipt.page_id.length > 64 || (pages.size >= 128 && !pages.has(receipt.page_id))) { complete = false; return; }
      if (Array.isArray(receipt.elements) && receipt.elements.length > 80) complete = false;
      const refs = Array.isArray(receipt.elements) ? receipt.elements.slice(0, 80)
        .map((element: any) => element?.ref).filter((ref: unknown) => present(ref) && ref.length <= 16) : [];
      if (pages.get(receipt.page_id)?.size) pagesWithRefs--;
      const pageRefs = new Set<string>(refs);
      pages.set(receipt.page_id, pageRefs);
      if (pageRefs.size) pagesWithRefs++;
    },
    facts(call: Call) {
      const properties = definitions.get(call.name);
      const args = call.input ?? {};
      const diagnostic = toolInputDiagnostic(args);
      return {
        tool: call.name,
        providerInputObject: !!call.input && typeof call.input === 'object' && !Array.isArray(call.input),
        ...(properties?.operation?.enum?.includes(args.operation) ? { operation: args.operation } : {}),
        ...(properties?.page_action?.enum?.includes(args.page_action) ? { action: args.page_action } : {}),
        schemaHasPageId: !!properties?.page_id,
        schemaHasElementRef: !!properties?.element_ref,
        contextComplete: complete,
        contextHasPageId: pages.size > 0,
        contextHasElementRef: pagesWithRefs > 0,
        providerHasPageIdKey: Object.hasOwn(args, 'page_id'),
        providerHasElementRefKey: Object.hasOwn(args, 'element_ref'),
        providerHasPageId: present(args.page_id),
        providerHasElementRef: present(args.element_ref),
        providerHasPoint: Array.isArray(args.point),
        pageIdInContext: present(args.page_id) && pages.has(args.page_id),
        elementRefOnPageInContext: present(args.page_id) && present(args.element_ref)
          && pages.get(args.page_id)?.has(args.element_ref) === true,
        ...(diagnostic ? { inputDiagnostic: { ...diagnostic } } : {}),
      };
    },
  };
}

/** Correlate canonical provider proposals with the next request's history.
 * This does not claim to observe raw HTTP payloads or infer model intent. */
export class BrowserArgumentAudit {
  private records = new Map<string, ReturnType<ReturnType<typeof browserArgumentContext>['facts']>
    & { request: number; historyHasPageId?: boolean; historyHasElementRef?: boolean;
      historyHasPageIdKey?: boolean; historyHasElementRefKey?: boolean;
      runtimeSkipped?: boolean; runtimeHasPageIdKey?: boolean; runtimeHasElementRefKey?: boolean;
      runtimeHasPageId?: boolean; runtimeHasElementRef?: boolean;
      runtimeInputObject?: boolean;
      runtimePageIdMatchesProvider?: boolean; runtimeElementRefMatchesProvider?: boolean }>;
  // Only bounded opaque identifiers survive until the matching tool-start;
  // snapshot() never includes this transient correlation state.
  private proposedRefs = new Map<string, { pageId?: string; elementRef?: string }>();
  overflow = false;

  record(request: number, context: ReturnType<typeof browserArgumentContext>, call: Call) {
    if (!browserTool(call.name)) return;
    if (this.records.size >= 128 || this.records.has(call.id)) { this.overflow = true; return; }
    this.records.set(call.id, { request, ...context.facts(call) });
    const args = call.input ?? {};
    this.proposedRefs.set(call.id, {
      ...(typeof args.page_id === 'string' && args.page_id.length <= 64 ? { pageId: args.page_id } : {}),
      ...(typeof args.element_ref === 'string' && args.element_ref.length <= 16 ? { elementRef: args.element_ref } : {}),
    });
  }

  /** Existing runtime tool-start arguments, before the tool body/validation.
   * A skipped event never claims that the body ran; unobserved stays unknown. */
  runtime(call: Call, skipped: boolean) {
    const record = this.records.get(call.id);
    if (!record || record.runtimeSkipped !== undefined) return;
    if (record.tool !== call.name) { this.overflow = true; return; }
    const args = call.input ?? {};
    const expected = this.proposedRefs.get(call.id);
    record.runtimeSkipped = skipped;
    record.runtimeInputObject = !!call.input && typeof call.input === 'object' && !Array.isArray(call.input);
    record.runtimeHasPageIdKey = Object.hasOwn(args, 'page_id');
    record.runtimeHasElementRefKey = Object.hasOwn(args, 'element_ref');
    record.runtimeHasPageId = present(args.page_id);
    record.runtimeHasElementRef = present(args.element_ref);
    if (expected?.pageId !== undefined) record.runtimePageIdMatchesProvider = args.page_id === expected.pageId;
    if (expected?.elementRef !== undefined) record.runtimeElementRefMatchesProvider = args.element_ref === expected.elementRef;
    this.proposedRefs.delete(call.id);
  }

  history(call: Call) {
    const record = this.records.get(call.id);
    if (!record || record.historyHasPageId !== undefined) return;
    record.historyHasPageId = present(call.input?.page_id);
    record.historyHasElementRef = present(call.input?.element_ref);
    record.historyHasPageIdKey = Object.hasOwn(call.input ?? {}, 'page_id');
    record.historyHasElementRefKey = Object.hasOwn(call.input ?? {}, 'element_ref');
  }

  snapshot() { return [...this.records.values()].map(record => ({ ...record })); }
}
