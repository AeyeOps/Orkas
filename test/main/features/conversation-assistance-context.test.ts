import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-assistance-context-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('conversation entry assistance', () => {
  it('retains app intent across restart and title edits, scoped to the owning account without persisting guidance', async () => {
    const chats = await import('../../../src/main/features/chats');
    const context = await import('../../../src/main/features/conversation_assistance_context');
    const conv = await chats.createConversation('u1', { title: 'Unit converter', assistance: {
      kind: 'app_creation', prompt: 'UNTRUSTED_INSTRUCTIONS',
    } as any });
    const cid = conv.conversation_id;
    expect(conv.assistance).toEqual({ kind: 'app_creation' });
    const first = (await context.resolveConversationAssistanceForTurn('u1', cid)).guidance;
    expect(first).toContain('call create_artifact');
    expect(first).not.toContain('UNTRUSTED_INSTRUCTIONS');
    expect(await context.resolveConversationAssistanceForTurn('u2', cid)).toEqual({ kind: undefined, guidance: '' });
    await chats.updateConversation('u1', cid, { title: 'Renamed app task' });
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/conversation_assistance_context');
    expect(await reloaded.resolveConversationAssistanceForTurn('u1', cid)).toEqual({ kind: 'app_creation', guidance: first });
    const chatRoot = path.join(root, 'u1', 'cloud', 'chats');
    expect(fs.readFileSync(path.join(chatRoot, `${cid}.jsonl`), 'utf8')).toBe('');
    const metadata = fs.readFileSync(path.join(chatRoot, cid, 'meta.json'), 'utf8');
    expect(metadata).not.toContain('UNTRUSTED_INSTRUCTIONS');
    expect(metadata).not.toContain('create_artifact');
    const reloadedChats = await import('../../../src/main/features/chats');
    // Recovery from a missing list index must retain the entry association too.
    fs.unlinkSync(path.join(chatRoot, '_index.json'));
    reloadedChats.invalidateConversationCaches('u1');
    await reloadedChats.repairConversationIndex('u1');
    expect(await reloaded.resolveConversationAssistanceForTurn('u1', cid)).toEqual({ kind: 'app_creation', guidance: first });
  });

  it('preserves connector guidance, adds follow-up only to existing projectless conversations', async () => {
    const chats = await import('../../../src/main/features/chats');
    const context = await import('../../../src/main/features/conversation_assistance_context');
    const setup = await import('../../../src/main/features/connector_setup_context');
    for (const assistance of [undefined, { kind: 'app-creation' }, ['app_creation']]) {
      const conv = await chats.createConversation('u1', { assistance: assistance as any });
      expect(conv.assistance).toBeUndefined();
      // An unknown entry association contributes nothing; the follow-up guidance
      // comes from the conversation having no project, not from entry metadata.
      const { guidance } = await context.resolveConversationAssistanceForTurn('u1', conv.conversation_id);
      expect(guidance).not.toContain('create_artifact');
      expect(guidance).not.toContain('## Connector setup assistance');
      expect(guidance).toBe(
        fs.readFileSync(path.join(__dirname, '../../../src/main/prompts/followup_offer_guidance.md'), 'utf8').trim(),
      );
    }
    const conv = await chats.createConversation('u1', {
      assistance: { kind: 'connector_setup', connector_id: 'feishu' },
    });
    const cid = conv.conversation_id;
    const original = await setup.formatConnectorSetupForTurn('u1', cid);
    expect(original).toContain('## Connector setup assistance');
    const withFollowUp = (await context.resolveConversationAssistanceForTurn('u1', cid)).guidance;
    expect(withFollowUp.startsWith(original)).toBe(true);
    expect(withFollowUp).toContain('## Keeping work going');
    await chats.updateConversation('u1', cid, { assistance: { kind: 'app_creation' } });
    expect(await setup.formatConnectorSetupForTurn('u1', cid)).toBe('');
    await chats.deleteConversation('u1', cid);
    expect((await context.resolveConversationAssistanceForTurn('u1', cid)).guidance).toBe('');
  });

  it('tells the Commander only the count and ids of open to-dos saved from this conversation', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projectTasks = await import('../../../src/main/features/project_tasks');
    const context = await import('../../../src/main/features/conversation_assistance_context');
    const conv = await chats.createConversation('u1', { title: 'launch prep' });
    const other = await chats.createConversation('u1', { title: 'elsewhere' });
    const cid = conv.conversation_id;
    // A long to-do must not grow the per-turn context.
    const body = `Draft the pricing page\n${'SECRET_DETAIL '.repeat(250)}`;
    const save = async (content: string, linkTo: string) => {
      const created = await projectTasks.createTask('u1', '', { content });
      if (!created.ok) throw new Error(created.error);
      await projectTasks.recordTaskExecution('u1', '', created.task.id, linkTo);
      return created.task.id;
    };
    const first = await save(body, cid);
    const done = await save('Ship it', cid);
    expect((await projectTasks.updateTask('u1', '', done, { status: 'done' })).ok).toBe(true);
    await save('Unrelated', other.conversation_id);

    const { guidance } = await context.resolveConversationAssistanceForTurn('u1', cid);
    expect(guidance).toContain('## Keeping work going');
    expect(guidance).toContain('## Open to-dos from this conversation');
    expect(guidance).toContain(`Host facts: 1 open to-do(s) were saved from this conversation: ${first}.`);
    expect(guidance).not.toContain(done);
    expect(guidance).not.toContain('Draft the pricing page');
    expect(guidance).not.toContain('SECRET_DETAIL');
    expect(guidance).not.toContain('Unrelated');
    expect(guidance).not.toMatch(/\$(count|ids)\b/);
    // The other conversation's turn sees only its own to-do.
    expect((await context.resolveConversationAssistanceForTurn('u1', other.conversation_id)).guidance)
      .toContain('Host facts: 1 open to-do(s)');

    // Beyond three, the count stays exact and the listing is marked as cut.
    for (const n of [1, 2, 3]) await save(`Next step ${n}`, cid);
    const many = (await context.resolveConversationAssistanceForTurn('u1', cid)).guidance;
    expect(many).toContain('Host facts: 4 open to-do(s)');
    expect(many.match(/t_[a-f0-9]{12}/g)).toHaveLength(3);
    expect(many).toContain(', ….');

    // Finishing them removes the block; the follow-up guidance is unchanged.
    for (const task of await projectTasks.listTasks('u1', '')) {
      if (task.origin_cid === cid && task.status !== 'done') {
        expect((await projectTasks.updateTask('u1', '', task.id, { status: 'done' })).ok).toBe(true);
      }
    }
    expect((await context.resolveConversationAssistanceForTurn('u1', cid)).guidance).toBe(
      fs.readFileSync(path.join(__dirname, '../../../src/main/prompts/followup_offer_guidance.md'), 'utf8').trim(),
    );
  });

  it('reads open to-dos from the project scope once the conversation is filed', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const projectTasks = await import('../../../src/main/features/project_tasks');
    const context = await import('../../../src/main/features/conversation_assistance_context');
    const pid = ((await projects.createProject('u1', 'Backlog')) as { project: any }).project.project_id;
    const conv = await chats.createConversation('u1', { title: 'run' });
    expect((await chats.moveConversationToProject('u1', conv.conversation_id, pid)).ok).toBe(true);
    const created = await projectTasks.createTask('u1', pid, { content: 'Write the migration' });
    if (!created.ok) throw new Error(created.error);
    // Project to-dos link on their first run, not at creation.
    expect((await context.resolveConversationAssistanceForTurn('u1', conv.conversation_id)).guidance).toBe('');
    await projectTasks.recordTaskExecution('u1', pid, created.task.id, conv.conversation_id);
    const { guidance } = await context.resolveConversationAssistanceForTurn('u1', conv.conversation_id);
    expect(guidance).not.toContain('## Keeping work going');
    expect(guidance).toContain(`saved from this conversation: ${created.task.id}.`);
    expect(guidance).not.toContain('Write the migration');
  });

  it('stops offering a project once the conversation has one or is on its way', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const context = await import('../../../src/main/features/conversation_assistance_context');
    const created = await projects.createProject('u1', 'Already a project');
    const pid = (created as { project: any }).project.project_id;

    const filed = await chats.createConversation('u1', { title: 'filed' });
    expect((await chats.moveConversationToProject('u1', filed.conversation_id, pid)).ok).toBe(true);
    // Filing is impossible from here, so repeating the offer would ask the model
    // to do something the host would refuse.
    expect((await context.resolveConversationAssistanceForTurn('u1', filed.conversation_id)).guidance)
      .not.toContain('## Keeping work going');

    const pending = await chats.createConversation('u1', { title: 'pending' });
    expect((await context.resolveConversationAssistanceForTurn('u1', pending.conversation_id)).guidance)
      .toContain('## Keeping work going');
    const queued = await filing.fileConversationUnderNewProject(
      'u1', pending.conversation_id, 'On its way', { moveNow: false },
    );
    expect(queued.ok).toBe(true);
    // The relocation is recorded for the end of this turn; offering again in the
    // same turn would produce a second project.
    expect((await context.resolveConversationAssistanceForTurn('u1', pending.conversation_id)).guidance)
      .not.toContain('## Keeping work going');
  });
});
