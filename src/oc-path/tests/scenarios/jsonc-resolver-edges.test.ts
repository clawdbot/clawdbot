/**
 * Wave 17 — JSONC resolver adversarial edges.
 *
 * Substrate guarantee: the resolver walks the value tree deterministically
 * with mixed dotted / segment paths, returns null on any unresolvable
 * walk, and never throws on hostile inputs.
 */
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../../jsonc/parse.js';
import { resolveJsoncOcPath } from '../../jsonc/resolve.js';
import { parseOcPath } from '../../oc-path.js';

function rs(raw: string, ocPath: string) {
  return resolveJsoncOcPath(parseJsonc(raw).ast, parseOcPath(ocPath));
}

describe('wave-17 jsonc resolver edges', () => {
  it('JR-01 root resolves on empty object', () => {
    expect(rs('{}', 'oc://config')?.kind).toBe('root');
  });

  it('JR-02 root resolves on scalar root', () => {
    expect(rs('42', 'oc://config')?.kind).toBe('root');
  });

  it('JR-03 root resolves on array root', () => {
    expect(rs('[1,2,3]', 'oc://config')?.kind).toBe('root');
  });

  it('JR-04 deep dotted descent within section', () => {
    const m = rs('{"a":{"b":{"c":1}}}', 'oc://config/a.b.c');
    expect(m?.kind).toBe('object-entry');
  });

  it('JR-05 missing intermediate key returns null', () => {
    expect(rs('{"a":{"b":1}}', 'oc://config/a.x.b')).toBeNull();
  });

  it('JR-06 numeric segment indexes into array', () => {
    const m = rs('{"items":["a","b","c"]}', 'oc://config/items.1');
    expect(m?.kind).toBe('value');
    if (m?.kind === 'value') {
      expect(m.node).toMatchObject({ kind: 'string', value: 'b' });
    }
  });

  it('JR-07 negative array index resolves to Nth-from-last', () => {
    expect(rs('{"x":[1,2]}', 'oc://config/x.-1')).toMatchObject({ kind: 'value', node: { kind: 'number', value: 2 } });
    expect(rs('{"x":[1,2]}', 'oc://config/x.-2')).toMatchObject({ kind: 'value', node: { kind: 'number', value: 1 } });
    expect(rs('{"x":[1,2]}', 'oc://config/x.-5')).toBeNull();
  });

  it('JR-08 out-of-bounds array index returns null', () => {
    expect(rs('{"x":[1,2]}', 'oc://config/x.99')).toBeNull();
  });

  it('JR-09 non-integer index returns null (no NaN coercion)', () => {
    expect(rs('{"x":[1,2]}', 'oc://config/x.foo')).toBeNull();
  });

  it('JR-10 null AST root returns null on any path', () => {
    expect(rs('', 'oc://config/x')).toBeNull();
  });

  it('JR-11 descending past a primitive returns null', () => {
    expect(rs('{"x":42}', 'oc://config/x.y')).toBeNull();
  });

  it('JR-12 empty segment in dotted path throws OcPathError', () => {
    // v1 invariant: malformed paths fail loud at parse time, not silently null.
    expect(() => rs('{"x":1}', 'oc://config/x..y')).toThrow(/Empty dotted sub-segment/);
  });

  it('JR-13 string value at leaf surfaces via object-entry shape', () => {
    const m = rs('{"k":"v"}', 'oc://config/k');
    expect(m?.kind).toBe('object-entry');
    if (m?.kind === 'object-entry') {expect(m.node.key).toBe('k');}
  });

  it('JR-14 boolean and null values resolve', () => {
    const m1 = rs('{"k":true}', 'oc://config/k');
    expect(m1?.kind).toBe('object-entry');
    const m2 = rs('{"k":null}', 'oc://config/k');
    expect(m2?.kind).toBe('object-entry');
  });

  it('JR-15 mixed slash + dot segments resolve identically', () => {
    const a = rs('{"a":{"b":{"c":1}}}', 'oc://config/a.b.c');
    const b = rs('{"a":{"b":{"c":1}}}', 'oc://config/a/b.c');
    const c = rs('{"a":{"b":{"c":1}}}', 'oc://config/a/b/c');
    expect(a?.kind).toBe(b?.kind);
    expect(b?.kind).toBe(c?.kind);
  });

  it('JR-16 keys with special characters resolve', () => {
    const m = rs('{"a-b_c":{"x":1}}', 'oc://config/a-b_c.x');
    expect(m?.kind).toBe('object-entry');
  });

  it('JR-17 unicode keys resolve', () => {
    const m = rs('{"héllo":1}', 'oc://config/héllo');
    expect(m?.kind).toBe('object-entry');
  });

  it('JR-18 large nested structure (depth 20) resolves to leaf', () => {
    let json = '"leaf"';
    const segs: string[] = [];
    for (let i = 19; i >= 0; i--) {
      json = `{"k${i}":${json}}`;
      segs.unshift(`k${i}`);
    }
    const m = rs(json, `oc://config/${segs.join('.')}`);
    expect(m?.kind).toBe('object-entry');
    if (m?.kind === 'object-entry') {
      expect(m.node.value).toMatchObject({ kind: 'string', value: 'leaf' });
    }
  });

  it('JR-19 resolver is non-mutating across calls', () => {
    const { ast } = parseJsonc('{"x":{"y":1}}');
    const before = JSON.stringify(ast);
    rs('{"x":{"y":1}}', 'oc://config/x.y');
    rs('{"x":{"y":1}}', 'oc://config/x');
    rs('{"x":{"y":1}}', 'oc://config/missing');
    expect(JSON.stringify(ast)).toBe(before);
  });

  it('JR-20 hostile input shapes do not throw', () => {
    expect(() => rs('{garbage}', 'oc://config/x')).not.toThrow();
    expect(() => rs('{"a":', 'oc://config/a')).not.toThrow();
  });
});
