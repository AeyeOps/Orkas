import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Task tool project scope', () => {

  it('keeps the retired result_ref Library-save instruction out of the task tool schemas', () => {
    // 175d9c432 retired `result_ref` and its "save project output with
    // library_save" clause from todo_tasks: completion needs task_id only, and the
    // clause encouraged unsolicited Library copies. Neither the native nor the CLI
    // schema may reintroduce the field or route task output through library_save.
    const retired = /result_ref|In a Project conversation[^\n]+library_save/;
    for (const file of ['src/core-agent/src/tools/project-tasks-tool.ts', 'bin/orkas-bridge.cjs']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).not.toMatch(retired);
    }
    expect('result_ref: z.string().optional()').toMatch(retired);
    expect('In a Project conversation, save produced project files with library_save').toMatch(retired);
  });
});
