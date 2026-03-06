# Multi-IM Platform Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor discord-claude-bridge into agent-im-relay — a pnpm workspace monorepo with a platform-agnostic core package and a Discord adapter package, preserving all existing functionality.

**Architecture:** Capability-based adapter pattern. Core defines 6 capability interfaces (MessageSender, ConversationManager, StatusIndicator, CommandRegistry, InteractiveUI, MarkdownFormatter). Each IM platform implements the interfaces it supports. An orchestrator in core drives the message→agent→reply flow through these interfaces.

**Tech Stack:** TypeScript, pnpm workspace, tsdown (bundler), vitest (testing), Claude CLI (agent backend)

---

## Phase 1: Monorepo Skeleton

### Task 1: Initialize pnpm workspace structure

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/tsdown.config.ts`
- Create: `packages/discord/package.json`
- Create: `packages/discord/tsconfig.json`
- Create: `packages/discord/tsdown.config.ts`
- Modify: `package.json` (root — make it a workspace root)
- Modify: `tsconfig.json` (root — workspace references)

**Step 1: Create pnpm-workspace.yaml**

```yaml
packages:
  - 'packages/*'
```

**Step 2: Update root package.json to workspace root**

```json
{
  "name": "agent-im-relay",
  "version": "1.0.0",
  "private": true,
  "description": "Multi-IM platform relay for AI agents",
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "dev:discord": "pnpm --filter @agent-im-relay/discord dev"
  },
  "engines": {
    "node": ">=20"
  }
}
```

**Step 3: Create packages/core/package.json**

```json
{
  "name": "@agent-im-relay/core",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.mjs",
  "types": "dist/index.d.mts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "types": "./dist/index.d.mts"
    }
  },
  "scripts": {
    "build": "tsdown",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsdown": "^0.20.1",
    "vitest": "^3.2.4"
  }
}
```

**Step 4: Create packages/core/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 5: Create packages/core/tsdown.config.ts**

```typescript
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
});
```

**Step 6: Create packages/discord/package.json**

```json
{
  "name": "@agent-im-relay/discord",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.mjs",
  "scripts": {
    "build": "tsdown",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.mjs",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@agent-im-relay/core": "workspace:*",
    "discord.js": "^14.18.0",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsdown": "^0.20.1",
    "tsx": "^4.19.2",
    "vitest": "^3.2.4"
  }
}
```

**Step 7: Create packages/discord/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 8: Create packages/discord/tsdown.config.ts**

```typescript
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
});
```

**Step 9: Install dependencies and verify workspace**

Run: `cd /Users/doctorwu/Projects/Self/discord-claude-bridge && pnpm install`
Expected: Clean install, workspace packages linked

**Step 10: Commit**

```bash
git add pnpm-workspace.yaml package.json packages/
git commit -m "chore: initialize pnpm workspace monorepo skeleton"
```

---

## Phase 2: Move platform-agnostic code to core

### Task 2: Move agent module to core

**Files:**
- Move: `src/agent/session.ts` → `packages/core/src/agent/session.ts`
- Move: `src/agent/tools.ts` → `packages/core/src/agent/tools.ts`
- Move: `src/agent/__tests__/session.test.ts` → `packages/core/src/agent/__tests__/session.test.ts`
- Move: `src/agent/__tests__/tools.test.ts` → `packages/core/src/agent/__tests__/tools.test.ts`

**Step 1: Copy agent files to core**

```bash
mkdir -p packages/core/src/agent/__tests__
cp src/agent/session.ts packages/core/src/agent/session.ts
cp src/agent/tools.ts packages/core/src/agent/tools.ts
cp src/agent/__tests__/session.test.ts packages/core/src/agent/__tests__/session.test.ts
cp src/agent/__tests__/tools.test.ts packages/core/src/agent/__tests__/tools.test.ts
```

**Step 2: Update import paths in core agent files**

In `packages/core/src/agent/session.ts`, change:
- `'../config.js'` → `'../config.js'` (same relative path, will work once core config exists)

**Step 3: Create core config.ts**

Create `packages/core/src/config.ts` with only the agent-related config (no Discord-specific fields):

```typescript
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
```

**Step 4: Run core tests**

Run: `cd packages/core && pnpm test`
Expected: All agent tests pass

**Step 5: Commit**

```bash
git add packages/core/src/agent/ packages/core/src/config.ts
git commit -m "feat(core): move agent module and config to core package"
```

### Task 3: Move skills module to core

**Files:**
- Move: `src/skills.ts` → `packages/core/src/skills.ts`
- Move: `src/__tests__/skills.test.ts` → `packages/core/src/__tests__/skills.test.ts`

**Step 1: Copy skills files**

```bash
mkdir -p packages/core/src/__tests__
cp src/skills.ts packages/core/src/skills.ts
cp src/__tests__/skills.test.ts packages/core/src/__tests__/skills.test.ts
```

No import changes needed — skills.ts has no project-internal dependencies.

**Step 2: Run tests**

Run: `cd packages/core && pnpm test`
Expected: Skills tests pass

**Step 3: Commit**

```bash
git add packages/core/src/skills.ts packages/core/src/__tests__/
git commit -m "feat(core): move skills module to core package"
```

### Task 4: Move state and persist modules to core (generalized)

**Files:**
- Create: `packages/core/src/state.ts` (generalized from `src/state.ts`)
- Create: `packages/core/src/persist.ts` (generalized from `src/persist.ts`)

**Step 1: Create generalized persist.ts in core**

```typescript
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

