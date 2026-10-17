export const CONVERSATION_TURN_PAGE_SIZE = 15;
export const CONVERSATION_TURN_USER_PREVIEW_CHARS = 100;
export const CONVERSATION_TURN_ASSISTANT_PREVIEW_CHARS = 240;

export interface ConversationTurnIndexEntry {
  messageId: string;
  clientMessageId: string;
  messageIndex: number;
  userPreview: string;
  assistantPreview: string;
}

export interface ConversationTurnPageEntry extends ConversationTurnIndexEntry {
  turnNo: number;
}

export interface ConversationTurnPage {
  turns: ConversationTurnPageEntry[];
  total: number;
  nextCursor: number | null;
  pageSize: number;
}
