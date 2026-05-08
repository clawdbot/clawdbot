/**
 * Wave 6 — fenced code blocks.
 *
 * Substrate guarantee: triple-backtick fences (` ``` `) inside H2 blocks
 * extract as `AstCodeBlock` with `lang` (or null) and verbatim `text`.
 * Code blocks suppress H2-split and item-extraction inside their body.
 */
import { describe, expect, it } from 'vitest';
import { parseMd } from '../../parse.js';

describe('wave-06 code-blocks', () => {
  it('CB-01 unlanguaged fence', () => {
    const raw = `## H\n\n\`\`\`\nplain text\n\`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks[0]).toMatchObject({
      lang: null,
      text: 'plain text',
    });
  });

  it('CB-02 languaged fence', () => {
    const raw = `## H\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks[0]?.lang).toBe('ts');
    expect(ast.blocks[0]?.codeBlocks[0]?.text).toBe('const x = 1;');
  });

  it('CB-03 multi-line code body preserved verbatim', () => {
    const raw = `## H\n\n\`\`\`ts\nline 1\nline 2\nline 3\n\`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks[0]?.text).toBe('line 1\nline 2\nline 3');
  });

  it('CB-04 empty code block', () => {
    const raw = `## H\n\n\`\`\`\n\`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks[0]?.text).toBe('');
  });

  it('CB-05 code block with `## ` does NOT split as heading', () => {
    const raw = `## Real\n\n\`\`\`md\n## Not a heading\n\`\`\`\n\n## Another real\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(['Real', 'Another real']);
  });

  it('CB-06 code block with `- bullet` does NOT extract as item', () => {
    const raw = `## H\n\n\`\`\`\n- not a bullet\n- still not\n\`\`\`\n\n- real bullet\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(['real bullet']);
  });

  it('CB-07 multiple code blocks in same section', () => {
    const raw = `## H\n\n\`\`\`a\nfirst\n\`\`\`\n\n\`\`\`b\nsecond\n\`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks.length).toBe(2);
    expect(ast.blocks[0]?.codeBlocks.map((c) => c.lang)).toEqual(['a', 'b']);
  });

  it('CB-08 unterminated fence — body extends to end of section', () => {
    const raw = `## H\n\n\`\`\`\nopen but never closes\n`;
    const { ast } = parseMd(raw);
    // Behavior: code block is created with whatever was after the open
    // fence, including any trailing newline lines. Documents are
    // likely malformed; substrate is lenient and preserves what's
    // there (verifiable via raw round-trip).
    expect(ast.blocks[0]?.codeBlocks[0]?.text).toContain('open but never closes');
  });

  it('CB-09 fence with leading spaces (4-space indented code)', () => {
    // Note: only column-0 ``` triggers fence. Indented content is body
    // text. This is the documented behavior.
    const raw = `## H\n\n    \`\`\`\n    indented\n    \`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks).toEqual([]);
  });

  it('CB-10 lang tag with extra whitespace trimmed', () => {
    const raw = `## H\n\n\`\`\`  jsonc  \nbody\n\`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks[0]?.lang).toBe('jsonc');
  });

  it('CB-11 lang tag with hyphen / dot (typescript-jsx, c++)', () => {
    const raw = `## H\n\n\`\`\`typescript-jsx\nx\n\`\`\`\n`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.codeBlocks[0]?.lang).toBe('typescript-jsx');
  });

  it('CB-12 fence appearing in preamble (before any H2) is ignored at block layer', () => {
    const raw = `\`\`\`\npreamble code\n\`\`\`\n\n## H\n`;
    const { ast } = parseMd(raw);
    // Preamble code blocks aren't structurally extracted at the
    // substrate layer; this is documented. Lint can scan preamble
    // raw if needed.
    expect(ast.blocks[0]?.codeBlocks).toEqual([]);
  });
});
