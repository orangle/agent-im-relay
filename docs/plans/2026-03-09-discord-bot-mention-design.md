# Discord Bot Mention Design

**Context**

Discord inbound handling in `packages/discord/src/index.ts` currently drops all bot-authored messages via `if (message.author.bot || !message.inGuild()) return;`. That prevents relay-to-bot workflows entirely, even when another bot explicitly mentions the relay. On the outbound side, Discord send paths do not carry any reply/mention context, so streamed replies, artifact uploads, warnings, and error messages cannot consistently `@` the originating bot.

**Decision**

Keep the change scoped to `packages/discord` and preserve the existing `@agent-im-relay/core` conversation contract.

The Discord adapter will:

- continue ignoring messages from the relay bot itself
- allow messages from other bots only when they explicitly mention the relay bot
- keep ignoring non-mentioned bot messages, including ordinary bot chatter inside active relay threads
- derive a Discord-only reply context when the trigger author is another bot
- apply that reply context to the first visible outbound reply and all follow-up standalone sends in the same run
- restrict Discord mentions with `allowedMentions.users = [botId]` so only the intended bot is pinged

**Why this shape**

- the requested behavior is Discord-specific; pushing `<@...>` mention semantics into `core` would broaden the change without clear reuse
- explicit-mention-only gating avoids accidental bot loops while still enabling bot-to-bot invocation
- a shared Discord reply-context helper keeps stream output, artifacts, warnings, and error replies aligned instead of relying on ad hoc string prepends

**Testing**

Add regression coverage in `packages/discord/src/__tests__` for:

- inbound routing only accepting other-bot messages when they explicitly mention the relay
- self-bot messages still being ignored
- streamed replies prepending a single bot mention on the first visible send while avoiding duplicated mentions on later edits
- artifact uploads, warnings, and direct fallback/error replies also mentioning the originating bot when the run was triggered by a bot
