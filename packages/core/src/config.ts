import 'dotenv/config';
import { join } from 'node:path';

function numberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${key}`);
  }

  return parsed;
}

export const config = {
  agentTimeoutMs: numberEnv('AGENT_TIMEOUT_MS', 10 * 60 * 1000),
  claudeModel: process.env['CLAUDE_MODEL'],
  claudeCwd: process.env['CLAUDE_CWD']?.trim() || process.cwd(),
  stateFile: process.env['STATE_FILE']?.trim() || join(process.cwd(), 'data', 'sessions.json'),
};
