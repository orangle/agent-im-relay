# Feishu Session Presentation Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the Feishu adapter around explicit router, launcher, presentation, and executor layers so private-chat launches use native shared-chat cards, session groups use one-shot interrupt cards, and the same user intent is never answered twice.

**Architecture:** Keep core conversation execution in `@agent-im-relay/core`, but move Feishu-visible UX policy out of `events.ts` and `runtime.ts`. Add a launcher service for private-chat session creation, a presentation layer for session-chat output policy, a launch-state module for mirrored-message and dispatch idempotency, and a thinner runtime/session-flow execution path.

**Tech Stack:** TypeScript, Node.js, pnpm workspace, `@larksuiteoapi/node-sdk`, existing `@agent-im-relay/core`, Vitest, tsdown

---

### Task 1: Add naming and launch-state primitives for session launch identity

**Files:**
- Create: `packages/feishu/src/naming.ts`
- Create: `packages/feishu/src/launch-state.ts`
- Create: `packages/feishu/src/__tests__/naming.test.ts`
- Create: `packages/feishu/src/__tests__/launch-state.test.ts`
- Modify: `packages/feishu/src/index.ts`

**Step 1: Write the failing test**

- Add naming tests that assert prompts normalize into titles like `Session · 重构 Feishu 面板交互`
- Add launch-state tests that assert mirrored message ids can be remembered, recognized once, and expired/cleared
- Add dispatch tests that assert a message kind such as `interrupt-card` or `final-output` can only be emitted once per dispatch id

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/naming.test.ts src/__tests__/launch-state.test.ts`
Expected: FAIL because the naming and launch-state modules do not exist yet.

**Step 3: Write minimal implementation**

Add helpers with a narrow surface such as:

```ts
export function buildFeishuSessionChatName(prompt: string): string {
  return `Session · ${normalizePromptPreview(prompt)}`;
}

export function rememberMirroredMessageId(messageId: string): void {}
export function isMirroredMessageId(messageId: string): boolean {}
export function beginDispatch(messageId: string): { dispatchId: string } {}
export function markDispatchMessageEmitted(dispatchId: string, kind: 'interrupt-card' | 'busy' | 'final-output'): boolean {}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/naming.test.ts src/__tests__/launch-state.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/feishu/src/naming.ts packages/feishu/src/launch-state.ts packages/feishu/src/__tests__/naming.test.ts packages/feishu/src/__tests__/launch-state.test.ts packages/feishu/src/index.ts
git commit -m "feat(feishu): add launch naming and dispatch state"
```

### Task 2: Extend the Feishu API client with native shared-chat messaging

**Files:**
- Modify: `packages/feishu/src/api.ts`
- Modify: `packages/feishu/src/__tests__/api.test.ts`

**Step 1: Write the failing test**

- Add API tests that assert the client can send a native shared-chat message to a chat id
- Keep the existing text/card/file helpers green
- Assert the outgoing request uses the dedicated shared-chat message payload instead of the old text receipt

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/api.test.ts`
Expected: FAIL because the client only knows how to send text, interactive card, and file messages.

**Step 3: Write minimal implementation**

Add a dedicated helper instead of overloading `sendPrivateChatIndexMessage()`:

```ts
async function sendSharedChatMessage(options: {
  receiveId: string;
  chatId: string;
}): Promise<string | undefined> {
  return sendMessage({
    receiveId: options.receiveId,
    receiveIdType: 'chat_id',
    msgType: 'share_chat',
    content: JSON.stringify({ chat_id: options.chatId }),
  });
}
```

Rename or remove the old private-chat index helper once the new path is green.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/api.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/feishu/src/api.ts packages/feishu/src/__tests__/api.test.ts
git commit -m "feat(feishu): add native shared chat messaging"
```

### Task 3: Extract a dedicated launcher service for private-chat session creation

**Files:**
- Create: `packages/feishu/src/launcher.ts`
- Create: `packages/feishu/src/__tests__/launcher.test.ts`
- Modify: `packages/feishu/src/session-chat.ts`
- Modify: `packages/feishu/src/index.ts`

**Step 1: Write the failing test**

- Add launcher tests that assert a private-chat launch:
  - creates a session chat named from the original prompt
  - persists the durable session-chat record
  - sends the native shared-chat message to the source private chat
  - sends a reference text into the session group
  - mirrors the original prompt into the session group
- Assert the launcher returns the mirrored message id so ingress can suppress it later

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/launcher.test.ts src/__tests__/session-chat.test.ts`
Expected: FAIL because the launcher service does not exist and session-chat state does not track the new launch handoff requirements.

