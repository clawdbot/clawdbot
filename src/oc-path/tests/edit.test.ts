import { describe, expect, it } from 'vitest';
import { setMdOcPath as setOcPath } from '../edit.js';
import { parseOcPath } from '../oc-path.js';
import { parseMd } from '../parse.js';

describe('setOcPath — frontmatter', () => {
  it('replaces a frontmatter value', () => {
    const raw = `---
name: github
description: old desc
---

Body.
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(
      ast,
      parseOcPath('oc://AGENTS.md/[frontmatter]/description'),
      'new desc',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain('description: new desc');
      expect(r.ast.raw).not.toContain('old desc');
    }
  });

  it('reports unresolved when the key is missing', () => {
    const { ast } = parseMd('---\nname: x\n---\n');
    const r = setOcPath(
      ast,
      parseOcPath('oc://AGENTS.md/[frontmatter]/nope'),
      'x',
    );
    expect(r).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('quotes values that need YAML-escaping', () => {
    const { ast } = parseMd('---\nx: a\n---\n');
    const r = setOcPath(ast, parseOcPath('oc://AGENTS.md/[frontmatter]/x'), 'has: colon');
    expect(r.ok).toBe(true);
    if (r.ok) {expect(r.ast.raw).toContain('x: "has: colon"');}
  });
});

describe('setOcPath — item kv field', () => {
  it('replaces an item kv value and reflects it in the rebuilt body', () => {
    const raw = `## Boundaries

- enabled: true
- timeout: 5
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(
      ast,
      parseOcPath('oc://AGENTS.md/boundaries/timeout/timeout'),
      '30',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast.raw).toContain('- timeout: 30');
      expect(r.ast.raw).toContain('- enabled: true');
    }
  });

  it('reports no-item-kv for an item without kv shape', () => {
    const raw = `## Boundaries

- plain bullet
`;
    const { ast } = parseMd(raw);
    const r = setOcPath(
      ast,
      parseOcPath('oc://AGENTS.md/boundaries/plain-bullet/plain-bullet'),
      'x',
    );
    expect(r).toEqual({ ok: false, reason: 'no-item-kv' });
  });

  it('reports unresolved when section/item is missing', () => {
    const { ast } = parseMd('## Other\n\n- foo: bar\n');
    const r = setOcPath(
      ast,
      parseOcPath('oc://AGENTS.md/missing/foo/foo'),
      'x',
    );
    expect(r).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('reports not-writable for section-only addresses', () => {
    const { ast } = parseMd('## Boundaries\n\n- enabled: true\n');
    const r = setOcPath(
      ast,
      parseOcPath('oc://AGENTS.md/boundaries'),
      'x',
    );
    expect(r).toEqual({ ok: false, reason: 'not-writable' });
  });
});
