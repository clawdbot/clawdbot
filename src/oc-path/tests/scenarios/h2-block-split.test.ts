/**
 * Wave 3 — H2 block split.
 *
 * Substrate guarantee: `## ` at column 0 outside fenced code blocks
 * starts a new H2 block. H1 (`# `), H3 (`### `), and `## ` inside
 * fenced code blocks do NOT split.
 */
import { describe, expect, it } from 'vitest';
import { parseMd } from '../../parse.js';

describe('wave-03 h2-block-split', () => {
  it('H2-01 no headings → no blocks, all preamble', () => {
    const raw = 'Just prose, no headings.\nMore prose.\n';
    const { ast } = parseMd(raw);
    expect(ast.blocks).toEqual([]);
    // Preamble preserves the trailing newline from raw (split + rejoin
    // is symmetric); callers that want trimmed prose call .trim().
    expect(ast.preamble).toBe('Just prose, no headings.\nMore prose.\n');
  });

  it('H2-02 single heading splits preamble + one block', () => {
    const { ast } = parseMd('preamble\n## Section\nbody\n');
    expect(ast.preamble.trim()).toBe('preamble');
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe('Section');
    expect(ast.blocks[0]?.bodyText.trim()).toBe('body');
  });

  it('H2-03 multiple headings produce blocks in order', () => {
    const { ast } = parseMd('## A\nbody-a\n## B\nbody-b\n## C\nbody-c\n');
    expect(ast.blocks.map((b) => b.heading)).toEqual(['A', 'B', 'C']);
  });

  it('H2-04 H1 does NOT split', () => {
    const { ast } = parseMd('# H1 heading\n## H2 heading\n');
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe('H2 heading');
    expect(ast.preamble).toContain('# H1 heading');
  });

  it('H2-05 H3 does NOT split', () => {
    const { ast } = parseMd('## H2\nbody\n### H3\nstill in H2 block\n');
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.bodyText).toContain('### H3');
  });

  it('H2-06 `## ` inside fenced code block does NOT split', () => {
    const raw = '## Real\n\n```md\n## Inside code\n```\n\n## Another real\n';
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(['Real', 'Another real']);
  });

  it('H2-07 `##` without trailing space — does NOT match (regex requires \\s+)', () => {
    const { ast } = parseMd('##NoSpace\n## With space\n');
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe('With space');
  });

  it('H2-08 leading whitespace before `##` — does NOT match (regex anchored at line start)', () => {
    const { ast } = parseMd('   ## indented\n## not indented\n');
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe('not indented');
  });

  it('H2-09 trailing whitespace on heading — trimmed in heading text', () => {
    const { ast } = parseMd('## Trailing   \n');
    expect(ast.blocks[0]?.heading).toBe('Trailing');
    expect(ast.blocks[0]?.slug).toBe('trailing');
  });

  it('H2-10 inline code in heading preserved', () => {
    const { ast } = parseMd('## Use `gh` for GitHub\n');
    expect(ast.blocks[0]?.heading).toBe('Use `gh` for GitHub');
  });

  it('H2-11 markdown formatting in heading preserved', () => {
    const { ast } = parseMd('## **Bold** *italic*\n');
    expect(ast.blocks[0]?.heading).toBe('**Bold** *italic*');
  });

  it('H2-12 immediately after frontmatter', () => {
    const { ast } = parseMd('---\nk: v\n---\n## Section\nbody\n');
    expect(ast.blocks[0]?.heading).toBe('Section');
    expect(ast.preamble).toBe('');
  });

  it('H2-13 H2 at end of file (no body)', () => {
    const { ast } = parseMd('preamble\n## End\n');
    expect(ast.blocks[0]?.heading).toBe('End');
    expect(ast.blocks[0]?.bodyText).toBe('');
  });

  it('H2-14 two consecutive H2s — empty body block between', () => {
    const { ast } = parseMd('## A\n## B\n');
    expect(ast.blocks[0]?.bodyText).toBe('');
    expect(ast.blocks[1]?.heading).toBe('B');
  });

  it('H2-15 line numbers are 1-based and track through frontmatter', () => {
    const { ast } = parseMd('---\nk: v\n---\n## At line 4\n');
    expect(ast.blocks[0]?.line).toBe(4);
  });

  it('H2-16 line numbers track through preamble', () => {
    const { ast } = parseMd('line 1\nline 2\n## At line 3\n');
    expect(ast.blocks[0]?.line).toBe(3);
  });

  it('H2-17 nested fenced code blocks (~~~ vs ```) — only ``` is detected', () => {
    // Current parser only treats ``` as fence; ~~~ falls through. This
    // is a documented limit. Inputs with ~~~ aren't broken — they're
    // just not protected from H2-misparsing inside them.
    const raw = '## H\n\n~~~md\n~~~\n\n## Next\n';
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(['H', 'Next']);
  });

  it('H2-18 setext-style heading (`Heading\\n========\\n`) is NOT recognized', () => {
    // Substrate is opinion-aware: setext headings are treated as
    // preamble. Lint rules can flag if needed; recognized markdown
    // dialect is `## ATX-style only` for OpenClaw workspace files.
    const raw = 'Heading\n=======\n## Real\n';
    const { ast } = parseMd(raw);
    expect(ast.blocks.length).toBe(1);
    expect(ast.blocks[0]?.heading).toBe('Real');
  });

  it('H2-19 empty heading text (`## `)', () => {
    const { ast } = parseMd('## \n');
    // Empty heading is technically a valid match (`## ` + empty text)
    // but the regex requires `(.+?)` so empty doesn't match. Validates
    // it's NOT split.
    expect(ast.blocks).toEqual([]);
  });

  it('H2-20 heading with only whitespace (`##    `)', () => {
    const { ast } = parseMd('##    \n');
    expect(ast.blocks).toEqual([]);
  });

  it('H2-21 heading-shaped text inside multi-line bullet body — does split', () => {
    // The substrate treats line-start ## as a heading regardless of
    // logical context (item continuation lines). Lint rules can flag
    // the boundary; substrate prefers structural simplicity.
    const raw = '## Section\n- item starts\n  continues\n## Next\n';
    const { ast } = parseMd(raw);
    expect(ast.blocks.map((b) => b.heading)).toEqual(['Section', 'Next']);
  });
});
