import { describe, expect, it } from 'vitest';
import {
  chunkForDiscord,
  convertMarkdownForDiscord,
  formatToolLine,
  getToolIcon,
} from '../stream.js';

describe('chunkForDiscord', () => {
  it('splits text at sensible boundaries', () => {
    const text = `${'A'.repeat(60)}\n\n${'B'.repeat(60)}`;
    const chunks = chunkForDiscord(text, 100);

    expect(chunks).toEqual(['A'.repeat(60), 'B'.repeat(60)]);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it('preserves fenced code blocks across chunk boundaries', () => {
    const codeBlock = `\`\`\`ts\n${'const value = 1;\n'.repeat(25)}\`\`\``;
    const chunks = chunkForDiscord(codeBlock, 120);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.endsWith('```')).toBe(true);
    expect(chunks[1]?.startsWith('```')).toBe(true);
  });
});

describe('formatToolLine', () => {
  it('formats known tool summaries for Discord output', () => {
    const line = formatToolLine('running Bash {"command":"pnpm test"}');
    expect(line).toBe('> 💻 **Bash** `pnpm test`');
  });
});

describe('getToolIcon', () => {
  it('maps known tools and falls back for unknown tools', () => {
    expect(getToolIcon('Read')).toBe('📖');
    expect(getToolIcon('UnknownTool')).toBe('🔧');
  });
});

describe('convertMarkdownForDiscord', () => {
  it('converts #, ##, and ### headings with blank lines before them', () => {
    const input = ['Intro', '# Title', 'Body', '## Section', '### Detail'].join('\n');

    expect(convertMarkdownForDiscord(input)).toBe([
      'Intro',
      '',
      '**Title**',
      'Body',
      '',
      '**Section**',
      '',
      '**Detail**',
    ].join('\n'));
  });

  it('converts markdown tables into bullet lists', () => {
    const input = [
      '| Name | Role |',
      '| --- | --- |',
      '| Alice | Admin |',
      '| Bob | User |',
    ].join('\n');

    expect(convertMarkdownForDiscord(input)).toBe([
      '- **Name**: Alice | **Role**: Admin',
      '- **Name**: Bob | **Role**: User',
    ].join('\n'));
  });

  it('removes horizontal rules and leaves a blank line', () => {
    const input = ['Before', '---', 'After'].join('\n');

    expect(convertMarkdownForDiscord(input)).toBe(['Before', '', 'After'].join('\n'));
  });

  it('preserves fenced code blocks exactly as-is', () => {
    const input = [
      '```md',
      '# Heading',
      '| Name | Role |',
      '| --- | --- |',
      '| Alice | Admin |',
      '---',
      '```',
    ].join('\n');

    expect(convertMarkdownForDiscord(input)).toBe(input);
  });

  it('handles mixed content with headings, rules, tables, and code fences', () => {
    const input = [
      'Summary',
      '## Results',
      '| Name | Score |',
      '| --- | --- |',
      '| Alice | 10 |',
      '| Bob | 8 |',
      '---',
      '```md',
      '# Keep this',
      '| Name | Score |',
      '| --- | --- |',
      '| Carol | 7 |',
      '```',
      '### Next',
      'Done',
    ].join('\n');

    expect(convertMarkdownForDiscord(input)).toBe([
      'Summary',
      '',
      '**Results**',
      '- **Name**: Alice | **Score**: 10',
      '- **Name**: Bob | **Score**: 8',
      '',
      '```md',
      '# Keep this',
      '| Name | Score |',
      '| --- | --- |',
      '| Carol | 7 |',
      '```',
      '',
      '**Next**',
      'Done',
    ].join('\n'));
  });
});
