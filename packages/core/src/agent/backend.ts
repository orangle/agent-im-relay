import type { AgentSessionOptions, AgentStreamEvent } from './session.js';

export type BackendName = 'claude' | 'codex';

export interface AgentBackend {
  readonly name: BackendName;
  stream(options: AgentSessionOptions): AsyncGenerator<AgentStreamEvent, void>;
}

const registry = new Map<BackendName, AgentBackend>();

export function registerBackend(backend: AgentBackend): void {
  registry.set(backend.name, backend);
}

export function getBackend(name: BackendName): AgentBackend {
  const backend = registry.get(name);
  if (!backend) throw new Error(`Unknown backend: ${name}`);
  return backend;
}
