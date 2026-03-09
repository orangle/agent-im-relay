# Design: Feishu Session Presentation Refactor for `agent-im-relay`

**Date:** 2026-03-09
**Status:** Approved

## Overview

Refactor the Feishu adapter so that launcher flow, session presentation, and conversation execution become explicit layers instead of being mixed inside `events.ts` and `runtime.ts`.

The main UX changes are:

- private-chat launch receipts become Feishu native shared-chat cards instead of custom text receipts
- session chats no longer use a persistent control panel or anchor card
- each user message inside a session chat shows a one-shot interrupt card
- the bot still mirrors the original prompt into the new session chat, but that mirrored message must never trigger a second run
- group names should be readable and tied to the original request: `Session · {promptPreview}`

## Goals

- Replace the private-chat text receipt with Feishu's native shared-chat message
- Remove session-anchor and menu-first control UX from the main Feishu flow
- Show one attractive interrupt card per user message in session chats
- Improve conversation signal-to-noise by removing startup chatter and duplicate replies
- Clarify module boundaries so Feishu-visible UI decisions live in one place

## Non-Goals

- Reworking Discord behavior
- Adding new Feishu session controls beyond `interrupt` in this pass
- Moving Feishu presentation policy into shared core unless the current lifecycle API proves insufficient
- Supporting multi-user ownership semantics for Feishu sessions

## Architecture

The Feishu adapter should be split into four layers.

### 1. Ingress Router

`events.ts` becomes a thin ingress layer that:

- normalizes Feishu events
- deduplicates message, action, and menu deliveries
- classifies traffic into launcher, session message, or control action flows
- delegates all visible response behavior to dedicated services

It should not build user-facing copy beyond direct error passthroughs that must be surfaced immediately.

### 2. Launcher Service

`launcher.ts` owns the private-chat launch workflow:

1. create the session chat with a name derived from the original prompt
2. persist the session-chat record
3. send Feishu's native shared-chat message back to the private chat
4. send the session reference message inside the new chat
5. mirror the original prompt into the new chat
6. hand off the first run to the execution path

### 3. Session Presentation

`presentation.ts` owns all visible session-chat UI policy:

- one-shot interrupt cards
- optional run-state hints if still needed after implementation
- busy/final-output idempotency
- reply-vs-send strategy and fallback ownership

This layer is the only Feishu module allowed to decide when a session message should become a visible text/card update.

### 4. Conversation Executor

`runtime.ts` is reduced to execution wiring:

- adapt Feishu transport to core conversation execution
- surface lifecycle hooks instead of directly posting control UI
- leave card emission and messaging policy to presentation modules

## Product Flow

### Private Chat Launcher Flow

When the user sends a new message in the main Feishu chat:

1. the bot creates a new session group
2. the group name is `Session · {promptPreview}`
3. the main chat receives a native shared-chat card for that new group
4. the session group receives a reference message listing common commands
5. the bot mirrors the original prompt as a plain text message in the group
6. the session run starts using the original prompt

The mirrored prompt is a readability and context aid only. It is not a second user input.

### Session Chat Flow

For each user message inside a session chat:

1. show one interrupt card
2. start one run
3. publish one final answer

There is no persistent anchor card, no always-open panel, and no menu-first dependency in the main path.

### Session Naming

Session group names should be derived from the original message content:

- prefix: `Session · `
- value: normalized prompt preview
- strip extra whitespace, newlines, and mention noise
- keep within Feishu-safe title length

Examples:

- `Session · 重构 Feishu 面板交互`
- `Session · 修复 relay 重复回复`

## Duplicate-Reply Root Cause and Strategy

The repeated-reply problem is not just delivery rededuping. It comes from three separate causes.

### Cause 1: One user intent is represented twice

The launcher both mirrors the prompt into the session group and starts execution directly. Without explicit launch-state tracking, the mirrored group message can later be consumed as fresh input.

### Cause 2: UI emission is split across modules

