export type AgentMode = 'code' | 'ask';

const codeModeArgs = ['--dangerously-skip-permissions'];
const askModeArgs = ['--allowedTools', ''];

export function toolsForMode(mode: AgentMode): string[] {
  return mode === 'code' ? [...codeModeArgs] : [...askModeArgs];
}