interface PersistedState {
  sessions: Record<string, string>;
  models: Record<string, string>;
  effort: Record<string, string>;
  cwd: Record<string, string>;
}

function populateMap(map: Map<string, string>, record: unknown): void {
  if (typeof record !== 'object' || record === null) return;
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (typeof v === 'string') map.set(k, v);
  }
}

export async function loadState(
  sessions: Map<string, string>,
  models: Map<string, string>,
  effort: Map<string, string>,
  cwd: Map<string, string>,
): Promise<void> {
  try {
    const raw = await readFile(config.stateFile, 'utf-8');
    const parsed: PersistedState = JSON.parse(raw) as PersistedState;
    // Support both old (threadSessions) and new (sessions) keys
    populateMap(sessions, parsed.sessions ?? (parsed as any).threadSessions);
    populateMap(models, parsed.models ?? (parsed as any).threadModels);
    populateMap(effort, parsed.effort ?? (parsed as any).threadEffort);
    populateMap(cwd, parsed.cwd ?? (parsed as any).threadCwd);
    console.log(`[state] Loaded ${sessions.size} session(s) from ${config.stateFile}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[state] Could not load persisted state:', err);
    }
  }
}

export async function saveState(
  sessions: Map<string, string>,
  models: Map<string, string>,
  effort: Map<string, string>,
  cwd: Map<string, string>,
): Promise<void> {
  const data: PersistedState = {
    sessions: Object.fromEntries(sessions),
    models: Object.fromEntries(models),
    effort: Object.fromEntries(effort),
    cwd: Object.fromEntries(cwd),
  };
  try {
    await mkdir(dirname(config.stateFile), { recursive: true });
    await writeFile(config.stateFile, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[state] Failed to save state:', err);
  }
}
```

**Step 2: Create generalized state.ts in core**

```typescript
import { loadState, saveState } from './persist.js';

// Generalized keys: "conversationId" instead of "threadId"
export const conversationSessions = new Map<string, string>();
export const conversationModels = new Map<string, string>();
export const conversationEffort = new Map<string, string>();
export const conversationCwd = new Map<string, string>();
export const activeConversations = new Set<string>();
export const processedMessages = new Set<string>();
export const pendingConversationCreation = new Set<string>();

export async function initState(): Promise<void> {
  await loadState(conversationSessions, conversationModels, conversationEffort, conversationCwd);
}

export async function persistState(): Promise<void> {
  await saveState(conversationSessions, conversationModels, conversationEffort, conversationCwd);
}
```

**Step 3: Run tests**

Run: `cd packages/core && pnpm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/core/src/state.ts packages/core/src/persist.ts
git commit -m "feat(core): add generalized state and persist modules"
```

---

## Phase 3: Define capability interfaces

### Task 5: Define core types and capability interfaces

**Files:**
- Create: `packages/core/src/types.ts`

**Step 1: Write the types file**

```typescript
// === Base identifiers ===

/** Platform-agnostic conversation identifier */
export type ConversationId = string;
/** Platform-agnostic message identifier */
export type MessageId = string;

// === Agent status ===

export type AgentStatus = 'thinking' | 'tool_running' | 'done' | 'error';

// === Incoming message model ===

export interface IncomingMessage {
  id: MessageId;
  conversationId: ConversationId | null;
  content: string;
  authorId: string;
  authorName: string;
  isBotMention: boolean;
  /** Platform-specific raw message object */
  raw: unknown;
}

// === Formatted content ===

export interface FormattedContent {
  text: string;
  /** Platform-specific rich content (Discord embeds, Slack blocks, etc.) */
  extras?: unknown;
}

// === Command definitions ===

export interface CommandArgChoice {
  name: string;
  value: string;
}

export interface CommandArg {
  name: string;
  description: string;
  type: 'string' | 'choice';
  required?: boolean;
  choices?: CommandArgChoice[];
}

export interface CommandDefinition {
  name: string;
  description: string;
  args: CommandArg[];
  /** If true, command only works within a conversation context */
  requiresConversation?: boolean;
}

export interface CommandInvocation {
  name: string;
  args: Record<string, string>;
  conversationId: ConversationId | null;
  authorId: string;
  /** Platform-specific reply function for ephemeral feedback */
  reply: (content: string) => Promise<void>;
}

// === Select menu / prompt input ===

export interface SelectMenuOption {
  label: string;
  value: string;
  description?: string;
}

export interface SelectMenuOptions {
  placeholder: string;
  options: SelectMenuOption[];
}

export interface PromptInputOptions {
  title: string;
  label: string;
  placeholder?: string;
}

// === Capability interfaces ===

/** 1. Send and edit messages — REQUIRED */
export interface MessageSender {
  send(conversationId: ConversationId, content: string, extras?: unknown): Promise<MessageId>;
  edit(conversationId: ConversationId, messageId: MessageId, content: string, extras?: unknown): Promise<void>;
  maxMessageLength: number;
}

/** 2. Manage conversation threads/contexts — optional */
export interface ConversationManager {
  createConversation(triggerMessageId: MessageId, context: { authorName: string; prompt: string }): Promise<ConversationId>;
  getConversationId(message: IncomingMessage): ConversationId | null;
}

/** 3. Show agent status to users — optional */
export interface StatusIndicator {
  setStatus(conversationId: ConversationId, status: AgentStatus, triggerMessageRaw?: unknown): Promise<void>;
  clearStatus(conversationId: ConversationId, triggerMessageRaw?: unknown): Promise<void>;
}

/** 4. Register and dispatch platform commands — optional */
export interface CommandRegistry {
  registerCommands(commands: CommandDefinition[]): Promise<void>;
}

/** 5. Rich interactive UI (select menus, modals) — optional */
export interface InteractiveUI {
  showSelectMenu(conversationId: ConversationId, options: SelectMenuOptions): Promise<string>;
  showPromptInput(conversationId: ConversationId, options: PromptInputOptions): Promise<string>;
}

/** 6. Platform-specific Markdown conversion — optional */
export interface MarkdownFormatter {
  format(markdown: string): FormattedContent;
}

// === Adapter composite ===

export interface PlatformAdapter {
  readonly name: string;
  readonly messageSender: MessageSender;
  readonly conversationManager?: ConversationManager;
  readonly statusIndicator?: StatusIndicator;
  readonly commandRegistry?: CommandRegistry;
  readonly interactiveUI?: InteractiveUI;
  readonly markdownFormatter?: MarkdownFormatter;
}
```

**Step 2: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): define capability interfaces and platform adapter types"
```

---

## Phase 4: Build the orchestrator

### Task 6: Write failing tests for the orchestrator

**Files:**
- Create: `packages/core/src/__tests__/orchestrator.test.ts`

**Step 1: Write orchestrator tests**

Tests should verify:
1. Orchestrator calls `conversationManager.getConversationId()` to resolve conversation
2. Orchestrator calls `conversationManager.createConversation()` when no existing conversation
3. Orchestrator calls `statusIndicator.setStatus('thinking')` at start
4. Orchestrator calls `messageSender.send()` to deliver response
5. Orchestrator calls `statusIndicator.clearStatus()` on completion
6. Orchestrator handles missing optional capabilities gracefully (no statusIndicator → no crash)
7. Orchestrator applies `markdownFormatter.format()` before sending
8. Orchestrator chunks messages by `messageSender.maxMessageLength`
9. Orchestrator accumulates text events and flushes periodically

Use mock `PlatformAdapter` implementations and a mock `AgentStreamEvent` async generator.

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter, MessageSender, ConversationManager, StatusIndicator, MarkdownFormatter, IncomingMessage } from '../types.js';
import type { AgentStreamEvent } from '../agent/session.js';
import { Orchestrator } from '../orchestrator.js';

function createMockAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    name: 'test',
    messageSender: {
      send: vi.fn().mockResolvedValue('msg-1'),
      edit: vi.fn().mockResolvedValue(undefined),
      maxMessageLength: 2000,
    },
    ...overrides,
  };
}

function createIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'msg-trigger',
    conversationId: 'conv-1',
    content: 'Hello Claude',
    authorId: 'user-1',
    authorName: 'Test User',
    isBotMention: true,
    raw: {},
    ...overrides,
  };
}

async function* fakeAgentStream(events: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('Orchestrator', () => {
  it('sends agent response via messageSender', async () => {
    const adapter = createMockAdapter();
    const orchestrator = new Orchestrator();

    await orchestrator.handleMessage(adapter, createIncomingMessage(), () =>
      fakeAgentStream([
        { type: 'text', delta: 'Hello!' },
        { type: 'done', result: 'Hello!' },
      ]),
    );

    expect(adapter.messageSender.send).toHaveBeenCalled();
  });

  it('calls statusIndicator when available', async () => {
    const statusIndicator: StatusIndicator = {
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = createMockAdapter({ statusIndicator });
    const orchestrator = new Orchestrator();

    await orchestrator.handleMessage(adapter, createIncomingMessage(), () =>
      fakeAgentStream([
        { type: 'text', delta: 'Hi' },
        { type: 'done', result: 'Hi' },
      ]),
    );

    expect(statusIndicator.setStatus).toHaveBeenCalledWith('conv-1', 'thinking', expect.anything());
    expect(statusIndicator.clearStatus).toHaveBeenCalled();
  });

  it('works without optional capabilities', async () => {
    const adapter = createMockAdapter();
    const orchestrator = new Orchestrator();

    // No statusIndicator, no conversationManager, no markdownFormatter — should not throw
    await expect(
      orchestrator.handleMessage(adapter, createIncomingMessage(), () =>
        fakeAgentStream([
          { type: 'text', delta: 'Works' },
          { type: 'done', result: 'Works' },
        ]),
      ),
    ).resolves.not.toThrow();
  });

  it('creates conversation via conversationManager when no conversationId', async () => {
    const conversationManager: ConversationManager = {
      createConversation: vi.fn().mockResolvedValue('new-conv'),
      getConversationId: vi.fn().mockReturnValue(null),
    };
    const adapter = createMockAdapter({ conversationManager });
    const orchestrator = new Orchestrator();

    await orchestrator.handleMessage(
      adapter,
      createIncomingMessage({ conversationId: null }),
      () => fakeAgentStream([
        { type: 'text', delta: 'Created' },
        { type: 'done', result: 'Created' },
      ]),
    );

    expect(conversationManager.createConversation).toHaveBeenCalledWith('msg-trigger', {
      authorName: 'Test User',
      prompt: 'Hello Claude',
    });
  });

  it('applies markdownFormatter before sending', async () => {
    const markdownFormatter: MarkdownFormatter = {
      format: vi.fn().mockReturnValue({ text: 'formatted text', extras: { embeds: [] } }),
    };
    const adapter = createMockAdapter({ markdownFormatter });
    const orchestrator = new Orchestrator();

    await orchestrator.handleMessage(adapter, createIncomingMessage(), () =>
      fakeAgentStream([
        { type: 'text', delta: '**bold**' },
        { type: 'done', result: '**bold**' },
      ]),
    );

    expect(markdownFormatter.format).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test`
Expected: FAIL — `../orchestrator.js` module not found

**Step 3: Commit**

```bash
git add packages/core/src/__tests__/orchestrator.test.ts
git commit -m "test(core): add failing orchestrator tests"
```

### Task 7: Implement the orchestrator

**Files:**
- Create: `packages/core/src/orchestrator.ts`

**Step 1: Implement orchestrator**

Extract the core streaming logic from the current `streamAgentToDiscord()` and `runMentionConversation()` into a platform-agnostic orchestrator. The orchestrator:

1. Resolves or creates a conversation
2. Sets status to 'thinking'
3. Streams agent events, accumulating a text buffer
4. Periodically flushes the buffer through the formatter and message sender
5. Handles tool events, errors, and completion
6. Clears status on finish

```typescript
import type {
  PlatformAdapter,
  IncomingMessage,
  ConversationId,
  MessageId,
  FormattedContent,
} from './types.js';
import type { AgentStreamEvent } from './agent/session.js';

export type AgentSessionFactory = (conversationId: ConversationId, prompt: string) => AsyncGenerator<AgentStreamEvent, void>;

export interface OrchestratorOptions {
  flushIntervalMs?: number;
}

function chunkText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex < Math.floor(maxLength * 0.4)) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIndex < Math.floor(maxLength * 0.4)) {
      splitIndex = maxLength;
    }

    const chunk = remaining.slice(0, splitIndex);
    const openFences = (chunk.match(/```/g) ?? []).length;
    if (openFences % 2 !== 0) {
      chunks.push(chunk + '\n```');
      remaining = '```\n' + remaining.slice(splitIndex).trimStart();
    } else {
      chunks.push(chunk);
      remaining = remaining.slice(splitIndex).trimStart();
    }
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function formatToolLine(summary: string): string {
  return `> 🔧 ${summary.length > 200 ? summary.slice(0, 197) + '...' : summary}`;
}

