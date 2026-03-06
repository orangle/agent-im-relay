import type { Message } from 'discord.js';
import type { AgentStreamEvent } from '../agent/session.js';
import { config } from '../config.js';

export type StreamTargetChannel = {
  send(content: string): Promise<Message<boolean>>;
};

type StreamToDiscordOptions = {
  channel: StreamTargetChannel;
  initialMessage?: Message<boolean>;
};

// --- Tool display formatting ---

const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Write: '✏️',
  Edit: '✏️',
  MultiEdit: '✏️',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔍',
  LS: '📂',
  WebSearch: '🌐',
  WebFetch: '🌐',
  TodoRead: '📋',
  TodoWrite: '📋',
};

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? '🔧';
}

function formatToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const obj = input as Record<string, unknown>;

  if (name === 'Bash' && typeof obj.command === 'string') {
    const cmd = obj.command.length > 120 ? obj.command.slice(0, 117) + '...' : obj.command;
    return `\`${cmd}\``;
  }

  if ((name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit') && typeof obj.file_path === 'string') {
    return `\`${obj.file_path}\``;
  }

  if (name === 'Grep' && typeof obj.pattern === 'string') {
    const path = typeof obj.path === 'string' ? ` in \`${obj.path}\`` : '';
    return `\`${obj.pattern}\`${path}`;
  }

  if (name === 'Glob' && typeof obj.pattern === 'string') {
    return `\`${obj.pattern}\``;
  }

  if ((name === 'WebSearch' || name === 'WebFetch') && typeof obj.url === 'string') {
    return `<${obj.url}>`;
  }

  return '';
}

export function formatToolLine(summary: string): string {
  // Parse "running ToolName {...}" format from session.ts
  const match = summary.match(/^running (\w+)\s*(.*)/s);
  if (!match) {
    return `> 🔧 ${summary.length > 200 ? summary.slice(0, 197) + '...' : summary}`;
  }

  const name = match[1]!;
  const icon = getToolIcon(name);
  const rawInput = match[2]?.trim();

  let detail = '';
  if (rawInput) {
    try {
      const parsed = JSON.parse(rawInput);
      detail = formatToolInput(name, parsed);
    } catch {
      detail = rawInput.length > 150 ? rawInput.slice(0, 147) + '...' : rawInput;
    }
  }

  return detail ? `> ${icon} **${name}** ${detail}` : `> ${icon} **${name}**`;
}

// --- Chunking ---

export function chunkForDiscord(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at a double newline (paragraph boundary)
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex < Math.floor(maxLength * 0.4)) {
      // Fall back to single newline
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIndex < Math.floor(maxLength * 0.4)) {
      splitIndex = maxLength;
    }

    // Don't split inside a code block - find the fence boundary
    const chunk = remaining.slice(0, splitIndex);
    const openFences = (chunk.match(/```/g) ?? []).length;
    if (openFences % 2 !== 0) {
      // Unclosed code block - close it in this chunk and reopen in next
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

function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith('```');
}

function parseTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return null;
  }

  let content = trimmed;
  if (content.startsWith('|')) {
    content = content.slice(1);
  }
  if (content.endsWith('|')) {
    content = content.slice(0, -1);
  }

  const cells = content.split('|').map(cell => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isTableSeparatorLine(line: string, columnCount: number): boolean {
  const cells = parseTableCells(line);
  if (!cells || cells.length !== columnCount) {
    return false;
  }

  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function formatTableRow(headers: string[], values: string[]): string {
  return `- ${headers
    .map((header, index) => `**${header}**: ${values[index] ?? ''}`)
    .join(' | ')}`;
}

export function convertMarkdownForDiscord(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let index = 0;
  let inFence = false;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (isFenceLine(line)) {
      output.push(line);
      inFence = !inFence;
      index += 1;
      continue;
    }

    if (inFence) {
      output.push(line);
      index += 1;
      continue;
    }

    const headerCells = parseTableCells(line);
    const separatorLine = lines[index + 1];
    if (
      headerCells
      && separatorLine !== undefined
      && isTableSeparatorLine(separatorLine, headerCells.length)
    ) {
      const tableRows: string[][] = [];
      let rowIndex = index + 2;

      while (rowIndex < lines.length) {
        const rowLine = lines[rowIndex] ?? '';
        if (isFenceLine(rowLine)) {
          break;
        }

        const rowCells = parseTableCells(rowLine);
        if (!rowCells) {
          break;
        }

        tableRows.push(rowCells);
        rowIndex += 1;
      }

      if (tableRows.length > 0) {
        for (const row of tableRows) {
          output.push(formatTableRow(headerCells, row));
        }
        index = rowIndex;
        continue;
      }
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      if (output.length > 0 && output[output.length - 1] !== '') {
        output.push('');
      }
      output.push(`**${headingMatch[2] ?? ''}**`);
      index += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      if (output.length > 0 && output[output.length - 1] !== '') {
        output.push('');
      }
      index += 1;
      continue;
    }

    output.push(line);
    index += 1;
  }

  return output.join('\n');
}

// --- Streaming ---

export async function streamAgentToDiscord(
  options: StreamToDiscordOptions,
  events: AsyncIterable<AgentStreamEvent>,
): Promise<void> {
  const messages: Message<boolean>[] = [];
  if (options.initialMessage) {
    messages.push(options.initialMessage);
  }

  let buffer = '';
  let lastFlush = 0;
  let renderedChunks: string[] = [];
  let toolCount = 0;
  let isThinking = false;
  const maxLength = Math.max(200, config.discordMessageCharLimit);

  const flush = async (): Promise<void> => {
    const body = buffer.trim() || '⏳ Thinking...';
    const convertedBody = convertMarkdownForDiscord(body);
    const chunks = chunkForDiscord(convertedBody, maxLength);

    if (messages.length === 0) {
      const first = await options.channel.send(chunks[0] ?? '⏳ Thinking...');
      messages.push(first);
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? '';
      const current = messages[index];
      const previous = renderedChunks[index];

      if (!current) {
        const next = await options.channel.send(chunk || '…');
        messages.push(next);
        continue;
      }

      if (chunk !== previous) {
        await current.edit(chunk || '…').catch(() => {
          // Silently ignore edit failures (rate limits, deleted messages)
        });
      }
    }

    renderedChunks = chunks;
    lastFlush = Date.now();
  };

  for await (const event of events) {
    if (event.type === 'text') {
      if (isThinking) {
        isThinking = false;
      }
      buffer += event.delta;
    } else if (event.type === 'tool') {
      toolCount++;
      buffer += '\n' + formatToolLine(event.summary) + '\n';
    } else if (event.type === 'status') {
      // Show thinking/status as subtle indicator, don't spam
      if (!isThinking && !buffer.trim()) {
        isThinking = true;
        buffer = '⏳ *' + event.status + '*';
      }
    } else if (event.type === 'error') {
      buffer += `\n\n❌ **Error:** ${event.error}\n`;
    } else if (event.type === 'done') {
      if (!buffer.trim() && event.result) {
        buffer = event.result;
      }
      // Append tool count summary if tools were used
      if (toolCount > 0) {
        buffer += `\n-# 🔧 ${toolCount} tool${toolCount > 1 ? 's' : ''} used`;
      }
    }

    if (Date.now() - lastFlush >= config.streamUpdateIntervalMs) {
      await flush();
    }
  }

  await flush();
}
