import { describe, expect, it } from 'vitest';
import { formatFeishuMarkdownCards } from '../formatting.js';

function extractCardMarkdownContents(card: Record<string, unknown>): string[] {
  const body = (card as { body?: { elements?: Array<{ tag?: string; content?: string }> } }).body;
  const elements = body?.elements ?? [];
  return elements
    .filter(element => element.tag === 'markdown' && typeof element.content === 'string')
    .map(element => element.content ?? '')
    .filter(Boolean);
}

describe('Feishu rich text formatting', () => {
  it('formats structured markdown-like output into post paragraphs', () => {
    const result = formatFeishuMarkdownCards([
      '# Summary',
      '',
      '第一段需要单独成段，不能和后面的列表糊在一起。',
      '',
      '- 保留列表结构',
      '- 让长消息更容易扫读',
      '',
      '> 引用内容也要保留层次',
      '> 不要和正文混成一段',
      '',
      'Design:',
      '保持 `packages/feishu` 本地实现。',
    ].join('\n'));

    expect(result).toHaveLength(1);
    expect(extractCardMarkdownContents(result[0]!.card)).toEqual([
      '# Summary',
      '第一段需要单独成段，不能和后面的列表糊在一起。',
      '- 保留列表结构\n- 让长消息更容易扫读',
      '> 引用内容也要保留层次\n> 不要和正文混成一段',
      'Design:\n保持 `packages/feishu` 本地实现。',
    ]);
  });

  it('keeps fenced code blocks in markdown cards', () => {
    const source = [
      '先看实现：',
      '',
      '```ts',
      'console.log("hello")',
      '```',
    ].join('\n');

    const result = formatFeishuMarkdownCards(source);
    expect(result).toHaveLength(1);
    expect(extractCardMarkdownContents(result[0]!.card)).toEqual([
      '先看实现：',
      '```ts\nconsole.log("hello")\n```',
    ]);
  });
});
