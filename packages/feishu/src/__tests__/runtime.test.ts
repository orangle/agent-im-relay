import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  applySessionControlCommand: vi.fn(),
  evaluateConversationRunRequest: vi.fn(),
  runPlatformConversation: vi.fn(),
}));

vi.mock('@agent-im-relay/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-im-relay/core')>();
  return {
    ...actual,
    applySessionControlCommand: coreMocks.applySessionControlCommand,
    evaluateConversationRunRequest: coreMocks.evaluateConversationRunRequest,
    runPlatformConversation: coreMocks.runPlatformConversation,
  };
});

import { conversationMode } from '@agent-im-relay/core';
import { runFeishuConversation } from '../runtime.js';

describe('Feishu runtime', () => {
  beforeEach(() => {
    conversationMode.clear();
    coreMocks.applySessionControlCommand.mockReset();
    coreMocks.evaluateConversationRunRequest.mockReset();
    coreMocks.runPlatformConversation.mockReset();

    coreMocks.evaluateConversationRunRequest.mockReturnValue({
      kind: 'ready',
      conversationId: 'conv-1',
      backend: 'claude',
    });
    coreMocks.runPlatformConversation.mockResolvedValue(true);
  });

  it('publishes the session-control card before starting the platform run', async () => {
    const transport = {
      sendText: vi.fn(async () => undefined),
      sendCard: vi.fn(async () => undefined),
      uploadFile: vi.fn(async () => undefined),
    };

    const result = await runFeishuConversation({
      conversationId: 'conv-1',
      target: {
        chatId: 'chat-1',
        replyToMessageId: 'message-1',
      },
      prompt: 'ship it',
      mode: 'code',
      transport,
      defaultCwd: process.cwd(),
    });

    expect(result).toEqual({ kind: 'started' });
    expect(transport.sendText).toHaveBeenCalledWith({
      chatId: 'chat-1',
      replyToMessageId: 'message-1',
    }, 'Starting run…');
    expect(transport.sendCard.mock.invocationCallOrder[0]).toBeLessThan(
      coreMocks.runPlatformConversation.mock.invocationCallOrder[0]!,
    );
  });
});
