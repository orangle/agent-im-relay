import './backends/claude.js';
import { getBackend, type BackendName } from './backend.js';

export type AgentStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; summary: string }
  | { type: 'status'; status: string }
  | { type: 'done'; result: string; sessionId?: string }
  | { type: 'error'; error: string };

export type AgentSessionOptions = {
  mode: import('./tools.js').AgentMode;
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  sessionId?: string;
  resumeSessionId?: string;
  abortSignal?: AbortSignal;
};

export async function* streamAgentSession(
  options: AgentSessionOptions & { backend?: BackendName },
): AsyncGenerator<AgentStreamEvent, void> {
  const backend = getBackend(options.backend ?? 'claude');
  yield* backend.stream(options);
}

// Re-export helpers for backward compatibility
export { extractEvents, createClaudeArgs } from './backends/claude.js';
