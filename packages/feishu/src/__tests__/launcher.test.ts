import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getFeishuSessionChat,
  launchFeishuSessionFromPrivateChat,
  resetFeishuSessionChatsForTests,
} from '../index.js';

function extractCardMarkdownContents(card: Record<string, unknown>): string[] {
  const body = (card as { body?: { elements?: Array<{ tag?: string; content?: string }> } }).body;
  const elements = body?.elements ?? [];
  return elements
    .filter(element => element.tag === 'markdown' && typeof element.content === 'string')
    .map(element => element.content ?? '')
    .filter(Boolean);
}

afterEach(() => {
  resetFeishuSessionChatsForTests();
});

describe('Feishu launcher', () => {
  it('creates a session chat, sends the shared chat card, and mirrors the original prompt', async () => {
    const client = {
      createSessionChat: vi.fn(async () => ({
        chatId: 'session-chat-1',
        name: 'Session · 重构 Feishu 面板交互',
      })),
      sendSharedChatMessage: vi.fn(async () => 'message-share-1'),
      sendMessage: vi.fn(async () => undefined),
      sendCard: vi.fn()
        .mockResolvedValueOnce('message-ref-1')
        .mockResolvedValueOnce('message-mirror-1'),
    };
    const persist = vi.fn(async () => undefined);

    await expect(launchFeishuSessionFromPrivateChat({
      client,
      sourceChatId: 'p2p-chat-1',
      sourceMessageId: 'message-1',
      creatorOpenId: 'ou_user_1',
      prompt: '  重构\n Feishu 面板交互  ',
      mode: 'code',
      persist,
    })).resolves.toEqual({
      sessionChatId: 'session-chat-1',
      prompt: '  重构\n Feishu 面板交互  ',
      mode: 'code',
      mirroredMessageId: 'message-mirror-1',
    });

    expect(client.createSessionChat).toHaveBeenCalledWith({
      name: 'Session · 重构 Feishu 面板交互',
      userOpenId: 'ou_user_1',
    });
    expect(client.sendSharedChatMessage).toHaveBeenCalledWith({
      receiveId: 'p2p-chat-1',
      chatId: 'session-chat-1',
    });
    expect(client.sendCard).toHaveBeenNthCalledWith(1, 'session-chat-1', expect.any(Object), 'chat_id');
    expect(client.sendCard).toHaveBeenNthCalledWith(2, 'session-chat-1', expect.any(Object), 'chat_id');
    expect(extractCardMarkdownContents(client.sendCard.mock.calls[0]![1])).toEqual([
      'Common commands:\n/interrupt - stop the current run',
    ]);
    expect(extractCardMarkdownContents(client.sendCard.mock.calls[1]![1])).toEqual([
      '重构\n Feishu 面板交互',
    ]);
    expect(getFeishuSessionChat('session-chat-1')).toEqual(expect.objectContaining({
      sourceP2pChatId: 'p2p-chat-1',
      sourceMessageId: 'message-1',
      sessionChatId: 'session-chat-1',
      creatorOpenId: 'ou_user_1',
      promptPreview: '重构 Feishu 面板交互',
    }));
    expect(persist).toHaveBeenCalledOnce();
  });
});