export class Orchestrator {
  private flushIntervalMs: number;

  constructor(options: OrchestratorOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
  }

  async handleMessage(
    adapter: PlatformAdapter,
    message: IncomingMessage,
    createAgentStream: AgentSessionFactory,
  ): Promise<{ sessionId?: string }> {
    // 1. Resolve conversation
    let conversationId = message.conversationId;

    if (!conversationId && adapter.conversationManager) {
      conversationId = await adapter.conversationManager.createConversation(message.id, {
        authorName: message.authorName,
        prompt: message.content,
      });
    }

    if (!conversationId) {
      conversationId = message.id; // Fallback: use message id as conversation
    }

    // 2. Set status
    await adapter.statusIndicator?.setStatus(conversationId, 'thinking', message.raw);

    // 3. Stream agent events
    const messages: MessageId[] = [];
    let buffer = '';
    let lastFlush = 0;
    let renderedChunks: string[] = [];
    let toolCount = 0;
    let isThinking = false;
    let sessionId: string | undefined;
    const maxLength = adapter.messageSender.maxMessageLength;

    const flush = async (): Promise<void> => {
      const body = buffer.trim() || '⏳ Thinking...';

      let formatted: FormattedContent;
      if (adapter.markdownFormatter) {
        formatted = adapter.markdownFormatter.format(body);
      } else {
        formatted = { text: body };
      }

      const displayText = formatted.text.trim() || ' ';
      const chunks = chunkText(displayText, maxLength);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] ?? '';
        const existing = messages[i];
        const previous = renderedChunks[i];

        if (!existing) {
          const msgId = await adapter.messageSender.send(
            conversationId!,
            chunk,
            i === 0 ? formatted.extras : undefined,
          );
          messages.push(msgId);
        } else if (chunk !== previous) {
          await adapter.messageSender.edit(
            conversationId!,
            existing,
            chunk,
            i === 0 ? formatted.extras : undefined,
          ).catch(() => {});
        }
      }

