import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  initState: vi.fn(async () => undefined),
  persistState: vi.fn(async () => undefined),
}));

const runtimeMocks = vi.hoisted(() => ({
  runFeishuConversation: vi.fn(),
  handleFeishuControlAction: vi.fn(),
}));

vi.mock('@agent-im-relay/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-im-relay/core')>();
  return {
    ...actual,
    initState: coreMocks.initState,
    persistState: coreMocks.persistState,
  };
});

vi.mock('../runtime.js', () => ({
  runFeishuConversation: runtimeMocks.runFeishuConversation,
  handleFeishuControlAction: runtimeMocks.handleFeishuControlAction,
}));

describe('managed relay client', () => {
  beforeEach(() => {
    vi.resetModules();
    coreMocks.initState.mockReset();
    coreMocks.persistState.mockReset();
    runtimeMocks.runFeishuConversation.mockReset();
    runtimeMocks.handleFeishuControlAction.mockReset();

    runtimeMocks.runFeishuConversation.mockImplementation(async (options: {
      target: { chatId: string };
      transport: {
        sendText(target: { chatId: string }, text: string): Promise<void>;
        uploadFile(target: { chatId: string }, filePath: string): Promise<void>;
      };
    }) => {
      await options.transport.sendText(options.target, 'stream text');
      await options.transport.uploadFile(options.target, '/tmp/result.txt');
      return { kind: 'started' };
    });
    runtimeMocks.handleFeishuControlAction.mockImplementation(async () => ({ kind: 'applied' }));
  });

  it('builds hello and heartbeat payloads from managed client config', async () => {
    const {
      buildManagedClientHeartbeatEvent,
      buildManagedClientHelloEvent,
    } = await import('../client.js');

    const config = {
      agentTimeoutMs: 1_000,
      claudeCwd: process.cwd(),
      stateFile: '/tmp/feishu-state.json',
      artifactsBaseDir: '/tmp/feishu-artifacts',
      artifactRetentionDays: 14,
      artifactMaxSizeBytes: 8 * 1024 * 1024,
      claudeBin: '/opt/homebrew/bin/claude',
      codexBin: '/opt/homebrew/bin/codex',
      feishuGatewayUrl: 'https://gateway.example',
      feishuClientId: 'client-a',
      feishuClientToken: 'token-a',
      feishuClientPollIntervalMs: 500,
    };

    expect(buildManagedClientHelloEvent(config as any, () => '2026-03-07T00:00:00.000Z')).toEqual({
      type: 'client.hello',
      clientId: 'client-a',
      requestId: 'client-a:hello',
      timestamp: '2026-03-07T00:00:00.000Z',
      payload: {
        token: 'token-a',
      },
    });
    expect(buildManagedClientHeartbeatEvent(config as any, () => '2026-03-07T00:00:01.000Z')).toEqual({
      type: 'client.heartbeat',
      clientId: 'client-a',
      requestId: 'client-a:heartbeat',
      timestamp: '2026-03-07T00:00:01.000Z',
      payload: {
        token: 'token-a',
      },
    });
  });

  it('executes a conversation.run command locally and emits text, file, and done events', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
    });
    const readFileImpl = vi.fn(async () => Buffer.from('artifact-data'));

    const { createManagedFeishuRelayClient } = await import('../client.js');
    const client = createManagedFeishuRelayClient({
      agentTimeoutMs: 1_000,
      claudeCwd: process.cwd(),
      stateFile: '/tmp/feishu-state.json',
      artifactsBaseDir: '/tmp/feishu-artifacts',
      artifactRetentionDays: 14,
      artifactMaxSizeBytes: 8 * 1024 * 1024,
      claudeBin: '/opt/homebrew/bin/claude',
      codexBin: '/opt/homebrew/bin/codex',
      feishuGatewayUrl: 'https://gateway.example',
      feishuClientId: 'client-a',
      feishuClientToken: 'token-a',
      feishuClientPollIntervalMs: 500,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => '2026-03-07T00:00:00.000Z',
      readFileImpl: readFileImpl as any,
    });

    await client.handleCommand({
      type: 'conversation.run',
      clientId: 'client-a',
      requestId: 'request-1',
      conversationId: 'conv-1',
      timestamp: '2026-03-07T00:00:00.000Z',
      payload: {
        target: {
          chatId: 'chat-1',
        },
        prompt: 'hello',
        mode: 'code',
      },
    });

    expect(readFileImpl).toHaveBeenCalledWith('/tmp/result.txt');
    expect(requests.map(request => request.url)).toEqual([
      'https://gateway.example/feishu/bridge/events',
      'https://gateway.example/feishu/bridge/events',
      'https://gateway.example/feishu/bridge/events',
    ]);
    expect(requests[0]?.body.event).toEqual(expect.objectContaining({
      type: 'conversation.text',
      requestId: 'request-1',
      payload: {
        text: 'stream text',
      },
    }));
    expect(requests[1]?.body.event).toEqual(expect.objectContaining({
      type: 'conversation.file',
      payload: {
        fileName: 'result.txt',
        data: Buffer.from('artifact-data').toString('base64'),
      },
    }));
    expect(requests[2]?.body.event).toEqual(expect.objectContaining({
      type: 'conversation.done',
      payload: {
        status: 'completed',
      },
    }));
  });

  it('passes persistState into control handling so backend and session changes survive restarts', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ code: 0, ok: true, body: init?.body }), { status: 200 }));

    const { createManagedFeishuRelayClient } = await import('../client.js');
    const client = createManagedFeishuRelayClient({
      agentTimeoutMs: 1_000,
      claudeCwd: process.cwd(),
      stateFile: '/tmp/feishu-state.json',
      artifactsBaseDir: '/tmp/feishu-artifacts',
      artifactRetentionDays: 14,
      artifactMaxSizeBytes: 8 * 1024 * 1024,
      claudeBin: '/opt/homebrew/bin/claude',
      codexBin: '/opt/homebrew/bin/codex',
      feishuGatewayUrl: 'https://gateway.example',
      feishuClientId: 'client-a',
      feishuClientToken: 'token-a',
      feishuClientPollIntervalMs: 500,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => '2026-03-07T00:00:00.000Z',
    });

    await client.handleCommand({
      type: 'conversation.control',
      clientId: 'client-a',
      requestId: 'request-control-persist',
      conversationId: 'conv-1',
      timestamp: '2026-03-07T00:00:00.000Z',
      payload: {
        target: {
          chatId: 'chat-1',
        },
        action: {
          conversationId: 'conv-1',
          type: 'done',
        },
      },
    });

    expect(runtimeMocks.handleFeishuControlAction).toHaveBeenCalledWith(expect.objectContaining({
      persist: coreMocks.persistState,
    }));
  });

  it('emits error and failed done events when local execution throws', async () => {
    vi.doMock('../runtime.js', () => ({
      runFeishuConversation: vi.fn(async () => {
        throw new Error('boom');
      }),
      handleFeishuControlAction: vi.fn(async () => ({ kind: 'applied' })),
    }));

    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
    });

    const { createManagedFeishuRelayClient } = await import('../client.js');
    const client = createManagedFeishuRelayClient({
      agentTimeoutMs: 1_000,
      claudeCwd: process.cwd(),
      stateFile: '/tmp/feishu-state.json',
      artifactsBaseDir: '/tmp/feishu-artifacts',
      artifactRetentionDays: 14,
      artifactMaxSizeBytes: 8 * 1024 * 1024,
      claudeBin: '/opt/homebrew/bin/claude',
      codexBin: '/opt/homebrew/bin/codex',
      feishuGatewayUrl: 'https://gateway.example',
      feishuClientId: 'client-a',
      feishuClientToken: 'token-a',
      feishuClientPollIntervalMs: 500,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => '2026-03-07T00:00:00.000Z',
    });

    await client.handleCommand({
      type: 'conversation.run',
      clientId: 'client-a',
      requestId: 'request-fail',
      conversationId: 'conv-err',
      timestamp: '2026-03-07T00:00:00.000Z',
      payload: {
        target: {
          chatId: 'chat-1',
        },
        prompt: 'hello',
        mode: 'code',
      },
    });

    expect(requests.map(request => (request.event as { type?: string }).type)).toEqual([
      'conversation.error',
      'conversation.done',
    ]);
    expect(requests[0]?.event).toEqual(expect.objectContaining({
      payload: {
        error: 'boom',
      },
    }));
    expect(requests[1]?.event).toEqual(expect.objectContaining({
      payload: {
        status: 'failed',
      },
    }));
  });

  it('emits a backend confirmation card for control actions that need confirmation', async () => {
    vi.doMock('../runtime.js', () => ({
      runFeishuConversation: vi.fn(),
      buildFeishuCardContext: vi.fn(() => ({
        conversationId: 'conv-1',
        chatId: 'chat-1',
      })),
      handleFeishuControlAction: vi.fn(async () => ({
        kind: 'backend-confirmation',
        card: {
          type: 'backend-confirmation',
          conversationId: 'conv-1',
          currentBackend: 'claude',
          requestedBackend: 'codex',
        },
      })),
    }));

    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
    });

    const { createManagedFeishuRelayClient } = await import('../client.js');
    const client = createManagedFeishuRelayClient({
      agentTimeoutMs: 1_000,
      claudeCwd: process.cwd(),
      stateFile: '/tmp/feishu-state.json',
      artifactsBaseDir: '/tmp/feishu-artifacts',
      artifactRetentionDays: 14,
      artifactMaxSizeBytes: 8 * 1024 * 1024,
      claudeBin: '/opt/homebrew/bin/claude',
      codexBin: '/opt/homebrew/bin/codex',
      feishuGatewayUrl: 'https://gateway.example',
      feishuClientId: 'client-a',
      feishuClientToken: 'token-a',
      feishuClientPollIntervalMs: 500,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => '2026-03-07T00:00:00.000Z',
    });

    await client.handleCommand({
      type: 'conversation.control',
      clientId: 'client-a',
      requestId: 'request-control',
      conversationId: 'conv-1',
      timestamp: '2026-03-07T00:00:00.000Z',
      payload: {
        target: {
          chatId: 'chat-1',
        },
        action: {
          conversationId: 'conv-1',
          type: 'backend',
          value: 'codex',
        },
      },
    });

    expect(requests.map(request => (request.event as { type?: string }).type)).toEqual([
      'conversation.card',
      'conversation.done',
    ]);
    expect(requests[0]?.event).toEqual(expect.objectContaining({
      payload: {
        card: expect.objectContaining({
          schema: '2.0',
        }),
      },
    }));
    expect(requests[1]?.event).toEqual(expect.objectContaining({
      payload: {
        status: 'completed',
      },
    }));
  });

  it('initializes persisted state once before entering the polling loop', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      if (url.endsWith('/feishu/bridge/hello')) {
        return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
      }
      if (url.endsWith('/feishu/bridge/heartbeat')) {
        return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
      }
      if (url.endsWith('/feishu/bridge/pull')) {
        return new Response(JSON.stringify({ code: 0, commands: [] }), { status: 200 });
      }

      throw new Error(`unexpected request: ${url} ${JSON.stringify(body)}`);
    });

    const { createManagedFeishuRelayClient } = await import('../client.js');
    const client = createManagedFeishuRelayClient({
      agentTimeoutMs: 1_000,
      claudeCwd: process.cwd(),
      stateFile: '/tmp/feishu-state.json',
      artifactsBaseDir: '/tmp/feishu-artifacts',
      artifactRetentionDays: 14,
      artifactMaxSizeBytes: 8 * 1024 * 1024,
      claudeBin: '/opt/homebrew/bin/claude',
      codexBin: '/opt/homebrew/bin/codex',
      feishuGatewayUrl: 'https://gateway.example',
      feishuClientId: 'client-a',
      feishuClientToken: 'token-a',
      feishuClientPollIntervalMs: 500,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => '2026-03-07T00:00:00.000Z',
      sleep: async () => {
        client.stop();
      },
    });

    await client.start();

    expect(coreMocks.initState).toHaveBeenCalledTimes(1);
  });

  it('recovers from a transient heartbeat failure and keeps polling instead of exiting', async () => {
    const requests: string[] = [];
    let heartbeatAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);

      if (url.endsWith('/feishu/bridge/hello')) {
        return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
      }
      if (url.endsWith('/feishu/bridge/heartbeat')) {
        heartbeatAttempts++;
        if (heartbeatAttempts === 1) {
          throw new Error('temporary outage');
        }
        return new Response(JSON.stringify({ code: 0, ok: true }), { status: 200 });
      }
      if (url.endsWith('/feishu/bridge/pull')) {
        return new Response(JSON.stringify({ code: 0, commands: [] }), { status: 200 });
      }

      throw new Error(`unexpected request: ${url}`);
    });
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length >= 3) {
        client.stop();
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createManagedFeishuRelayClient } = await import('../client.js');
    const client = createManagedFeishuRelayClient({
      agentTimeoutMs: 1_000,
      claudeCwd: process.cwd(),
      stateFile: '/tmp/feishu-state.json',
      artifactsBaseDir: '/tmp/feishu-artifacts',
      artifactRetentionDays: 14,
      artifactMaxSizeBytes: 8 * 1024 * 1024,
      claudeBin: '/opt/homebrew/bin/claude',
      codexBin: '/opt/homebrew/bin/codex',
      feishuGatewayUrl: 'https://gateway.example',
      feishuClientId: 'client-a',
      feishuClientToken: 'token-a',
      feishuClientPollIntervalMs: 500,
    }, {
      fetchImpl: fetchImpl as typeof fetch,
      now: () => '2026-03-07T00:00:00.000Z',
      sleep,
    });

    await client.start();

    expect(requests.filter(url => url.endsWith('/feishu/bridge/hello')).length).toBeGreaterThanOrEqual(2);
    expect(requests.filter(url => url.endsWith('/feishu/bridge/heartbeat')).length).toBeGreaterThanOrEqual(1);
    expect(requests).toContain('https://gateway.example/feishu/bridge/pull');
    expect(warnSpy).toHaveBeenCalledWith('[feishu-client] gateway polling failed:', 'temporary outage');
    warnSpy.mockRestore();
  });
});