**Step 3: Write minimal implementation**

Create a launcher with a narrow result contract:

```ts
export type FeishuLaunchResult = {
  sessionChatId: string;
  mirroredMessageId?: string;
  prompt: string;
  mode: 'code' | 'ask';
};

export async function launchFeishuSessionFromPrivateChat(/* deps */): Promise<FeishuLaunchResult> {}
```

Keep `session-chat.ts` focused on durable mapping data only. Do not add anchor or panel fields back into this path.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/launcher.test.ts src/__tests__/session-chat.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/feishu/src/launcher.ts packages/feishu/src/__tests__/launcher.test.ts packages/feishu/src/session-chat.ts packages/feishu/src/index.ts
git commit -m "feat(feishu): add private chat launcher service"
```

### Task 4: Replace anchor/panel UI with one-shot interrupt presentation

**Files:**
- Create: `packages/feishu/src/presentation.ts`
- Create: `packages/feishu/src/__tests__/presentation.test.ts`
- Modify: `packages/feishu/src/cards.ts`
- Modify: `packages/feishu/src/__tests__/cards.test.ts`
- Modify: `packages/feishu/src/__tests__/actions.test.ts`

**Step 1: Write the failing test**

- Add presentation tests that assert each user message can emit exactly one interrupt card and one final-output message per dispatch id
- Rewrite card tests to remove the session-anchor/control-panel assertions from the primary path
- Keep action tests focused on `interrupt` only for the Feishu UI surface

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/presentation.test.ts src/__tests__/cards.test.ts src/__tests__/actions.test.ts`
Expected: FAIL because the adapter still builds and expects persistent panel/anchor cards.

**Step 3: Write minimal implementation**

Reduce `cards.ts` to a smaller surface like:

```ts
export function buildFeishuInterruptCardPayload(context: FeishuCardContext): Record<string, unknown> {
  return {
    schema: '2.0',
    header: { title: plainText('Session Controls') },
    body: { elements: [button('Interrupt', context, 'interrupt', {}, 'primary')] },
  };
}
```

In `presentation.ts`, own idempotent emission:

```ts
export async function presentInterruptCard(/* deps */): Promise<void> {}
export async function presentFinalOutput(/* deps */): Promise<void> {}
export async function presentBusyNotice(/* deps */): Promise<void> {}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/presentation.test.ts src/__tests__/cards.test.ts src/__tests__/actions.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/feishu/src/presentation.ts packages/feishu/src/__tests__/presentation.test.ts packages/feishu/src/cards.ts packages/feishu/src/__tests__/cards.test.ts packages/feishu/src/__tests__/actions.test.ts
git commit -m "refactor(feishu): replace persistent controls with interrupt presentation"
```

### Task 5: Refactor runtime into executor-only wiring and add session flow orchestration

**Files:**
- Create: `packages/feishu/src/session-flow.ts`
- Create: `packages/feishu/src/__tests__/session-flow.test.ts`
- Modify: `packages/feishu/src/runtime.ts`
- Modify: `packages/feishu/src/__tests__/runtime.test.ts`
- Modify: `packages/feishu/src/__tests__/session-chat.test.ts`

**Step 1: Write the failing test**

- Update runtime tests to assert that starting a run no longer emits `Starting run…`, anchor cards, or expanded control panels
- Add session-flow tests that assert a normal session message:
  - opens one dispatch id
  - shows one interrupt card
  - starts one run
  - publishes one final answer
- Add a busy-path test that asserts the busy notice is emitted once at most

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/runtime.test.ts src/__tests__/session-flow.test.ts src/__tests__/session-chat.test.ts`
Expected: FAIL because `runtime.ts` still owns startup text, anchor refresh, and control-panel emission.

**Step 3: Write minimal implementation**

Shrink `runFeishuConversation()` so it executes and reports lifecycle only:

```ts
export type FeishuConversationLifecycle = {
  onBusy?(): Promise<void>;
  onFinalOutput?(text: string): Promise<void>;
  onError?(message: string): Promise<void>;
};
```

Then add `session-flow.ts` to orchestrate:

```ts
await presentInterruptCard(...)
const result = await runFeishuConversation(...)
if (result.kind === 'busy') await presentBusyNotice(...)
```

Do not reintroduce anchor refresh behavior.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/runtime.test.ts src/__tests__/session-flow.test.ts src/__tests__/session-chat.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/feishu/src/session-flow.ts packages/feishu/src/__tests__/session-flow.test.ts packages/feishu/src/runtime.ts packages/feishu/src/__tests__/runtime.test.ts packages/feishu/src/__tests__/session-chat.test.ts
git commit -m "refactor(feishu): separate session flow from executor runtime"
```