      renderedChunks = chunks;
      lastFlush = Date.now();
    };

    try {
      const events = createAgentStream(conversationId, message.content);

      for await (const event of events) {
        if (event.type === 'text') {
          if (isThinking) {
            isThinking = false;
            buffer = '';
          }
          buffer += event.delta;
        } else if (event.type === 'tool') {
          toolCount++;
          buffer += '\n' + formatToolLine(event.summary) + '\n';
          await adapter.statusIndicator?.setStatus(conversationId, 'tool_running', message.raw);
        } else if (event.type === 'status') {
          if (!isThinking && !buffer.trim()) {
            isThinking = true;
            buffer = '⏳ *' + event.status + '*';
          }
        } else if (event.type === 'error') {
          buffer += `\n\n❌ **Error:** ${event.error}\n`;
          await adapter.statusIndicator?.setStatus(conversationId, 'error', message.raw);
        } else if (event.type === 'done') {
          if (!buffer.trim() && event.result) {
            buffer = event.result;
          }
          if (toolCount > 0) {
            buffer += `\n-# 🔧 ${toolCount} tool${toolCount > 1 ? 's' : ''} used`;
          }
          sessionId = event.sessionId;
        }

        if (Date.now() - lastFlush >= this.flushIntervalMs) {
          await flush();
        }
      }

      await flush();
      await adapter.statusIndicator?.setStatus(conversationId, 'done', message.raw);
    } finally {
      await adapter.statusIndicator?.clearStatus(conversationId, message.raw);
    }

    return { sessionId };
  }
}
```

**Step 2: Run tests**

Run: `cd packages/core && pnpm test`
Expected: All orchestrator tests pass

**Step 3: Commit**

```bash
git add packages/core/src/orchestrator.ts
git commit -m "feat(core): implement platform-agnostic orchestrator"
```

### Task 8: Create core package entry point

**Files:**
- Create: `packages/core/src/index.ts`

**Step 1: Write the barrel export**

```typescript
// Types
export type {
  ConversationId,
  MessageId,
  AgentStatus,
  IncomingMessage,
  FormattedContent,
  CommandArgChoice,
  CommandArg,
  CommandDefinition,
  CommandInvocation,
  SelectMenuOption,
  SelectMenuOptions,
  PromptInputOptions,
  MessageSender,
  ConversationManager,
  StatusIndicator,
  CommandRegistry,
  InteractiveUI,
  MarkdownFormatter,
  PlatformAdapter,
} from './types.js';