`events.ts` and `runtime.ts` can both emit visible text/card messages. That makes it easy for a single user message to produce multiple visible outputs that feel redundant.

### Cause 3: Reply/send fallback lacks per-dispatch idempotency

Fallback behavior is useful, but visible messages still need a per-run idempotency boundary so retries cannot emit the same class of output twice.

### Strategy

Introduce a launch/presentation state layer that tracks:

- mirrored session-chat message ids
- per-user-message dispatch ids
- which visible message kinds have already been emitted for a dispatch

This makes the following rules enforceable:

- mirrored prompt messages never start a second run
- interrupt cards emit once per user message
- busy/final-output messages emit at most once per dispatch

## Data and State

### Session Chat Record

Keep the durable session-chat index focused on launch metadata:

- `sourceP2pChatId`
- `sourceMessageId`
- `sessionChatId`
- `creatorOpenId`
- `createdAt`
- `promptPreview`

### Launch State

Move transient launch and anti-duplication metadata into a dedicated Feishu-owned state module instead of overloading the session-chat record:

- recently mirrored message ids
- dispatch ids for in-flight or recently completed user messages
- emitted message kinds for each dispatch

This can live in `launch-state.ts` and remain adapter-local.

### Deprecated State

The main flow should stop depending on:

- `anchorMessageId`
- `lastKnownBackend`
- `lastKnownModel`
- `lastKnownEffort`
- `lastRunStatus`

Those fields only exist to support the persistent panel/anchor design and should be removed or retired from the primary path.

## File Boundary Proposal

### Keep and Slim

- `packages/feishu/src/events.ts`
- `packages/feishu/src/runtime.ts`

### Add

- `packages/feishu/src/launcher.ts`
- `packages/feishu/src/presentation.ts`
- `packages/feishu/src/session-flow.ts`
- `packages/feishu/src/launch-state.ts`
- `packages/feishu/src/naming.ts`

### Reshape

- `packages/feishu/src/cards.ts`
  - keep only the interrupt-card builders on the primary path
  - remove session-anchor and expanded control-panel responsibilities from the core flow
- `packages/feishu/src/session-chat.ts`
  - keep durable session-chat indexing
  - drop persistent-panel bookkeeping from the main model

## Error Handling

- If session-chat creation fails, reply in the private chat and stop
- If the native shared-chat card send fails, surface a clear launcher error instead of silently degrading to the old text receipt
- If the reference or mirrored prompt send fails after chat creation, report partial failure to the user
- If a run is already busy, presentation may emit one busy notice for that dispatch, but never more than one

## Testing Strategy

### Unit Tests

- session names normalize to `Session · {promptPreview}`
- launcher uses shared-chat messaging instead of text receipt
- launcher sends reference text before mirrored prompt text
- mirrored prompt ids are recorded and ignored on ingress
- session presentation emits one interrupt card per user message
- session presentation does not emit duplicate busy/final-output messages for the same dispatch

### Integration Tests

- private message creates a session chat, sends a native shared-chat card, posts reference + mirrored prompt, and starts exactly one run
- mirrored prompt delivery does not create a second run when its message event arrives later
- follow-up session messages produce one interrupt card and one final reply
- duplicate Feishu deliveries do not create duplicate visible responses
- interrupt action applies to the active conversation without reopening a persistent control surface

### Regression Tests

- attachment ingestion still works in private and session-chat paths
- `/done`, if preserved in this pass, still only applies inside the session chat
- reply fallback still works without emitting duplicate visible messages

## Acceptance Criteria

- Main Feishu chat receives a native shared-chat card after session creation
- New session chats are named `Session · {promptPreview}`
- New session chats receive a reference message plus a mirrored original prompt
- Mirrored prompt messages never cause a duplicate run
- Session chats do not use a persistent control panel or anchor card
- Each user message in a session chat shows one interrupt card
- The bot does not visibly answer the same user intent twice
- Feishu code structure is separated into router, launcher, presentation, and executor responsibilities
