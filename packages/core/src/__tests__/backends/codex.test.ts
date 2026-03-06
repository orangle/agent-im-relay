import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import type { AgentStreamEvent } from '../../agent/session.js';

async function collect(gen: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

function makeProcess(stdout: string, stderr = '', exitCode = 0) {
  const stdoutStream = Readable.from([stdout]);
  const stderrStream = Readable.from([stderr]);
  const proc = {
    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: { write: vi.fn(), end: vi.fn() },
    killed: false,
    kill: vi.fn(),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') setTimeout(() => cb(exitCode, null), 0);
    }),
  };
  return proc;
}

describe('codex backend', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits text events from plain text output', async () => {
    vi.mocked(spawn).mockReturnValue(makeProcess('Hello world\n') as any);

    const { codexBackend } = await import('../../agent/backends/codex.js');
    const events = await collect(codexBackend.stream({
      mode: 'code',
      prompt: 'test',
    }));

    expect(events.some(e => e.type === 'text')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('detects Working directory pattern', async () => {
    vi.mocked(spawn).mockReturnValue(
      makeProcess('Working directory: /home/user/project\nDone.\n') as any,
    );

    const { codexBackend } = await import('../../agent/backends/codex.js');
    const events = await collect(codexBackend.stream({ mode: 'code', prompt: 'test' }));

    const status = events.find(e => e.type === 'status' && e.status.startsWith('cwd:'));
    expect(status).toBeDefined();
    expect((status as any).status).toBe('cwd:/home/user/project');
  });

  it('emits error event on non-zero exit', async () => {
    vi.mocked(spawn).mockReturnValue(makeProcess('', 'command not found', 1) as any);

    const { codexBackend } = await import('../../agent/backends/codex.js');
    const events = await collect(codexBackend.stream({ mode: 'code', prompt: 'test' }));

    expect(events.some(e => e.type === 'error')).toBe(true);
  });
});
