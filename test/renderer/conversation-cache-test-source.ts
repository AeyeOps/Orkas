import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Narrow renderer fixtures load the actual cache boundary without importing
// conversation.js's unrelated DOM/IPC initialization or reimplementing merges.
const source = readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const parsed = ts.createSourceFile('conversation.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['_replaceConversationSlice', '_appendConversationSlice', '_cacheCreatedConversation']);
export const conversationCacheSource = parsed.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.has(node.name?.text || '')).map(node => node.getText(parsed)).join('\n');
export const conversationRemovalSource = parsed.statements.filter(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === '_removeConversationFromSidebar').map(node => node.getText(parsed)).join('\n');
