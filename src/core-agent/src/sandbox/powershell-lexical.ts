/** PowerShell lexical evidence, not a grammar validator or permission proof.
 * Mask data/comments while retaining offsets and executable $() regions. Both
 * compatibility preflight and the bounded legacy chain parser use this view;
 * permissions and execution continue to consume the original command.
 */
export interface PowerShellLexicalEvidence {
  surface: string;
  operators: Array<{ offset: number; operator: "&&" | "||" }>;
  simpleChainSyntax: boolean;
}

export const MAX_POWERSHELL_CHAIN_COMMANDS = 32;

const singleQuote = (ch: string) => "'\u2018\u2019\u201a\u201b".includes(ch);
const doubleQuote = (ch: string) => '"\u201c\u201d\u201e'.includes(ch);
type Context = { kind: "code"; depth: number } | { kind: "string" | "here"; single: boolean };

export function scanPowerShell(command: string): PowerShellLexicalEvidence {
  const surface = new Array<string>(command.length).fill(" ");
  const contexts: Context[] = [{ kind: "code", depth: 0 }];
  const operators: PowerShellLexicalEvidence["operators"] = [];
  const environmentVariable = /\$env:[a-z_][a-z0-9_]*/iy;
  let simpleChainSyntax = true;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const context = contexts[contexts.length - 1];
    if (ch === "\r" || ch === "\n") surface[i] = ch;
    if (/[\r\n\0\u0085\u2028\u2029]/.test(ch)) simpleChainSyntax = false;
    if (context.kind !== "code") {
      if (context.kind === "here" && (i === 0 || /[\r\n]/.test(command[i - 1]))
          && (context.single ? singleQuote(ch) : doubleQuote(ch)) && command[i + 1] === "@") {
        contexts.pop(); i++; continue;
      }
      if (ch === "`" && !context.single) {
        if (i + 1 === command.length || /[\r\n]/.test(command[i + 1])) simpleChainSyntax = false;
        i++; continue;
      }
      const delimiter = context.single ? singleQuote(ch) : doubleQuote(ch);
      if (context.kind === "string" && delimiter) {
        if (ch !== "'" && ch !== '"') simpleChainSyntax = false;
        const nextDelimiter = context.single ? singleQuote(command[i + 1] || " ") : doubleQuote(command[i + 1] || " ");
        if (nextDelimiter) i++;
        else contexts.pop();
        continue;
      }
      if (context.single || ch !== "$") continue;
      environmentVariable.lastIndex = i;
      if (!environmentVariable.test(command)) simpleChainSyntax = false;
      if (command[i + 1] === "(") {
        surface[i] = "$"; surface[++i] = "(";
        contexts.push({ kind: "code", depth: 1 });
      }
      continue;
    }

    const tokenStart = i === 0 || /[\s;|&({]/.test(command[i - 1]);
    if (tokenStart && command.startsWith("<#", i)) {
      simpleChainSyntax = false;
      const end = command.indexOf("#>", i + 2);
      if (end < 0) break;
      // Preserve line boundaries in skipped comments without exposing data.
      for (let j = i; j <= end; j++) if (command[j] === "\r" || command[j] === "\n") surface[j] = command[j];
      i = end + 1; continue;
    }
    if (ch === "#" && tokenStart) {
      simpleChainSyntax = false;
      while (i + 1 < command.length && !/[\r\n]/.test(command[i + 1])) i++;
      continue;
    }
    if (tokenStart && command.startsWith("--%", i) && (i + 3 === command.length || /\s/.test(command[i + 3]))) {
      simpleChainSyntax = false;
      i += 2;
      while (i + 1 < command.length && !/[\r\n|]/.test(command[i + 1])) i++;
      continue;
    }
    if (ch === "@" && (singleQuote(command[i + 1] || " ") || doubleQuote(command[i + 1] || " "))) {
      let end = i + 2;
      while (command[end] === " " || command[end] === "\t") end++;
      if (/[\r\n]/.test(command[end] || " ")) {
        simpleChainSyntax = false;
        contexts.push({ kind: "here", single: singleQuote(command[++i]) });
        continue;
      }
    }
    if (singleQuote(ch) || doubleQuote(ch)) {
      if (ch !== "'" && ch !== '"') simpleChainSyntax = false;
      contexts.push({ kind: "string", single: singleQuote(ch) });
      continue;
    }
    if (ch === "`") { simpleChainSyntax = false; i++; continue; }
    surface[i] = ch;
    if (ch === "$") {
      environmentVariable.lastIndex = i;
      if (!environmentVariable.test(command)) simpleChainSyntax = false;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      surface[i + 1] = ch;
      // Only 31 operators can be lowered; the 32nd is an overflow sentinel.
      if (operators.length < MAX_POWERSHELL_CHAIN_COMMANDS) operators.push({ offset: i, operator: ch === "&" ? "&&" : "||" });
      i++; continue;
    }
    if (";|<>(){}[]@".includes(ch)) simpleChainSyntax = false;
    if (context.depth > 0) {
      if (ch === "(") context.depth++;
      if (ch === ")" && --context.depth === 0) contexts.pop();
    }
  }
  return { surface: surface.join(""), operators, simpleChainSyntax: simpleChainSyntax && contexts.length === 1 };
}