// Orchestrator
export { Orchestrator } from './orchestrator.js';
export type { AgentSessionFactory, OrchestratorOptions } from './orchestrator.js';

// Agent
export { streamAgentSession, extractEvents, createClaudeArgs } from './agent/session.js';
export type { AgentStreamEvent, AgentSessionOptions } from './agent/session.js';
export { toolsForMode } from './agent/tools.js';
export type { AgentMode } from './agent/tools.js';

// State
export {
  conversationSessions,
  conversationModels,
  conversationEffort,
  conversationCwd,
  activeConversations,
  processedMessages,
  pendingConversationCreation,
  initState,
  persistState,
} from './state.js';

// Skills
export { listSkills, refreshSkills, readSkillsFromDirectory, parseSkillFrontmatter } from './skills.js';
export type { SkillInfo } from './skills.js';

// Config
export { config } from './config.js';
```

**Step 2: Build core package**

Run: `cd packages/core && pnpm build`
Expected: Clean build, dist/ output with .mjs and .d.mts files

**Step 3: Run all core tests**

Run: `cd packages/core && pnpm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add package entry point with barrel exports"
```

---

## Phase 5: Build the Discord adapter

### Task 9: Move Discord-specific code to discord package

**Files:**
- Move: `src/discord/stream.ts` → `packages/discord/src/stream.ts`
- Move: `src/discord/thread.ts` → `packages/discord/src/thread.ts`
- Move: `src/discord/__tests__/stream.test.ts` → `packages/discord/src/__tests__/stream.test.ts`
- Move: `src/discord/__tests__/thread.test.ts` → `packages/discord/src/__tests__/thread.test.ts`
- Move: `src/commands/ask.ts` → `packages/discord/src/commands/ask.ts`
- Move: `src/commands/code.ts` → `packages/discord/src/commands/code.ts`
- Move: `src/commands/skill.ts` → `packages/discord/src/commands/skill.ts`
- Move: `src/commands/claude-control.ts` → `packages/discord/src/commands/claude-control.ts`

**Step 1: Copy files**

```bash
mkdir -p packages/discord/src/{__tests__,commands}
cp src/discord/stream.ts packages/discord/src/stream.ts
cp src/discord/thread.ts packages/discord/src/thread.ts
cp src/discord/__tests__/stream.test.ts packages/discord/src/__tests__/stream.test.ts
cp src/discord/__tests__/thread.test.ts packages/discord/src/__tests__/thread.test.ts
cp src/commands/ask.ts packages/discord/src/commands/ask.ts
cp src/commands/code.ts packages/discord/src/commands/code.ts
cp src/commands/skill.ts packages/discord/src/commands/skill.ts
cp src/commands/claude-control.ts packages/discord/src/commands/claude-control.ts
```

**Step 2: Update imports in all Discord package files**

Change imports from local paths to `@agent-im-relay/core` where appropriate:

- `'../agent/session.js'` → `'@agent-im-relay/core'`
- `'../config.js'` → core exports or local discord config
- `'../state.js'` → `'@agent-im-relay/core'`
- `'../skills.js'` → `'@agent-im-relay/core'`
- `'../discord/stream.js'` → `'../stream.js'` (local within discord package)

**Step 3: Create Discord-specific config**

Create `packages/discord/src/config.ts`:

```typescript
import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function numberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment variable: ${key}`);
  }

  return parsed;
}

export const discordConfig = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  discordClientId: requireEnv('DISCORD_CLIENT_ID'),
  guildIds: process.env['GUILD_IDS']
    ? process.env['GUILD_IDS'].split(',').map((id) => id.trim()).filter(Boolean)
    : [],
  streamUpdateIntervalMs: numberEnv('STREAM_UPDATE_INTERVAL_MS', 1000),
  messageCharLimit: numberEnv('DISCORD_MESSAGE_CHAR_LIMIT', 1900),
};
```

