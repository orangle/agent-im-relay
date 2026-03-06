import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { config } from '../../config.js';
import { registerBackend, type AgentBackend } from '../backend.js';
import type { AgentSessionOptions, AgentStreamEvent } from '../session.js';

const WORKING_DIR_PATTERN = /^Working directory:\s*(.+)$/;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function* streamCodex(options: AgentSessionOptions): AsyncGenerator<AgentStreamEvent, void> {
  const cwd = options.cwd ?? config.claudeCwd;

  const prompt = options.cwd
    ? options.prompt
    : `请在开始任务前，先找到与本任务相关的项目目录，并在响应的第一行输出：Working directory: /absolute/path，然后再执行任务。\n\n${options.prompt}`;

  const args = ['-q', prompt];
  if (options.model) args.unshift('--model', options.model);

  const child = spawn(config.codexBin, args, {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );

  const stderrLines: string[] = [];
  let abortReason: 'timeout' | 'aborted' | null = null;

  const timeout = setTimeout(() => {
    abortReason = 'timeout';
    child.kill('SIGTERM');
  }, config.agentTimeoutMs);

  const onAbort = () => {
    abortReason = 'aborted';
    child.kill('SIGTERM');
  };

  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', onAbort);
    if (options.abortSignal.aborted) onAbort();
  }

  const stderrReader = child.stderr ? readline.createInterface({ input: child.stderr }) : null;
  stderrReader?.on('line', (line) => { if (line.trim()) stderrLines.push(line.trim()); });

  const stdoutReader = child.stdout ? readline.createInterface({ input: child.stdout }) : null;
  let fullOutput = '';

  try {
    if (!stdoutReader) throw new Error('Codex CLI stdout is unavailable');

    for await (const rawLine of stdoutReader) {
      const line = rawLine.trimEnd();
      if (!line) continue;

      fullOutput += line + '\n';

      const cwdMatch = WORKING_DIR_PATTERN.exec(line);
      if (cwdMatch?.[1]) {
        yield { type: 'status', status: `cwd:${cwdMatch[1].trim()}` };
      }

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed['type'] === 'message' && typeof parsed['content'] === 'string') {
          yield { type: 'text', delta: parsed['content'] };
          continue;
        }
      } catch {
        // Not JSON — emit as plain text
      }

      yield { type: 'text', delta: line + '\n' };
    }

    const { code, signal } = await closePromise;

    if (abortReason === 'timeout') {
      yield { type: 'error', error: 'Agent request timed out' };
      return;
    }
    if (abortReason === 'aborted') {
      yield { type: 'error', error: 'Agent request aborted' };
      return;
    }
    if (code !== 0) {
      const details = stderrLines.join('\n').trim();
      const fallback = signal
        ? `Codex CLI exited with signal ${signal}`
        : `Codex CLI exited with code ${String(code)}`;
      yield { type: 'error', error: details || fallback };
      return;
    }

    yield { type: 'done', result: fullOutput.trim() };
  } catch (error) {
    if (abortReason === 'timeout') {
      yield { type: 'error', error: 'Agent request timed out' };
    } else if (abortReason === 'aborted') {
      yield { type: 'error', error: 'Agent request aborted' };
    } else {
      const details = stderrLines.join('\n').trim();
      yield { type: 'error', error: details || toErrorMessage(error) };
    }
  } finally {
    clearTimeout(timeout);
    stderrReader?.close();
    stdoutReader?.close();
    if (!child.killed) child.kill('SIGTERM');
    if (options.abortSignal) options.abortSignal.removeEventListener('abort', onAbort);
  }
}

export const codexBackend: AgentBackend = {
  name: 'codex',
  stream: streamCodex,
};

registerBackend(codexBackend);
