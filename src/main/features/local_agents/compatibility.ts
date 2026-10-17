/** Optional features stay separate from the mandatory protocol floors in version.ts.
 * Help is authoritative for argv capabilities (including vendor backports). Native
 * Codex catalog boundaries come from https://learn.chatgpt.com/docs/changelog.
 * Account/provider eligibility remains a separate runtime check, never a version guess.
 */
import { cliVersionAtLeast } from './version.js';
import type { LocalCliType } from './registry.js';

export const CLI_TASK_HELP_ARGS: Partial<Record<LocalCliType, readonly string[]>> = {
  claude: ['--help'], opencode: ['run', '--help'], openclaw: ['agent', '--help'],
};
export const CODEX_NATIVE_MODEL_MINIMUMS: Readonly<Record<string, string>> = {
  'gpt-6-sol': '0.156.1', 'gpt-6-luna': '0.156.1', 'gpt-6.1-sol': '0.159.1',
};
export function codexNativeModelMinimum(model: unknown, version: string | undefined): string | null {
  if (typeof model !== 'string' || !version || !Object.hasOwn(CODEX_NATIVE_MODEL_MINIMUMS, model)) return null;
  const minimum = CODEX_NATIVE_MODEL_MINIMUMS[model];
  return minimum && !cliVersionAtLeast(version, minimum) ? minimum : null;
}
export function cliSupportsFlag(flags: readonly string[] | undefined, flag: string): boolean {
  return !!flags?.includes(flag);
}
/** Optional reasoning controls use the CLI's native default when its command
 * does not expose that control. Explicit model selection has different semantics
 * and must be preserved or resolved through a supported model-selection API. */
export function adaptCliRuntimeOverrides(cli: LocalCliType, options: {
  modelOverride?: string; thinkingLevel?: string; cliFlags?: readonly string[];
}): { modelOverride?: string; thinkingLevel?: string } {
  const effort = cli === 'claude' ? '--effort' : cli === 'opencode' ? '--variant' : '--thinking';
  return { modelOverride: options.modelOverride,
    thinkingLevel: CLI_TASK_HELP_ARGS[cli] && !cliSupportsFlag(options.cliFlags, effort)
      ? undefined : options.thinkingLevel };
}
export function unsupportedCliOverride(cli: LocalCliType, options: {
  modelOverride?: string; thinkingLevel?: string; cliFlags?: readonly string[];
}): string | null {
  if (!CLI_TASK_HELP_ARGS[cli]) return null;
  if (options.modelOverride && !cliSupportsFlag(options.cliFlags, '--model')) return '--model';
  return null;
}

/** Called only after native ChatGPT account/provider discovery. API and custom
 * providers own their model identifiers independently of the bundled catalog. */
export function compatibleCodexModels(rows: any[], version?: string): any[] {
  return rows.filter(row => typeof (row?.model || row?.id) === 'string'
    && !codexNativeModelMinimum(row.model || row.id, version));
}
export function compatibleCodexDefault(rows: any[], version?: string): any | undefined {
  const available = compatibleCodexModels(rows, version);
  return available.find(row => row.isDefault === true) || available[0];
}
