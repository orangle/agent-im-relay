import { stripArtifactManifest } from '@agent-im-relay/core';

export type FeishuFormattedCardMessage = {
  card: Record<string, unknown>;
  byteLength: number;
};

export const FEISHU_CARD_PAYLOAD_LIMIT_BYTES = 24 * 1024;
export const FEISHU_CARD_MAX_COUNT = 8;

const CODE_FENCE_PATTERN = /^```/;

type MarkdownBlock =
  | { kind: 'text'; lines: string[] }
  | { kind: 'code'; language: string; lines: string[] };

function normalizeInput(text: string): string {
  return stripArtifactManifest(text.replace(/\r\n/g, '\n')).trim();
}

export function normalizeFeishuMarkdownOutput(text: string): string {
  return normalizeInput(text);
}

function buildMarkdownCard(elements: string[], title?: string): Record<string, unknown> {
  const body = {
    elements: elements.map(content => ({
      tag: 'markdown',
      content,
    })),
  };

  if (!title) {
    return {
      schema: '2.0',
      body,
    };
  }

  return {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body,
  };
}

function cardByteLength(elements: string[], title?: string): number {
  return Buffer.byteLength(JSON.stringify(buildMarkdownCard(elements, title)), 'utf8');
}

function buildMarkdownFromBlock(block: MarkdownBlock): string {
  if (block.kind === 'code') {
    const fence = block.language ? `\`\`\`${block.language}` : '```';
    return [fence, ...block.lines, '```'].join('\n');
  }

  return block.lines.join('\n');
}

function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');
  let textLines: string[] = [];
  let inCodeBlock = false;
  let codeLanguage = '';
  let codeLines: string[] = [];

  const flushText = () => {
    if (textLines.length === 0) {
      return;
    }
    blocks.push({ kind: 'text', lines: textLines });
    textLines = [];
  };

  const flushCode = () => {
    if (codeLines.length === 0) {
      return;
    }
    blocks.push({ kind: 'code', language: codeLanguage, lines: codeLines });
    codeLines = [];
    codeLanguage = '';
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (CODE_FENCE_PATTERN.test(trimmed)) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        flushText();
        inCodeBlock = true;
        codeLanguage = trimmed.replace(CODE_FENCE_PATTERN, '').trim();
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine.replace(/\s+$/, ''));
      continue;
    }

    if (!trimmed) {
      flushText();
      continue;
    }

    textLines.push(rawLine.replace(/\s+$/, ''));
  }

  if (inCodeBlock) {
    flushCode();
  }
  flushText();

  return blocks;
}

function splitLineByFit(line: string, fits: (value: string) => boolean): string[] {
  if (fits(line)) {
    return [line];
  }

  const chunks: string[] = [];
  let remaining = line;

  while (remaining) {
    if (fits(remaining)) {
      chunks.push(remaining);
      break;
    }

    let low = 1;
    let high = remaining.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(remaining.slice(0, mid))) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    const slice = remaining.slice(0, low);
    if (!slice) {
      chunks.push(remaining.slice(0, 1));
      remaining = remaining.slice(1).trimStart();
      continue;
    }

    chunks.push(slice);
    remaining = remaining.slice(slice.length).trimStart();
  }

  return chunks;
}

function splitTextBlock(block: MarkdownBlock & { kind: 'text' }, limit: number): MarkdownBlock[] {
  const result: MarkdownBlock[] = [];
  let current: string[] = [];

  const fits = (lines: string[]) => cardByteLength([lines.join('\n')]) <= limit;

  const flushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    result.push({ kind: 'text', lines: current });
    current = [];
  };

  for (const line of block.lines) {
    if (current.length === 0) {
      if (fits([line])) {
        current = [line];
      } else {
        const split = splitLineByFit(line, value => fits([value]));
        for (const chunk of split) {
          result.push({ kind: 'text', lines: [chunk] });
        }
      }
      continue;
    }

    if (fits([...current, line])) {
      current.push(line);
      continue;
    }

    flushCurrent();
    if (fits([line])) {
      current = [line];
    } else {
      const split = splitLineByFit(line, value => fits([value]));
      for (const chunk of split) {
        result.push({ kind: 'text', lines: [chunk] });
      }
    }
  }

  flushCurrent();
  return result;
}

function splitCodeBlock(block: MarkdownBlock & { kind: 'code' }, limit: number): MarkdownBlock[] {
  const result: MarkdownBlock[] = [];
  let current: string[] = [];

  const fits = (lines: string[]) => {
    const markdown = buildMarkdownFromBlock({ kind: 'code', language: block.language, lines });
    return cardByteLength([markdown]) <= limit;
  };

  const flushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    result.push({ kind: 'code', language: block.language, lines: current });
    current = [];
  };

  for (const line of block.lines) {
    if (current.length === 0) {
      if (fits([line])) {
        current = [line];
      } else {
        const split = splitLineByFit(line, value => fits([value]));
        for (const chunk of split) {
          result.push({ kind: 'code', language: block.language, lines: [chunk] });
        }
      }
      continue;
    }

    if (fits([...current, line])) {
      current.push(line);
      continue;
    }

    flushCurrent();
    if (fits([line])) {
      current = [line];
    } else {
      const split = splitLineByFit(line, value => fits([value]));
      for (const chunk of split) {
        result.push({ kind: 'code', language: block.language, lines: [chunk] });
      }
    }
  }

  flushCurrent();
  return result;
}

function ensureBlockFits(block: MarkdownBlock, limit: number): MarkdownBlock[] {
  const markdown = buildMarkdownFromBlock(block);
  if (cardByteLength([markdown]) <= limit) {
    return [block];
  }

  if (block.kind === 'code') {
    return splitCodeBlock(block, limit);
  }

  return splitTextBlock(block, limit);
}

export function formatFeishuMarkdownCards(text: string): FeishuFormattedCardMessage[] {
  const normalized = normalizeInput(text);
  if (!normalized) {
    return [];
  }

  const blocks = splitMarkdownBlocks(normalized)
    .flatMap(block => ensureBlockFits(block, FEISHU_CARD_PAYLOAD_LIMIT_BYTES));

  const cards: FeishuFormattedCardMessage[] = [];
  let currentElements: string[] = [];

  const flushCurrent = () => {
    if (currentElements.length === 0) {
      return;
    }
    cards.push({
      card: buildMarkdownCard(currentElements),
      byteLength: cardByteLength(currentElements),
    });
    currentElements = [];
  };

  for (const block of blocks) {
    const markdown = buildMarkdownFromBlock(block);
    if (currentElements.length === 0) {
      currentElements = [markdown];
      continue;
    }

    const nextElements = [...currentElements, markdown];
    if (cardByteLength(nextElements) > FEISHU_CARD_PAYLOAD_LIMIT_BYTES) {
      flushCurrent();
      currentElements = [markdown];
      continue;
    }

    currentElements = nextElements;
  }

  flushCurrent();
  return cards;
}

export function buildFeishuMarkdownCardPayload(content: string, title?: string): Record<string, unknown> {
  return buildMarkdownCard([content], title);
}

export function buildFeishuFileSummaryCardPayload(options: {
  title: string;
  intro: string;
  files: string[];
  note?: string;
}): Record<string, unknown> {
  const lines = [
    options.intro,
    '',
    '文件列表：',
    ...options.files.map(file => `- ${file}`),
  ];

  if (options.note) {
    lines.push('', options.note);
  }

  return buildMarkdownCard([lines.join('\n')], options.title);
}