**Step 4: Run Discord tests**

Run: `cd packages/discord && pnpm test`
Expected: All stream and thread tests pass

**Step 5: Commit**

```bash
git add packages/discord/src/
git commit -m "feat(discord): move Discord-specific code to discord package"
```

### Task 10: Implement Discord adapter (capability interfaces)

**Files:**
- Create: `packages/discord/src/adapter.ts`

**Step 1: Implement the Discord adapter**

Wrap existing Discord functionality as capability interface implementations:

```typescript
import type {
  PlatformAdapter,
  MessageSender,
  ConversationManager,
  StatusIndicator,
  MarkdownFormatter,
  ConversationId,
  MessageId,
  IncomingMessage,
  AgentStatus,
  FormattedContent,
} from '@agent-im-relay/core';
import type { AnyThreadChannel, Client, Message } from 'discord.js';
import { ChannelType, ThreadAutoArchiveDuration } from 'discord.js';
import { convertMarkdownForDiscord } from './stream.js';
import { sanitizeThreadName } from './thread.js';
import { discordConfig } from './config.js';

// --- Reaction emoji mapping ---
const STATUS_REACTIONS: Record<AgentStatus, string> = {
  thinking: '🧠',
  tool_running: '🔧',
  done: '✅',
  error: '❌',
};

export class DiscordMessageSender implements MessageSender {
  maxMessageLength = discordConfig.messageCharLimit;

  private channels = new Map<ConversationId, AnyThreadChannel>();

  registerChannel(conversationId: ConversationId, channel: AnyThreadChannel): void {
    this.channels.set(conversationId, channel);
  }

  async send(conversationId: ConversationId, content: string, extras?: unknown): Promise<MessageId> {
    const channel = this.channels.get(conversationId);
    if (!channel) throw new Error(`No channel registered for conversation ${conversationId}`);

    const payload = extras ? { content, embeds: extras as any[] } : content;
    const msg = await channel.send(payload);
    return msg.id;
  }

  async edit(conversationId: ConversationId, messageId: MessageId, content: string, extras?: unknown): Promise<void> {
    const channel = this.channels.get(conversationId);
    if (!channel) return;

    const msg = await channel.messages.fetch(messageId).catch(() => null);
    if (!msg) return;

    const payload = extras ? { content, embeds: extras as any[] } : { content };
    await msg.edit(payload).catch(() => {});
  }
}

export class DiscordConversationManager implements ConversationManager {
  constructor(private client: Client) {}

  async createConversation(triggerMessageId: MessageId, context: { authorName: string; prompt: string }): Promise<ConversationId> {
    // This will be called from the Discord event handler with proper message context
    // The actual thread creation is done in the event handler since it needs the Message object
    throw new Error('Use createThreadFromMessage() instead');
  }

  getConversationId(message: IncomingMessage): ConversationId | null {
    return message.conversationId;
  }
}

export class DiscordStatusIndicator implements StatusIndicator {
  private currentReactions = new Map<ConversationId, string>();
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async setStatus(conversationId: ConversationId, status: AgentStatus, triggerMessageRaw?: unknown): Promise<void> {
    const msg = triggerMessageRaw as Message | undefined;
    if (!msg?.react) return;

    const emoji = STATUS_REACTIONS[status];
    const current = this.currentReactions.get(conversationId);

    try {
      if (current && current !== emoji) {
        await msg.reactions.cache.get(current)?.users.remove(this.client.user!.id).catch(() => {});
      }
      await msg.react(emoji);
      this.currentReactions.set(conversationId, emoji);
    } catch {
      // Silently ignore reaction failures
    }
  }

  async clearStatus(conversationId: ConversationId): Promise<void> {
    this.currentReactions.delete(conversationId);
  }
}

export class DiscordMarkdownFormatter implements MarkdownFormatter {
  format(markdown: string): FormattedContent {
    const result = convertMarkdownForDiscord(markdown);
    return {
      text: result.text,
      extras: result.embeds.length > 0 ? result.embeds : undefined,
    };
  }
}

export function createDiscordAdapter(client: Client): PlatformAdapter & {
  messageSender: DiscordMessageSender;
  conversationManager: DiscordConversationManager;
  statusIndicator: DiscordStatusIndicator;
  markdownFormatter: DiscordMarkdownFormatter;
} {
  return {
    name: 'discord',
    messageSender: new DiscordMessageSender(),
    conversationManager: new DiscordConversationManager(client),
    statusIndicator: new DiscordStatusIndicator(client),
    markdownFormatter: new DiscordMarkdownFormatter(),
  };
}
```

