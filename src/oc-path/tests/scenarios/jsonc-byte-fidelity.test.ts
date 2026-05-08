/**
 * Wave 15 — JSONC byte-fidelity round-trip.
 *
 * Substrate guarantee: `emitJsonc(parseJsonc(raw)) === raw` for every
 * input the parser accepts. Mirrors wave-01 but for the JSONC kind.
 * Comments, trailing commas, BOMs, mixed line endings — all byte-stable
 * via the round-trip path.
 *
 * **What this file proves**: byte-identical round-trip via the
 * default-mode emit (which echoes `ast.raw`). This is necessary but
 * not sufficient — without the structural assertions below, a parser
 * that emitted `ast.root: null` for every input would still pass the
 * byte test (since `raw` is preserved on the AST regardless).
 *
 * Each assertParseable() call proves the parser actually ran and
 * produced a structural tree, not just stored `raw` verbatim and
 * called it a day. JC-17 deliberately uses `assertNotParseable` —
 * malformed input must echo `raw` AND emit a diagnostic.
 */
import { describe, expect, it } from 'vitest';
import { emitJsonc } from '../../jsonc/emit.js';
import { parseJsonc } from '../../jsonc/parse.js';
import type { JsoncValue } from '../../jsonc/ast.js';

function rt(raw: string): string {
  return emitJsonc(parseJsonc(raw).ast);
}

/**
 * Verify the parser actually produced a structural tree (not just a
 * `null` root with echoed `raw`). Without this, a parser that
 * delegated everything to `raw` would pass the byte-fidelity test
 * trivially. Returns the parsed root for follow-up structural asserts.
 */
function assertParseable(raw: string): JsoncValue {
  const result = parseJsonc(raw);
  expect(result.ast.root).not.toBeNull();
  return result.ast.root as JsoncValue;
}

/**
 * The complement: malformed input round-trips bytes verbatim AND
 * emits an error diagnostic. JC-17 needs this — without the
 * diagnostic check, the test would pass even if the parser silently
 * dropped malformed content.
 */
function assertNotParseable(raw: string): void {
  const result = parseJsonc(raw);
  expect(result.ast.root).toBeNull();
  expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
}

describe('wave-15 jsonc byte-fidelity', () => {
  it('JC-01 empty file', () => {
    expect(rt('')).toBe('');
  });

  it('JC-02 whitespace-only', () => {
    expect(rt('   \n\n   \n')).toBe('   \n\n   \n');
  });

  it('JC-03 empty object', () => {
    expect(rt('{}')).toBe('{}');
    const root = assertParseable('{}');
    expect(root.kind).toBe('object');
    if (root.kind === 'object') {expect(root.entries).toHaveLength(0);}
  });

  it('JC-04 empty array', () => {
    expect(rt('[]')).toBe('[]');
    const root = assertParseable('[]');
    expect(root.kind).toBe('array');
    if (root.kind === 'array') {expect(root.items).toHaveLength(0);}
  });

  it('JC-05 trivial scalar root', () => {
    expect(rt('42')).toBe('42');
    expect(rt('"x"')).toBe('"x"');
    expect(rt('true')).toBe('true');
    expect(rt('null')).toBe('null');
    expect(assertParseable('42').kind).toBe('number');
    expect(assertParseable('"x"').kind).toBe('string');
    expect(assertParseable('true').kind).toBe('boolean');
    expect(assertParseable('null').kind).toBe('null');
  });

  it('JC-06 line comments preserved', () => {
    const raw = '// a leading comment\n{ "x": 1 } // trailing\n';
    expect(rt(raw)).toBe(raw);
    // Pin parse: the structural value `x: 1` is reachable.
    const root = assertParseable(raw);
    expect(root.kind).toBe('object');
  });

  it('JC-07 block comments preserved', () => {
    const raw = '/* header */\n{\n  /* inline */\n  "x": 1\n}\n';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    expect(root.kind).toBe('object');
  });

  it('JC-08 trailing commas preserved', () => {
    const raw = '{\n  "x": 1,\n  "y": 2,\n}';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === 'object') {expect(root.entries).toHaveLength(2);}
  });

  it('JC-09 mixed CRLF + LF preserved', () => {
    const raw = '{\r\n  "x": 1,\n  "y": 2\r\n}';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === 'object') {expect(root.entries.map((e) => e.key)).toEqual(['x', 'y']);}
  });

  it('JC-10 BOM preserved on raw', () => {
    const raw = '﻿{ "x": 1 }';
    expect(rt(raw)).toBe(raw);
    // BOM stripped before parsing — parser still sees `{` as first char.
    expect(assertParseable(raw).kind).toBe('object');
  });

  it('JC-11 deeply nested structures preserved', () => {
    const raw = '{ "a": { "b": { "c": { "d": [1, [2, [3, [4]]]] } } } }';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe('object');
  });

  it('JC-12 string with escape sequences preserved', () => {
    const raw = '{ "s": "a\\nb\\tc\\u0041\\\\d\\"e" }';
    expect(rt(raw)).toBe(raw);
    // Pin escape resolution — parsed value carries actual control chars.
    const root = assertParseable(raw);
    if (root.kind === 'object') {
      const s = root.entries[0]?.value;
      if (s?.kind === 'string') {
        expect(s.value).toBe('a\nb\tcA\\d"e');
      }
    }
  });

  it('JC-13 numbers in scientific / negative / decimal forms preserved', () => {
    const raw = '[ 0, -0, 1.5, -3.14, 1e3, -2.5e-10, 1E+5 ]';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === 'array') {
      expect(root.items).toHaveLength(7);
      expect(root.items.every((v) => v.kind === 'number')).toBe(true);
    }
  });

  it('JC-14 unicode characters preserved verbatim', () => {
    const raw = '{ "name": "héllo 世界 🎉" }';
    expect(rt(raw)).toBe(raw);
    const root = assertParseable(raw);
    if (root.kind === 'object') {
      const v = root.entries[0]?.value;
      if (v?.kind === 'string') {expect(v.value).toBe('héllo 世界 🎉');}
    }
  });

  it('JC-15 idiosyncratic whitespace preserved', () => {
    const raw = '{    "x"   :     1    ,\n   "y":   2}';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe('object');
  });

  it('JC-16 file-level trailing whitespace preserved', () => {
    const raw = '{ "x": 1 }\n\n\n';
    expect(rt(raw)).toBe(raw);
    expect(assertParseable(raw).kind).toBe('object');
  });

  it('JC-17 malformed input still emits raw verbatim AND emits a diagnostic', () => {
    const raw = '{ broken json with "key": value }';
    expect(rt(raw)).toBe(raw);
    // Without this assertion the test passes for any input regardless
    // of parser behavior — pin both halves of the contract.
    assertNotParseable(raw);
  });

  it('JC-18 comments-only file preserved', () => {
    const raw = '// just a comment\n/* and a block */\n';
    expect(rt(raw)).toBe(raw);
    // Comments-only files have no structural root — that's expected.
    expect(parseJsonc(raw).ast.root).toBeNull();
  });
});
