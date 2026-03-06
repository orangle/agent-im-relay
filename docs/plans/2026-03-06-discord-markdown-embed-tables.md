# Discord Markdown Embed Tables Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update Discord markdown rendering so headings stay native, markdown tables become Discord embeds when possible, and streaming sends/edit payloads with embeds.

**Architecture:** Keep `convertMarkdownForDiscord` as the single preprocessing entry point, but make it return structured output with plain text plus extracted embed metadata. Detect tables outside fenced code, remove them from message text, transform 2-3 column tables into inline embed fields, and fall back to a code block for wider tables. Update stream flushing to reuse the returned embeds during sends and edits.

**Tech Stack:** TypeScript, Discord.js message APIs, Vitest

---

### Task 1: Update markdown conversion contract

**Files:**
- Modify: `src/discord/stream.ts`
- Test: `src/discord/__tests__/stream.test.ts`

**Step 1:** Update `convertMarkdownForDiscord` to return `{ text, embeds }` and add a local `EmbedData` type.
**Step 2:** Keep headings unchanged and preserve existing horizontal-rule removal.
**Step 3:** Extract markdown tables outside fences into embed data; remove table text from output.
**Step 4:** Render 4+ column tables as aligned code blocks in `text`.

### Task 2: Update streaming message payloads

**Files:**
- Modify: `src/discord/stream.ts`

**Step 1:** Widen `StreamTargetChannel.send` to accept string or `{ content, embeds }`.
**Step 2:** Update flush logic to send/edit Discord messages with content plus embeds on the first chunk.
**Step 3:** Keep chunking behavior for text and avoid attaching embeds to follow-up chunks.

### Task 3: Refresh tests and verify

**Files:**
- Modify: `src/discord/__tests__/stream.test.ts`

**Step 1:** Replace heading conversion coverage with native-heading pass-through coverage.
**Step 2:** Assert two-column tables produce embed fields and no inline table text.
**Step 3:** Keep HR and fenced-code preservation coverage.
**Step 4:** Add wide-table fallback coverage and run `pnpm test`.
