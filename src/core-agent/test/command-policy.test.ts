import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blockedCommand } from '../src/sandbox/command-policy.js';
import { SandboxExecutor } from '../src/sandbox/executor.js';

const check = (command: string) => (new SandboxExecutor({ workingDir: os.tmpdir(), shell: '/bin/sh' }) as any).checkBlockedCommand(command);

// Admission-only counterexamples never reach a shell, even if a guard regresses.
describe('command admission: literal POSIX data', () => {
  it.each([
    "printf '%s' 'rm -rf /' # document a command",
    "printf '%s' '# rm -rf /'",
    'printf "%s" "# rm -rf /"',
    "# rm -rf /\nprintf '%s' 'ready'",
    "printf '%s' 'rm -rf /' # `shutdown`\nprintf '%s' 'ready'",
    "printf '%s' 'rm -rf /' \\\n # write text",
    "cat > Dockerfile <<'EOF'\n# image cleanup\nRUN rm -rf /var/lib/apt/lists/*\nEOF",
    'cat <<"EOF" > Dockerfile\n# image cleanup\nRUN rm -rf /var/lib/apt/lists/*\nEOF',
    "cat > Dockerfile <<-'EOF'\n\t# image cleanup\n\tRUN rm -rf /var/lib/apt/lists/*\n\tEOF",
    "cat > a <<'A'\n# $(rm -rf /)\nA\ncat > b <<'B'\n# shutdown\nB",
    "mkdir -p out && cat > out/Dockerfile <<'EOF'; printf ready\n# rm -rf /\nEOF",
    "printf '%s' 'rm -rf /' \\#literal",
    "printf '%s' 'rm -rf /' # safe\ncat > Dockerfile <<E'OF'\n# $literal\nEOF",
    "cat > Dockerfile <<'EOF' # literal file\n# rm -rf /\nEOF\nprintf '%s' 'ready'",
  ])('allows literal data without changing the command: %s', command => {
    expect(check(command)).toBeNull();
  });

  it.each([
    'rm -rf / # actual removal',
    "trap 'shutdown' EXIT # deferred execution",
    "alias stop='shutdown'\nstop # alias execution",
    "printf -v 'x[$(shutdown)]' 0 # builtin reinterprets the operand",
    "printf '%s' '$value { rm -rf / } `example`'",
    '3>log shutdown # actual command',
    '12>log shutdown # actual command',
    '2>&1 shutdown # actual command',
    '# safe comment\nrm -rf /',
    'echo ready;# comment\nshutdown',
    'echo ready # comment\nshutdown',
    'echo "$(rm -rf /)" # executable expansion',
    'echo `shutdown` # executable expansion',
    "sh -c 'rm -rf /' # interpreter",
    "cat <<'EOF' | sh\n# script\nrm -rf /\nEOF",
    "sh <<'EOF'\n# script\nrm -rf /\nEOF",
    "cat > file <<EOF\n$(rm -rf /)\nEOF",
    "cat > file <<'EOF'\n# data\nEOF\nrm -rf /",
    "cat > file <<'EOF' # data\n# note\nEOF\nshut\\\ndown",
    "cat > /dev/sda <<'EOF'\n# data\nEOF",
    "cat > file <<'EOF'; shutdown\n# data\nEOF",
    "cat > file <<'EOF'\n# rm -rf /", // incomplete body remains conservative
    "printf '%s' 'rm -rf /' ${unknown}",
    "printf '%s' 'rm -rf /' # comment\nsh -c 'shutdown'",
    "cat > file <<'EOF'\n# rm -rf /\nEOF\nsh file # execute saved source",
  ])('retains denial for executable or unresolved input: %s', command => {
    expect(check(command)).not.toBeNull();
  });

  it.each(['cmd.exe', 'powershell.exe', 'pwsh', 'fish', 'custom-shell'])(
    'does not assume POSIX comments or literals for %s', shell => {
      const executor = new SandboxExecutor({ workingDir: os.tmpdir(), shell }) as any;
      expect(executor.checkBlockedCommand("printf '%s' 'rm -rf /' # text")).toBe('rm -rf /');
    },
  );

  it('keeps custom substring rules authoritative inside comments and file bodies', () => {
    const executor = new SandboxExecutor({ workingDir: os.tmpdir(), shell: '/bin/sh', blockedCommands: ['private-marker'] }) as any;
    expect(executor.checkBlockedCommand('echo ready # private-marker')).toBe('private-marker');
    expect(executor.checkBlockedCommand("cat > file <<'EOF'\nprivate-marker\nEOF")).toBe('private-marker');
    // Callers without an established shell retain the existing policy.
    expect(blockedCommand("echo 'rm -rf /' # text")).toBe('rm -rf /');
  });
});

describe.skipIf(process.platform === 'win32')('literal file writes: native POSIX execution', () => {
  it.each([false, true])('writes exact Dockerfile bytes with a comment (background=%s)', async background => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-command-literal-'));
    const text = '# image cleanup\nRUN rm -rf /var/lib/apt/lists/*\n';
    const command = `cat > Dockerfile <<'EOF'\n${text}EOF\n`;
    const executor = new SandboxExecutor({ workingDir: root, shell: '/bin/sh' });
    try {
      if (background) {
        const result = executor.executeBackground(command, path.join(root, 'command.log'));
        expect(result.error).toBeUndefined();
        expect(result.pid).toBeGreaterThan(0);
        await expect.poll(async () => {
          try { process.kill(result.pid!, 0); return false; } catch { return true; }
        }).toBe(true);
      } else {
        const result = await executor.execute(command);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
      }
      expect(await fs.readFile(path.join(root, 'Dockerfile'), 'utf8')).toBe(text);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
