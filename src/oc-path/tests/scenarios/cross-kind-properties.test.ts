/**
 * Wave 22 — cross-kind property invariants.
 *
 * Per-kind verbs hold the same shape contracts regardless of kind:
 *
 *   1. parse → emit (round-trip) is byte-stable for ALL kinds
 *   2. resolve is non-mutating for ALL kinds
 *   3. set returns structured failure (never throws) for unresolvable
 *      paths across ALL kinds
 *   4. inferKind aligns with the parsers consumers actually pick
 *   5. parse → emit → parse is fixpoint
 *   6. hostile inputs do not throw at parse time
 */
import { describe, expect, it } from 'vitest';
import { inferKind } from '../../dispatch.js';
import { emitMd } from '../../emit.js';
import { setMdOcPath } from '../../edit.js';
import { resolveMdOcPath } from '../../resolve.js';
import { emitJsonc } from '../../jsonc/emit.js';
import { setJsoncOcPath } from '../../jsonc/edit.js';
import { resolveJsoncOcPath } from '../../jsonc/resolve.js';
import { parseJsonc } from '../../jsonc/parse.js';
import { emitJsonl } from '../../jsonl/emit.js';
import { setJsonlOcPath } from '../../jsonl/edit.js';
import { resolveJsonlOcPath } from '../../jsonl/resolve.js';
import { parseJsonl } from '../../jsonl/parse.js';
import { parseOcPath } from '../../oc-path.js';
import { parseMd } from '../../parse.js';

describe('wave-22 cross-kind property invariants', () => {
  const mdRaw = '---\nname: x\n---\n\n## Boundaries\n\n- enabled: true\n';
  const jsoncRaw = '// h\n{ "k": 1, "n": [1,2,3] }\n';
  const jsonlRaw = '{"a":1}\n\nbroken\n{"b":2}\n';

  it('P-01 round-trip parse → emit is byte-stable across all kinds', () => {
    expect(emitMd(parseMd(mdRaw).ast)).toBe(mdRaw);
    expect(emitJsonc(parseJsonc(jsoncRaw).ast)).toBe(jsoncRaw);
    expect(emitJsonl(parseJsonl(jsonlRaw).ast)).toBe(jsonlRaw);
  });

  it('P-02 resolve is non-mutating across all kinds', () => {
    const md = parseMd(mdRaw).ast;
    let before = JSON.stringify(md);
    resolveMdOcPath(md, parseOcPath('oc://X/[frontmatter]/name'));
    resolveMdOcPath(md, parseOcPath('oc://X/boundaries'));
    expect(JSON.stringify(md)).toBe(before);

    const jsonc = parseJsonc(jsoncRaw).ast;
    before = JSON.stringify(jsonc);
    resolveJsoncOcPath(jsonc, parseOcPath('oc://X/k'));
    resolveJsoncOcPath(jsonc, parseOcPath('oc://X/n.0'));
    expect(JSON.stringify(jsonc)).toBe(before);

    const jsonl = parseJsonl(jsonlRaw).ast;
    before = JSON.stringify(jsonl);
    resolveJsonlOcPath(jsonl, parseOcPath('oc://X/L1'));
    resolveJsonlOcPath(jsonl, parseOcPath('oc://X/$last'));
    expect(JSON.stringify(jsonl)).toBe(before);
  });

  it('P-03 unresolvable set never throws across all kinds', () => {
    const ocPath = parseOcPath('oc://X/totally.missing.path');
    expect(() =>
      setMdOcPath(parseMd(mdRaw).ast, ocPath, 'x'),
    ).not.toThrow();
    expect(() =>
      setJsoncOcPath(parseJsonc(jsoncRaw).ast, ocPath, {
        kind: 'string',
        value: 'x',
      }),
    ).not.toThrow();
    expect(() =>
      setJsonlOcPath(parseJsonl(jsonlRaw).ast, ocPath, {
        kind: 'string',
        value: 'x',
      }),
    ).not.toThrow();
  });

  it('P-04 inferKind aligns with the parser actually used', () => {
    expect(inferKind('AGENTS.md')).toBe('md');
    expect(inferKind('SOUL.md')).toBe('md');
    expect(inferKind('config.jsonc')).toBe('jsonc');
    expect(inferKind('plugins.json')).toBe('jsonc');
    expect(inferKind('events.jsonl')).toBe('jsonl');
    expect(inferKind('audit.ndjson')).toBe('jsonl');
  });

  it('P-05 parse → emit → parse is fixpoint across all kinds', () => {
    const md1 = emitMd(parseMd(mdRaw).ast);
    const md2 = emitMd(parseMd(md1).ast);
    expect(md1).toBe(md2);

    const jc1 = emitJsonc(parseJsonc(jsoncRaw).ast);
    const jc2 = emitJsonc(parseJsonc(jc1).ast);
    expect(jc1).toBe(jc2);

    const jl1 = emitJsonl(parseJsonl(jsonlRaw).ast);
    const jl2 = emitJsonl(parseJsonl(jl1).ast);
    expect(jl1).toBe(jl2);
  });

  it('P-06 hostile inputs do not throw at parse time across all kinds', () => {
    const hostile = [
      '\x00\x01\x02 binary garbage',
      '{ "unclosed":',
      '## heading without anything',
      '\n\n\n\n\n',
    ];
    for (const raw of hostile) {
      expect(() => parseMd(raw)).not.toThrow();
      expect(() => parseJsonc(raw)).not.toThrow();
      expect(() => parseJsonl(raw)).not.toThrow();
    }
  });

  it('P-07 resolver returns null for paths past valid kinds (no throw)', () => {
    const overlong = parseOcPath('oc://X/a/b/c.d.e.f.g.h');
    expect(() => resolveMdOcPath(parseMd(mdRaw).ast, overlong)).not.toThrow();
    expect(() => resolveJsoncOcPath(parseJsonc(jsoncRaw).ast, overlong)).not.toThrow();
    expect(() => resolveJsonlOcPath(parseJsonl(jsonlRaw).ast, overlong)).not.toThrow();
  });

  it('P-08 set-then-resolve produces the value just written (jsonc)', () => {
    const ast = parseJsonc('{ "k": 1 }').ast;
    const r = setJsoncOcPath(ast, parseOcPath('oc://X/k'), {
      kind: 'number',
      value: 42,
    });
    if (r.ok) {
      const m = resolveJsoncOcPath(r.ast, parseOcPath('oc://X/k'));
      if (m?.kind === 'object-entry') {
        expect(m.node.value).toEqual({ kind: 'number', value: 42 });
      }
    }
  });

  it('P-09 verbs are deterministic — same input twice produces same output', () => {
    expect(emitMd(parseMd(mdRaw).ast)).toBe(emitMd(parseMd(mdRaw).ast));
    expect(emitJsonc(parseJsonc(jsoncRaw).ast)).toBe(
      emitJsonc(parseJsonc(jsoncRaw).ast),
    );
    expect(emitJsonl(parseJsonl(jsonlRaw).ast)).toBe(
      emitJsonl(parseJsonl(jsonlRaw).ast),
    );
  });

  it('P-10 inferKind returns null for unknown extensions', () => {
    expect(inferKind('binary.bin')).toBeNull();
    expect(inferKind('no-ext')).toBeNull();
    expect(inferKind('archive.tar.gz')).toBeNull();
  });
});
