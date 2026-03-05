export type ConversationRole = 'user' | 'assistant';

export type ConversationMessage = {
  role: ConversationRole;
  content: string;
};

const MAX_EXCHANGES = 20;
const MAX_MESSAGES = MAX_EXCHANGES * 2;

const conversations = new Map<string, ConversationMessage[]>();

function trimHistory(history: ConversationMessage[]): ConversationMessage[] {
  if (history.length <= MAX_MESSAGES) return history;
  return history.slice(-MAX_MESSAGES);
}

function addMessage(threadId: string, message: ConversationMessage): void {
  const content = message.content.trim();
  if (!content) return;

  const history = conversations.get(threadId) ?? [];
  history.push({ role: message.role, content });
  conversations.set(threadId, trimHistory(history));
}

export function addUserMessage(threadId: string, content: string): void {
  addMessage(threadId, { role: 'user', content });
}

export function addAssistantMessage(threadId: string, content: string): void {
  addMessage(threadId, { role: 'assistant', content });
}

export function getConversationHistory(threadId: string): ConversationMessage[] {
  return [...(conversations.get(threadId) ?? [])];
}

export function buildPromptWithHistory(history: ConversationMessage[], prompt: string): string {
  if (history.length === 0) return prompt;

  const transcript = history
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n');

  return [
    'You are continuing an existing Discord thread conversation.',
    'Conversation history:',
    transcript,
    'Latest user message:',
    prompt,
  ].join('\n\n');
}
