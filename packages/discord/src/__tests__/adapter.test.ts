import { describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '../adapter.js';

function makeMockClient() {
  const sentMessages = new Map<string, { content: string; edit: ReturnType<typeof vi.fn> }>();
  let msgCounter = 0;

  const mockChannel = {
    isTextBased: () => true,
    send: vi.fn(async (payload: any) => {
      msgCounter++;
      const id = `msg-${msgCounter}`;
      const content = typeof payload === 'string' ? payload : payload.content;
      const msg = { id, content, edit: vi.fn() };
      sentMessages.set(id, msg);
      return msg;
    }),
    messages: {
      fetch: vi.fn(async (id: string) => sentMessages.get(id) ?? null),
    },
  };

  const client = {
    user: { id: 'bot-user-id' },
    channels: {
      fetch: vi.fn(async () => mockChannel),
    },
  } as any;

  return { client, mockChannel, sentMessages };
}

describe('createDiscordAdapter', () => {
  it('returns an adapter with all capabilities', () => {
    const { client } = makeMockClient();
    const adapter = createDiscordAdapter(client);

    expect(adapter.name).toBe('discord');
    expect(adapter.messageSender).toBeDefined();
    expect(adapter.conversationManager).toBeDefined();
    expect(adapter.statusIndicator).toBeDefined();
    expect(adapter.markdownFormatter).toBeDefined();
  });
});

describe('messageSender', () => {
  it('sends a message and returns its ID', async () => {
    const { client, mockChannel } = makeMockClient();
    const adapter = createDiscordAdapter(client);

    const msgId = await adapter.messageSender.send('channel-1', 'Hello');
    expect(msgId).toBe('msg-1');
    expect(mockChannel.send).toHaveBeenCalledWith('Hello');
  });

  it('sends with embeds when extras provided', async () => {
    const { client, mockChannel } = makeMockClient();
    const adapter = createDiscordAdapter(client);

    const embeds = [{ fields: [{ name: 'A', value: 'B', inline: true }] }];
    await adapter.messageSender.send('channel-1', 'Hi', embeds);
    expect(mockChannel.send).toHaveBeenCalledWith({ content: 'Hi', embeds });
  });

  it('edits a previously sent message', async () => {
    const { client, sentMessages } = makeMockClient();
    const adapter = createDiscordAdapter(client);

    const msgId = await adapter.messageSender.send('channel-1', 'Original');
    await adapter.messageSender.edit('channel-1', msgId, 'Updated');

    const msg = sentMessages.get(msgId);
    expect(msg?.edit).toHaveBeenCalledWith({ content: 'Updated' });
  });

  it('exposes maxMessageLength from config', () => {
    const { client } = makeMockClient();
    const adapter = createDiscordAdapter(client);

    expect(adapter.messageSender.maxMessageLength).toBeGreaterThanOrEqual(200);
  });
});

describe('markdownFormatter', () => {
  it('converts markdown tables to embeds', () => {
    const { client } = makeMockClient();
    const adapter = createDiscordAdapter(client);

    const result = adapter.markdownFormatter!.format(
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
    );

    expect(result.text).toBe('');
    expect(result.extras).toBeDefined();
    expect((result.extras as any[]).length).toBe(1);
  });

  it('returns plain text with no extras for simple markdown', () => {
    const { client } = makeMockClient();
    const adapter = createDiscordAdapter(client);

    const result = adapter.markdownFormatter!.format('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.extras).toBeUndefined();
  });
});
