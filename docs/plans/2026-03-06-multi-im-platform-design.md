# Multi-IM Platform Refactor Design

## Summary

Refactor `discord-claude-bridge` into `agent-im-relay` — a monorepo that supports multiple IM platforms (Discord, Slack, Feishu, Telegram, etc.) through a capability-based adapter pattern. Each platform deploys independently while sharing core agent communication logic.

## Decisions

| Decision | Choice |
|----------|--------|
| Project name | agent-im-relay |
| Project structure | Monorepo (pnpm workspace) |
| Deployment model | One instance per platform |
| Abstraction | Capability-based Adapter (6 capability interfaces) |
| Agent side | Claude CLI only (abstraction-ready) |
| Scope (this round) | Core extraction + Discord adapter refactor |
| Migration strategy | Incremental, no feature regression |

## Package Structure

```
agent-im-relay/
├── package.json
├── pnpm-workspace.yaml
├── packages/
│   ├── core/                 # @agent-im-relay/core
│   │   └── src/
│   │       ├── agent/        # Claude CLI communication (session.ts, tools.ts)
│   │       ├── types.ts      # Platform capability interface definitions
│   │       ├── orchestrator.ts  # Core orchestration (message → agent → reply)
│   │       ├── state.ts      # Generic session state management
│   │       ├── persist.ts    # State persistence
│   │       ├── skills.ts     # Skill loading (platform-agnostic)
│   │       └── config.ts     # Generic config (agent-related)
│   └── discord/              # @agent-im-relay/discord
│       └── src/
│           ├── index.ts      # Discord entry point
│           ├── adapter.ts    # Implements core capability interfaces
│           ├── stream.ts     # Discord-specific streaming
│           ├── thread.ts     # Discord thread management
│           ├── markdown.ts   # Discord Markdown conversion
│           ├── commands/     # Discord slash commands
│           └── config.ts     # Discord-specific config
```

Key decisions:
- `agent/` moves entirely into core — it is already platform-agnostic
- `skills.ts` moves into core — skill loading has no IM dependency
- `state.ts` + `persist.ts` move into core — state management is generic (key generalized from "threadId" to "conversationId")
- All Discord-specific code (discord.js dependency, embed, reaction, slash commands) stays in the discord package

## Capability Interfaces

Six capability interfaces that IM adapters implement:

### 1. MessageSender (required)

Send, edit, and chunk messages to the platform.

```typescript
interface MessageSender {
  send(conversationId: ConversationId, content: string): Promise<MessageId>;
  edit(conversationId: ConversationId, messageId: MessageId, content: string): Promise<void>;
  maxMessageLength: number;
}
```

### 2. ConversationManager (optional)

Manage conversation threads/contexts.

```typescript
interface ConversationManager {
  createConversation(triggerMessageId: MessageId, context: Record<string, unknown>): Promise<ConversationId>;
  getConversationId(message: IncomingMessage): ConversationId | null;
}
```

### 3. StatusIndicator (optional)

Show agent status to users (thinking, running tools, done, error).

```typescript
interface StatusIndicator {
  setStatus(conversationId: ConversationId, status: AgentStatus): Promise<void>;
  clearStatus(conversationId: ConversationId): Promise<void>;
}
```

### 4. CommandRegistry (optional)

Register and dispatch platform commands.

```typescript
interface CommandRegistry {
  registerCommands(commands: CommandDefinition[]): Promise<void>;
}
```

Core defines command semantics (model, effort, cwd, resume, sessions, clear, compact, skill). Each platform translates to its own format (Discord slash commands, Slack commands, Telegram BotCommand, etc.).

### 5. InteractiveUI (optional)

Select menus, modal dialogs, and other rich interactions.

```typescript
interface InteractiveUI {
  showSelectMenu(conversationId: ConversationId, options: SelectMenuOptions): Promise<string>;
  showPromptInput(conversationId: ConversationId, options: PromptInputOptions): Promise<string>;
}
```

### 6. MarkdownFormatter (optional)

Platform-specific Markdown conversion.

```typescript
interface MarkdownFormatter {
  format(markdown: string): FormattedContent;
}
```

## Orchestrator Flow

```
User sends message in IM
       │
       ▼
  Platform Adapter
  (converts IM event → IncomingMessage)
       │
       ▼
  Orchestrator.handleMessage(adapter, message)
       │
       ├── 1. conversationManager.getConversationId() / createConversation()
       ├── 2. state.getSession(conversationId)
       ├── 3. statusIndicator?.setStatus('thinking')
       ├── 4. streamAgentSession(options) → process events:
       │         text   → accumulate buffer
       │         tool   → append tool line
       │         status → statusIndicator?.setStatus()
       │         error  → append error
       │         done   → update session state
       ├── 5. Periodic flush:
       │         markdownFormatter?.format(buffer)
       │         chunk by messageSender.maxMessageLength
       │         messageSender.send() / edit()
       └── 6. statusIndicator?.clearStatus()
```

The orchestrator knows nothing about any IM platform. It only interacts through capability interfaces. Core logic from the current `streamAgentToDiscord()` (buffer accumulation, periodic flushing, chunking) moves up into the orchestrator.

## Discord Adapter Mapping

| Capability | Discord Implementation |
|------------|----------------------|
| MessageSender | `channel.send()` / `message.edit()`, maxLength=1900 |
| ConversationManager | `message.startThread()`, `channel.isThread()` |
| StatusIndicator | Emoji reactions (thinking, tools, done, error) |
| CommandRegistry | `SlashCommandBuilder` + `guild.commands.set()` |
| InteractiveUI | `StringSelectMenuBuilder` + `ModalBuilder` |
| MarkdownFormatter | `convertMarkdownForDiscord()` (tables→embed, code block protection) |

## Future Platform Reference

| Capability | Slack | Feishu | Telegram |
|------------|-------|--------|----------|
| MessageSender | chat.postMessage/update | Send message API | sendMessage/editMessage |
| ConversationManager | Thread (thread_ts) | Topic group / card | Reply chain |
| StatusIndicator | Emoji reaction | Message status tag | "typing..." action |
| CommandRegistry | Slash commands | Bot commands | BotCommand |
| InteractiveUI | Block Kit | Card interaction | Inline keyboard |
| MarkdownFormatter | mrkdwn | Rich text / Markdown | MarkdownV2 |

## Package Boundary Rules

- `core` has **zero IM dependencies** — no discord.js, @slack/bolt, etc.
- Platform packages depend on core; never the reverse
- Platform packages never depend on each other
- Adding a new platform = create `packages/<platform>`, implement capability interfaces, no core changes needed

## Out of Scope (YAGNI)

- Cross-platform session sharing
- Agent-side abstraction (Claude CLI only for now)
- Runtime dynamic adapter loading
- New platform adapters (this round: core + Discord only)

## Migration Strategy

1. Set up monorepo skeleton (packages/core, packages/discord, pnpm workspace)
2. Move platform-agnostic code to core (agent/, skills.ts, state.ts, persist.ts)
3. Define capability interfaces in core types.ts
4. Extract orchestrator from current streamAgentToDiscord() and index.ts
5. Wrap Discord-specific code as capability interface implementations
6. Verify all existing functionality works unchanged
