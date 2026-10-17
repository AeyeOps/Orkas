import { randomUUID } from "node:crypto";
import { scanPowerShell, MAX_POWERSHELL_CHAIN_COMMANDS, type PowerShellLexicalEvidence } from "./powershell-lexical.js";

export type PowerShellChain =
  | { kind: "none" }
  | { kind: "unsupported" }
  | { kind: "chain"; commands: string[]; operators: Array<"&&" | "||"> };

const MAX_CHAIN_CHARS = 64 * 1024;
// Grammar keywords cannot be treated as ordinary command invocations.
const STATEMENT_KEYWORDS = new Set([
  "if", "elseif", "else", "switch", "foreach", "for", "while", "do",
  "until", "try", "catch", "finally", "trap", "function", "filter",
  "class", "enum", "param", "return", "break", "continue", "exit",
  "throw", "data", "using", "begin", "process", "end", "clean",
]);

/** Recognize only complete, single-line chains of simple PowerShell commands.
 * This is not a general shell translator. Preserve operand bytes and reject
 * expressions, pipelines, redirections and statements rather than guessing.
 */
export function parsePowerShellChain(command: string, evidence?: PowerShellLexicalEvidence): PowerShellChain {
  if (!command.includes("&&") && !command.includes("||")) return { kind: "none" };
  if (command.length > MAX_CHAIN_CHARS) return { kind: "unsupported" };
  const lexical = evidence ?? scanPowerShell(command);
  if (!lexical.operators.length) return { kind: "none" };
  if (!lexical.simpleChainSyntax || lexical.operators.length >= MAX_POWERSHELL_CHAIN_COMMANDS) return { kind: "unsupported" };
  const commands: string[] = [];
  const surfaces: string[] = [];
  const operators: Array<"&&" | "||"> = [];
  let start = 0;
  for (const entry of lexical.operators) {
    commands.push(command.slice(start, entry.offset).trim());
    surfaces.push(lexical.surface.slice(start, entry.offset).trim());
    operators.push(entry.operator);
    start = entry.offset + 2;
  }
  commands.push(command.slice(start).trim());
  surfaces.push(lexical.surface.slice(start).trim());
  if (commands.some((part, index) => {
    const first = part.split(/\s/, 1)[0].toLowerCase();
    const surface = surfaces[index];
    // Only a leading call operator is within the established simple grammar.
    return !part || STATEMENT_KEYWORDS.has(first)
      || /^["'$@]/.test(part) || first === "." || part === "&"
      || surface.slice(surface.startsWith("&") ? 1 : 0).includes("&");
  })) return { kind: "unsupported" };
  return { kind: "chain", commands, operators };
}

/** Lower a recognized chain inside the existing single PowerShell process.
 * Capture success immediately, retaining it when a branch is skipped. Clear
 * stale native status before each command so a successful cmdlet can recover
 * from a failed executable. Only the final selected command determines exit.
 */
export function compilePowerShellChain(chain: Extract<PowerShellChain, { kind: "chain" }>): string {
  const id = randomUUID().replace(/-/g, "");
  const succeeded = `$orkasChainSucceeded_${id}`;
  const exitCode = `$orkasChainExitCode_${id}`;
  const stage = (command: string) => [
    // NativeCommandProcessor writes the global automatic variable. A local
    // assignment here would shadow it inside the shell's existing & { } scope.
    "$global:LASTEXITCODE = 0",
    command,
    `${succeeded} = $?`,
    `${exitCode} = if (${succeeded}) { 0 } elseif ($global:LASTEXITCODE -ne 0) { $global:LASTEXITCODE } else { 1 }`,
  ].join("\n");
  const script = [stage(chain.commands[0])];
  for (let i = 1; i < chain.commands.length; i++) {
    const condition = chain.operators[i - 1] === "&&" ? succeeded : `-not ${succeeded}`;
    script.push(`if (${condition}) {\n${stage(chain.commands[i])}\n}`);
  }
  script.push(`exit ${exitCode}`);
  return script.join("\n");
}
