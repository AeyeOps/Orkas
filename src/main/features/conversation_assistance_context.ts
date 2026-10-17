/** Feature-owned guidance from explicit task entry metadata, rebuilt per Commander turn. */
import * as chats from './chats';
import * as projectTasks from './project_tasks';
import { createLogger } from '../logger';
import { prompts } from '../prompts/loader';
import { logErrorSummary } from '../util/log-redact';
import { formatConnectorSetupAssistance } from './connector_setup_context';
import { hasPendingConversationFiling } from './conversation_filing';

const log = createLogger('conversation-assistance');
const LISTED_OPEN_TODO_IDS = 3;

/** Open to-dos linked to this conversation, in the conversation's own to-do
 *  scope. Only their count and ids reach the model; content can run to
 *  thousands of characters, so it stays behind `todo_tasks` get. */
async function openTodosGuidance(userId: string, cid: string, projectId: string): Promise<string> {
  let tasks: projectTasks.ProjectTask[];
  try {
    tasks = await projectTasks.listTasks(userId, projectId);
  } catch (err) {
    log.warn('open to-dos unavailable for turn guidance', { error: logErrorSummary(err) });
    return '';
  }
  const open = tasks
    .filter((task) => task.origin_cid === cid && task.status !== 'done')
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (!open.length) return '';
  const listed = open.slice(0, LISTED_OPEN_TODO_IDS).map((task) => task.id);
  return prompts.load('conversation_open_todos', {
    count: String(open.length),
    ids: listed.join(', ') + (open.length > listed.length ? ', …' : ''),
  }).trim();
}

export async function resolveConversationAssistanceForTurn(userId: string, cid: string): Promise<{
  kind?: chats.ConversationAssistance['kind'];
  guidance: string;
}> {
  const conversation = await chats.getConversationMetadata(userId, cid);
  const assistance = conversation?.assistance;
  const entryGuidance = assistance?.kind === 'app_creation'
    ? prompts.load('app_creation_guidance').trim()
    : formatConnectorSetupAssistance(assistance);
  const followUp = conversation && !conversation.project_id
    && !hasPendingConversationFiling(userId, cid)
    ? prompts.load('followup_offer_guidance').trim()
    : '';
  const openTodos = conversation ? await openTodosGuidance(userId, cid, conversation.project_id || '') : '';
  return {
    kind: assistance?.kind,
    guidance: [entryGuidance, followUp, openTodos].filter(Boolean).join('\n\n'),
  };
}