**Step 2: Commit**

```bash
git add packages/discord/src/adapter.ts
git commit -m "feat(discord): implement capability interface adapter"
```

### Task 11: Rewrite Discord entry point using core orchestrator

**Files:**
- Create: `packages/discord/src/index.ts`

**Step 1: Rewrite index.ts**

Port the current `src/index.ts` to use the core orchestrator and Discord adapter. The event handlers (`MessageCreate`, `InteractionCreate`) translate Discord events into `IncomingMessage` and call `orchestrator.handleMessage()`.

Keep the same behavior: `@mention` creates threads, in-thread messages continue sessions, slash commands work as before. The key difference is that the streaming/buffer/flush logic now lives in the core orchestrator instead of `streamAgentToDiscord()`.

This file remains the most complex piece — it's the glue between discord.js events and the core orchestrator. Follow the structure of the current `src/index.ts` but delegate agent interaction to the orchestrator.

**Step 2: Run Discord tests**

Run: `cd packages/discord && pnpm test`
Expected: All tests pass

**Step 3: Integration test**

Run: `cd packages/discord && pnpm build`
Expected: Clean build

**Step 4: Commit**

```bash
git add packages/discord/src/index.ts
git commit -m "feat(discord): rewrite entry point using core orchestrator"
```

---

## Phase 6: Cleanup and verify

