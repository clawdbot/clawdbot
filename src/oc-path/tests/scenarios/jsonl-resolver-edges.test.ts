/**
 * Wave 18 — JSONL resolver adversarial edges.
 *
 * Substrate guarantee: line addresses (`Lnnn`, `$last`) walk
 * deterministically; missing addresses, blank-line targets, and
 * malformed-line targets all surface as null without throwing.
 */
import { describe, expect, it } from 'vitest';
import { parseJsonl } from '../../jsonl/parse.js';
import { resolveJsonlOcPath } from '../../jsonl/resolve.js';
import { parseOcPath } from '../../oc-path.js';

function rs(raw: string, ocPath: string) {
  return resolveJsonlOcPath(parseJsonl(raw).ast, parseOcPath(ocPath));
}

describe('wave-18 jsonl resolver edges', () => {
  it('JLR-01 root resolves with no segments', () => {
    expect(rs('{"a":1}\n', 'oc://log')?.kind).toBe('root');
  });

  it('JLR-02 L1 resolves to a value line', () => {
    const m = rs('{"a":1}\n', 'oc://log/L1');
    expect(m?.kind).toBe('line');
  });

  it('JLR-03 L99 unknown line returns null', () => {
    expect(rs('{"a":1}\n', 'oc://log/L99')).toBeNull();
  });

  it('JLR-04 $last picks the most recent value line', () => {
    const m = rs('{"a":1}\n{"a":2}\n{"a":3}\n', 'oc://log/$last/a');
    expect(m?.kind).toBe('object-entry');
    if (m?.kind === 'object-entry') {
      expect(m.node.value).toMatchObject({ kind: 'number', value: 3 });
    }
  });

  it('JLR-05 $last skips trailing blank lines', () => {
    const m = rs('{"a":1}\n\n\n', 'oc://log/$last/a');
    expect(m?.kind).toBe('object-entry');
    if (m?.kind === 'object-entry') {
      expect(m.node.value).toMatchObject({ kind: 'number', value: 1 });
    }
  });

  it('JLR-06 $last skips trailing malformed lines', () => {
    const m = rs('{"a":1}\nbroken\n', 'oc://log/$last/a');
    expect(m?.kind).toBe('object-entry');
  });

  it('JLR-07 $last on empty file returns null', () => {
    expect(rs('', 'oc://log/$last/x')).toBeNull();
  });

  it('JLR-08 $last on all-blank file returns null', () => {
    expect(rs('\n\n\n', 'oc://log/$last/x')).toBeNull();
  });

  it('JLR-09 $last on all-malformed file returns null', () => {
    expect(rs('a\nb\nc\n', 'oc://log/$last/x')).toBeNull();
  });

  it('JLR-10 garbage line address returns null', () => {
    expect(rs('{"a":1}\n', 'oc://log/garbage')).toBeNull();
    expect(rs('{"a":1}\n', 'oc://log/L')).toBeNull();
    expect(rs('{"a":1}\n', 'oc://log/Labc')).toBeNull();
  });

  it('JLR-11 descent into a blank line returns null', () => {
    expect(rs('{"a":1}\n\n{"b":2}\n', 'oc://log/L2/anything')).toBeNull();
  });

  it('JLR-12 descent into a malformed line returns null', () => {
    expect(rs('{"a":1}\nbroken\n{"b":2}\n', 'oc://log/L2/anything')).toBeNull();
  });

  it('JLR-13 missing field on a value line returns null', () => {
    expect(rs('{"a":1}\n', 'oc://log/L1/missing')).toBeNull();
  });

  it('JLR-14 dotted descent through line value resolves', () => {
    const m = rs('{"r":{"ok":true,"d":"x"}}\n', 'oc://log/L1/r.d');
    expect(m?.kind).toBe('object-entry');
    if (m?.kind === 'object-entry') {
      expect(m.node.value).toMatchObject({ kind: 'string', value: 'x' });
    }
  });

  it('JLR-15 array index inside a line resolves', () => {
    const m = rs('{"items":["a","b","c"]}\n', 'oc://log/L1/items.2');
    expect(m?.kind).toBe('value');
    if (m?.kind === 'value') {
      expect(m.node).toMatchObject({ kind: 'string', value: 'c' });
    }
  });

  it('JLR-16 line numbers are 1-indexed', () => {
    const m = rs('{"a":1}\n{"a":2}\n', 'oc://log/L1/a');
    if (m?.kind === 'object-entry') {
      expect(m.node.value).toMatchObject({ kind: 'number', value: 1 });
    }
  });

  it('JLR-17 line numbers preserved across blank/malformed entries', () => {
    const m = rs('{"a":1}\n\nbroken\n{"a":4}\n', 'oc://log/L4/a');
    expect(m?.kind).toBe('object-entry');
    if (m?.kind === 'object-entry') {
      expect(m.node.value).toMatchObject({ kind: 'number', value: 4 });
    }
  });

  it('JLR-18 resolver is non-mutating', () => {
    const { ast } = parseJsonl('{"a":1}\n{"b":2}\n');
    const before = JSON.stringify(ast);
    rs('{"a":1}\n{"b":2}\n', 'oc://log/L1');
    rs('{"a":1}\n{"b":2}\n', 'oc://log/$last');
    expect(JSON.stringify(ast)).toBe(before);
  });

  it('JLR-19 hostile inputs do not throw', () => {
    expect(() => rs('not json\n', 'oc://log/L1')).not.toThrow();
    expect(() => rs('', 'oc://log/$last')).not.toThrow();
  });
});