### Task 6: Rewire ingress to use launcher and session flow, and suppress mirrored prompt reentry

**Files:**
- Modify: `packages/feishu/src/events.ts`
- Modify: `packages/feishu/src/conversation.ts`
- Modify: `packages/feishu/src/__tests__/events.test.ts`
- Modify: `packages/feishu/src/__tests__/conversation.test.ts`

**Step 1: Write the failing test**

- Extend event tests to assert that:
  - private-chat launches call `launcher.ts` instead of assembling the flow inline
  - the session group receives reference + mirrored prompt and only one run starts
  - a later inbound event for the mirrored prompt message id is ignored
  - session-chat follow-up messages run through `session-flow.ts`
- Update conversation tests if message parsing or mention rules change around mirrored messages

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/events.test.ts src/__tests__/conversation.test.ts`
Expected: FAIL because ingress still contains inline launch logic and does not know about mirrored message suppression.

**Step 3: Write minimal implementation**

- Make `events.ts` the thin router described in the design
- Delegate private-chat launches to `launchFeishuSessionFromPrivateChat()`
- Delegate session messages to `runFeishuSessionFlow()`
- Check `isMirroredMessageId(message.message_id)` before processing session-group messages
- Remove or demote menu-first persistent-control entry points from the main session path

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/events.test.ts src/__tests__/conversation.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/feishu/src/events.ts packages/feishu/src/conversation.ts packages/feishu/src/__tests__/events.test.ts packages/feishu/src/__tests__/conversation.test.ts
git commit -m "refactor(feishu): route ingress through launcher and session flow"
```

### Task 7: Remove persistent-panel state and run full verification

**Files:**
- Modify: `packages/feishu/src/session-chat.ts`
- Modify: `packages/feishu/src/index.ts`
- Modify: `packages/feishu/src/__tests__/session-chat.test.ts`
- Modify: `README.md`

**Step 1: Write the failing test**

- Update session-chat tests so the durable record only keeps launch/index metadata
- Remove assertions that depend on `anchorMessageId`, `lastKnownBackend`, `lastKnownModel`, `lastKnownEffort`, or `lastRunStatus`
- Add a small README regression if the documented Feishu flow still mentions menu-first/session-anchor behavior

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/feishu test -- --run src/__tests__/session-chat.test.ts`
Expected: FAIL because the old persistent-panel fields are still present in the durable model or public exports.

**Step 3: Write minimal implementation**

- Remove the anchor/panel-centric fields and exports
- Keep the session-chat record durable, small, and launch-oriented
- Update README wording so the published Feishu flow matches the new launcher/reference/interrupt-card UX

**Step 4: Run test to verify it passes**

Run:

- `pnpm --filter @agent-im-relay/feishu test`
- `pnpm --filter @agent-im-relay/core test`
- `pnpm --filter @agent-im-relay/feishu build`

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/feishu/src/session-chat.ts packages/feishu/src/index.ts packages/feishu/src/__tests__/session-chat.test.ts README.md
git commit -m "refactor(feishu): remove persistent session panel state"
```

### Task 8: Run workspace-level verification and final behavioral check

**Files:**
- Modify: `docs/plans/2026-03-09-feishu-session-presentation-refactor-design.md`

**Step 1: Run workspace verification**

Run:

- `pnpm test`
- `pnpm build`

Expected: PASS.

**Step 2: Compare implementation against acceptance criteria**

Verify line by line that:

- private chat gets a native shared-chat card
- session chat name is `Session · {promptPreview}`
- session chat receives reference + mirrored prompt
- mirrored prompt does not start a second run
- each user message gets one interrupt card
- no persistent anchor/panel remains in the main path
- duplicate visible answers are suppressed

**Step 3: Update design doc status if needed**

- only touch the design doc if the final implementation intentionally diverged
- otherwise keep the approved design as-is

**Step 4: Re-run targeted Feishu verification if any step changed behavior**

Run: `pnpm --filter @agent-im-relay/feishu test`
Expected: PASS.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-09-feishu-session-presentation-refactor-design.md
git commit -m "test: verify feishu session presentation refactor"
```
