/**
 * Wave 4 — items (bullets + kv).
 *
 * Substrate guarantee: bullet lines (`- text`, `* text`, `+ text`) inside
 * H2 blocks are extracted as `AstItem`. Lines matching `- key: value`
 * also populate `item.kv`. Items inside fenced code blocks are NOT
 * extracted.
 */
import { describe, expect, it } from 'vitest';
import { parseMd } from '../../parse.js';

describe('wave-04 items', () => {
  it('I-01 plain dash bullets', () => {
    const { ast } = parseMd('## H\n- a\n- b\n- c\n');
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(['a', 'b', 'c']);
  });

  it('I-02 star bullets', () => {
    const { ast } = parseMd('## H\n* a\n* b\n');
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(['a', 'b']);
  });

  it('I-03 plus bullets', () => {
    const { ast } = parseMd('## H\n+ a\n+ b\n');
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(['a', 'b']);
  });

  it('I-04 mixed bullet markers in same section', () => {
    const { ast } = parseMd('## H\n- dash\n* star\n+ plus\n');
    expect(ast.blocks[0]?.items.length).toBe(3);
  });

  it('I-05 kv-shape items populate kv', () => {
    const { ast } = parseMd('## H\n- gh: GitHub CLI\n');
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({ key: 'gh', value: 'GitHub CLI' });
  });

  it('I-06 plain item has no kv', () => {
    const { ast } = parseMd('## H\n- plain text\n');
    expect(ast.blocks[0]?.items[0]?.kv).toBeUndefined();
  });

  it('I-07 multiple colons — first colon is the kv split', () => {
    const { ast } = parseMd('## H\n- url: http://x.com:80/p\n');
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({
      key: 'url',
      value: 'http://x.com:80/p',
    });
  });

  it('I-08 colon with no space after is still kv', () => {
    const { ast } = parseMd('## H\n- key:value\n');
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({ key: 'key', value: 'value' });
  });

  it('I-09 quoted value preserved verbatim (no unquote at item layer)', () => {
    const { ast } = parseMd('## H\n- title: "quoted: value"\n');
    expect(ast.blocks[0]?.items[0]?.kv?.value).toBe('"quoted: value"');
  });

  it('I-10 slug from kv key when kv present', () => {
    const { ast } = parseMd('## H\n- The Tool: description\n');
    expect(ast.blocks[0]?.items[0]?.slug).toBe('the-tool');
  });

  it('I-11 slug from item text when no kv', () => {
    const { ast } = parseMd('## H\n- The Plain Item\n');
    expect(ast.blocks[0]?.items[0]?.slug).toBe('the-plain-item');
  });

  it('I-12 items inside fenced code block are NOT extracted', () => {
    const raw = '## H\n```\n- not a bullet\n- still not\n```\n- real bullet\n';
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.items.length).toBe(1);
    expect(ast.blocks[0]?.items[0]?.text).toBe('real bullet');
  });

  it('I-13 line numbers track through block body', () => {
    const { ast } = parseMd('## H\n- first\n- second\n- third\n');
    expect(ast.blocks[0]?.items.map((i) => i.line)).toEqual([2, 3, 4]);
  });

  it('I-14 trailing whitespace on bullet trimmed in text', () => {
    const { ast } = parseMd('## H\n- spaced   \n');
    expect(ast.blocks[0]?.items[0]?.text).toBe('spaced');
  });

  it('I-15 empty bullet text is dropped', () => {
    const { ast } = parseMd('## H\n- \n- real\n');
    // The regex requires (.+?) non-empty, so `- ` alone doesn't match.
    expect(ast.blocks[0]?.items.length).toBe(1);
  });

  it('I-16 indented bullet (sub-bullet) — current parser still picks up', () => {
    // The current regex `^(?:[-*+])\\s+(.+?)\\s*$` requires column-0
    // bullet markers; indented bullets do NOT match. Documented as a
    // limit — sub-bullets surface in body text but not in items.
    const { ast } = parseMd('## H\n- top\n  - sub\n');
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(['top']);
  });

  it('I-17 numbered list (1. item) is NOT extracted as item', () => {
    const { ast } = parseMd('## H\n1. first\n2. second\n');
    expect(ast.blocks[0]?.items).toEqual([]);
  });

  it('I-18 items in a section with no body before — first item line is heading+1', () => {
    const { ast } = parseMd('## H\n- a\n');
    expect(ast.blocks[0]?.items[0]?.line).toBe(2);
  });

  it('I-19 items spread across blocks are scoped to their block', () => {
    const { ast } = parseMd('## A\n- a1\n## B\n- b1\n- b2\n');
    expect(ast.blocks[0]?.items.length).toBe(1);
    expect(ast.blocks[1]?.items.length).toBe(2);
    expect(ast.blocks[1]?.items.map((i) => i.text)).toEqual(['b1', 'b2']);
  });

  it('I-20 item with only-symbol kv key still parses', () => {
    const { ast } = parseMd('## H\n- API_KEY: secret-value\n');
    expect(ast.blocks[0]?.items[0]?.kv).toEqual({
      key: 'API_KEY',
      value: 'secret-value',
    });
    expect(ast.blocks[0]?.items[0]?.slug).toBe('api-key');
  });

  it('I-21 item with kv where value is empty', () => {
    const { ast } = parseMd('## H\n- key:\n');
    // `- key:` has empty value after the colon; the kv regex requires
    // (.+) for value, so this falls through to plain item.
    expect(ast.blocks[0]?.items[0]?.kv).toBeUndefined();
    expect(ast.blocks[0]?.items[0]?.text).toBe('key:');
  });

  it('I-22 bullet in preamble (before first H2) is NOT in any block', () => {
    const { ast } = parseMd('- preamble bullet\n## H\n- block bullet\n');
    expect(ast.blocks[0]?.items.map((i) => i.text)).toEqual(['block bullet']);
    expect(ast.preamble).toContain('- preamble bullet');
  });

  it('I-23 bullet with internal markdown (italics, code) preserved in text', () => {
    const { ast } = parseMd('## H\n- use *gh* and `curl`\n');
    expect(ast.blocks[0]?.items[0]?.text).toBe('use *gh* and `curl`');
  });
});
