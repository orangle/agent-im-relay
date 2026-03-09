# Discord Bot Mention Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the Discord relay accept explicit mentions from other bots, and ensure every visible reply to a bot-triggered run explicitly `@` mentions that bot.

**Architecture:** Keep the behavior scoped to `packages/discord`. Extract pure helpers for inbound routing and Discord reply payload construction, then thread a Discord-only reply context through the existing conversation, stream, and artifact send paths without expanding `@agent-im-relay/core`.

**Tech Stack:** TypeScript, discord.js v14, pnpm workspace, vitest

---

### Task 1: Extract inbound routing rules for bot-authored messages

**Files:**
- Create: `packages/discord/src/message-routing.ts`
- Create: `packages/discord/src/__tests__/message-routing.test.ts`
- Modify: `packages/discord/src/index.ts`

**Step 1: Write the failing test**

Add helper-level tests for:

- accepting a human-authored explicit mention
- accepting an other-bot explicit mention
- rejecting an other-bot message without an explicit relay mention
- rejecting a self-bot message
- stripping the relay mention from the prompt text

Example test shape:

```ts
expect(resolveInboundDiscordMessage({
  relayBotId: 'relay-bot',
  authorId: 'other-bot',
  authorBot: true,
  content: '<@relay-bot> summarize this',
  inGuild: true,
  inActiveThread: false,
})).toEqual({
  accepted: true,
  prompt: 'summarize this',
  explicitMention: true,
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/discord test -- src/__tests__/message-routing.test.ts`
Expected: FAIL because `message-routing.ts` does not exist yet.

**Step 3: Write minimal implementation**

Create `resolveInboundDiscordMessage()` and `extractMentionPrompt()` in `packages/discord/src/message-routing.ts`, then update `packages/discord/src/index.ts` to use the helper instead of the current top-level `message.author.bot` short-circuit.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/discord test -- src/__tests__/message-routing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/discord/src/message-routing.ts packages/discord/src/__tests__/message-routing.test.ts packages/discord/src/index.ts
git commit -m "test(discord): cover explicit bot mention routing"
```

### Task 2: Add a Discord reply-context helper for bot mentions

**Files:**
- Create: `packages/discord/src/reply-context.ts`
- Create: `packages/discord/src/__tests__/reply-context.test.ts`
- Modify: `packages/discord/src/stream.ts`
- Modify: `packages/discord/src/__tests__/stream.test.ts`

**Step 1: Write the failing test**

Add helper-level tests for:

- deriving a reply context from a trigger authored by another bot
- returning no mention context for human triggers
- building a Discord send payload that prepends exactly one `<@botId>` mention
- scoping `allowedMentions.users` to the targeted bot only

Add a stream regression test asserting the first visible send in a bot-triggered run includes the mention and later edits do not duplicate it.

Example helper target:

```ts
expect(buildDiscordReplyPayload('Done', {
  mentionUserId: 'other-bot',
})).toEqual({
  content: '<@other-bot> Done',
  allowedMentions: { users: ['other-bot'] },
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/discord test -- src/__tests__/reply-context.test.ts src/__tests__/stream.test.ts`
Expected: FAIL because the reply-context helper and stream support do not exist yet.

**Step 3: Write minimal implementation**

Create `DiscordReplyContext`, `createDiscordReplyContext()`, and `buildDiscordReplyPayload()` in `packages/discord/src/reply-context.ts`. Update `packages/discord/src/stream.ts` so the first visible `channel.send()` for a bot-triggered run uses the helper payload, while later `edit()` calls continue to update only the rendered body.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/discord test -- src/__tests__/reply-context.test.ts src/__tests__/stream.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/discord/src/reply-context.ts packages/discord/src/__tests__/reply-context.test.ts packages/discord/src/stream.ts packages/discord/src/__tests__/stream.test.ts
git commit -m "feat(discord): add bot reply mention context"
```

### Task 3: Plumb reply context through conversations, artifacts, and fallback sends

**Files:**
- Modify: `packages/discord/src/conversation.ts`
- Modify: `packages/discord/src/index.ts`
- Modify: `packages/discord/src/artifacts.ts`
- Modify: `packages/discord/src/__tests__/conversation.test.ts`
- Modify: `packages/discord/src/__tests__/artifacts.test.ts`

**Step 1: Write the failing test**

Add regression coverage for:

- `runMentionConversation()` passing reply context into `streamAgentToDiscord()` and `publishConversationArtifacts()`
- `publishConversationArtifacts()` mentioning the triggering bot on artifact uploads and warnings
- `packages/discord/src/index.ts` fallback/error send paths using mention-aware payloads when the trigger author is another bot

Example conversation expectation:

```ts
expect(streamAgentToDiscord).toHaveBeenCalledWith(
  expect.objectContaining({
    replyContext: { mentionUserId: 'other-bot' },
  }),
  expect.any(Object),
);
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-im-relay/discord test -- src/__tests__/conversation.test.ts src/__tests__/artifacts.test.ts`
Expected: FAIL because conversation and artifact paths do not accept reply context yet.

**Step 3: Write minimal implementation**

Extend `runMentionConversation()` options with a Discord-only `replyContext`. Thread that into `streamAgentToDiscord()` and `publishConversationArtifacts()`. Replace direct `message.reply(...)` fallback/error paths in `packages/discord/src/index.ts` with helper-driven `message.channel.send(...)` payloads so bot-triggered runs always emit an explicit mention without relying on Discord reply references.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-im-relay/discord test -- src/__tests__/conversation.test.ts src/__tests__/artifacts.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/discord/src/conversation.ts packages/discord/src/index.ts packages/discord/src/artifacts.ts packages/discord/src/__tests__/conversation.test.ts packages/discord/src/__tests__/artifacts.test.ts
git commit -m "feat(discord): mention bots across reply paths"
```

### Task 4: Run full Discord verification

**Files:**
- Modify as needed based on verification findings

**Step 1: Run package tests**

Run: `pnpm --filter @agent-im-relay/discord test`
Expected: PASS

**Step 2: Run workspace build verification**

Run: `pnpm build`
Expected: PASS

**Step 3: Manual smoke check**

Run the Discord relay against a test guild and verify:

- another bot must explicitly `@relay` to trigger a run
- a non-mentioned bot message is ignored
- the first visible reply to a bot-triggered run includes exactly one mention of that bot
- artifact uploads and error/warning follow-ups also mention the triggering bot

**Step 4: Commit**

```bash
git add packages/discord
git commit -m "fix(discord): support explicit bot mentions"
```