### Task 12: Remove old src/ directory

**Files:**
- Delete: `src/` (entire directory — all code has been moved to packages/)
- Delete: `tsdown.config.ts` (root — each package has its own)
- Update: root `tsconfig.json` (if needed)

**Step 1: Verify all code is in packages**

Confirm every file in `src/` has been moved to either `packages/core/src/` or `packages/discord/src/`.

**Step 2: Remove old files**

```bash
rm -rf src/
rm -f tsdown.config.ts
```

**Step 3: Run full test suite**

Run: `pnpm test` (from workspace root)
Expected: All tests pass across both packages

**Step 4: Build all packages**

Run: `pnpm build` (from workspace root)
Expected: Clean builds for core and discord

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove old src/ directory after migration to monorepo"
```

### Task 13: Update documentation

**Files:**
- Modify: `README.md` (update project name, structure, setup instructions)
- Modify: `.env.example` (if exists — document which env vars go where)

**Step 1: Update README**

Update project name to `agent-im-relay`, document the monorepo structure, explain how to add a new platform adapter.

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for agent-im-relay monorepo"
```

### Task 14: End-to-end manual verification

**Step 1: Start the Discord bot**

Run: `pnpm dev:discord`
Expected: Bot logs in, registers slash commands

**Step 2: Test core flows**

- `@mention` the bot in a channel → thread created, Claude responds
- Send follow-up message in thread → Claude continues session
- `/code` command → new thread, Claude runs
- `/ask` command → inline response
- `/model`, `/effort`, `/cwd`, `/resume`, `/sessions`, `/clear`, `/compact` → all work
- `/skill` → select menu appears, modal works
- `/done` → session ended

**Step 3: Verify no regression**

Confirm all features match the pre-refactor behavior. No new features, no removed features.
