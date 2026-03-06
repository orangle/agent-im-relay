# Design: Multi-Backend Support (Claude + Codex)

**Date:** 2026-03-06
**Branch:** feature/multi-im-platform

## Overview

Add OpenAI Codex CLI as a parallel agent backend alongside Claude Code CLI. Users can choose their preferred backend per thread via an interactive Discord UI. Working directory management is also surfaced in the same configuration flow.

## Architecture

### Backend Abstraction (`core`)

```
core/src/agent/
├── backends/
│   ├── claude.ts      ← existing session.ts spawn + parse logic, migrated
│   └── codex.ts       ← new Codex CLI adapter
├── backend.ts         ← AgentBackend interface + getBackend() factory
├── session.ts         ← thin wrapper: resolves backend, calls backend.stream()
└── tools.ts           ← unchanged
```

**`backend.ts`** defines:

```typescript
export type BackendName = 'claude' | 'codex';

export interface AgentBackend {
  readonly name: BackendName;
  stream(options: AgentSessionOptions): AsyncGenerator<AgentStreamEvent, void>;
}

export function getBackend(name: BackendName): AgentBackend;
```

**`backends/claude.ts`** — exact migration of current `session.ts` spawn + stream-json parse logic.

**`backends/codex.ts`** — spawns `codex` binary (path from config, default `/opt/homebrew/bin/codex`), normalizes Codex output to `AgentStreamEvent`. Session resumption not supported in v1 (each conversation is independent).

**`session.ts`** after refactor:

```typescript
export async function* streamAgentSession(
  options: AgentSessionOptions & { backend?: BackendName }
): AsyncGenerator<AgentStreamEvent, void> {
  const backend = getBackend(options.backend ?? 'claude');
  yield* backend.stream(options);
}
```

## State Management

New state in `core/src/state.ts`:

```typescript
export const conversationBackend = new Map<string, BackendName>(); // threadId → backend
export const savedCwdList: string[] = [];                           // user-managed cwd shortcuts
```

Both are persisted to disk via `persist.ts` alongside existing maps.

**Discord layer** reads `conversationBackend.get(thread.id)` and passes it to `streamAgentSession`. If no backend is set (new thread), the configuration UI is shown first.

## Discord UI — Thread Configuration

### Trigger

When a new thread is created (via @mention or `/code` in a channel), the bot posts a configuration message in the thread **before** starting the agent.

**Skip condition:** if `conversationBackend.has(thread.id)` is already set (resume scenario), skip configuration and run immediately.

### Configuration Message

The message contains:

- **Select Menu 1 — Backend:**
  - `Claude (Claude Code)`
  - `Codex (OpenAI Codex)`

- **Select Menu 2 — Working Directory:**
  - Entries from `savedCwdList` (if any)
  - `让 Agent 自己找` (always present)

- **「开始」Button** — submits selections and starts the agent

**Timeout:** 60 seconds of inactivity → auto-select Claude + "让 Agent 自己找", message updated to indicate timeout defaults.

### Implementation

- `discord/src/commands/backend-select.ts` — builds Select Menus, button, handles interactions
- `index.ts` `InteractionCreate` handler — dispatches backend-select interactions

## Working Directory — "Let Agent Find It"

When the user selects `让 Agent 自己找`:

1. `cwd` is set to `config.claudeCwd` (default root)
2. The agent prompt is prefixed with:
   > 请在开始任务前，先找到与本任务相关的项目目录，并在响应的第一行输出：`Working directory: /absolute/path`，然后再执行任务。
3. Bot scans the streaming output for the `Working directory: <path>` pattern
4. On match: `conversationCwd.set(thread.id, path)` is updated in state
5. After the agent response completes, bot sends a follow-up message:
   ```
   📁 Agent 确定工作目录：/path/to/project
   [保存到常用目录] [忽略]
   ```
6. User clicks **保存** → path appended to `savedCwdList` and persisted

## Working Directory Management Commands

New `/cwd` slash command (sub-commands):

| Command | Description |
|---|---|
| `/cwd list` | Show current `savedCwdList` |
| `/cwd add <path>` | Append path to `savedCwdList` |
| `/cwd remove` | Show select menu to remove an entry |

## Config Changes

`core/src/config.ts` — add:

```typescript
codexBin: process.env.CODEX_BIN ?? '/opt/homebrew/bin/codex';
```

`discord/src/config.ts` — no changes needed.

## Out of Scope (v1)

- Codex session resumption (each Codex thread starts fresh)
- Backend switching mid-thread (locked at thread creation)
- Auto-discovery of `codex` binary via `which`
