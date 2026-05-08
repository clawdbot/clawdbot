/**
 * `findOcPaths` — multi-match search verb test surface.
 *
 * Tests cover: `*` single-segment expansion across all 4 kinds; `**`
 * recursive descent for jsonc + yaml; the wildcard guard on
 * `resolveOcPath` / `setOcPath`; the slot-shape preservation invariant
 * (a `*` in the `item` slot produces concrete paths whose `item` field
 * carries the matched value).
 */
import { describe, expect, it } from 'vitest';
import { findOcPaths } from '../find.js';
import { parseJsonc } from '../jsonc/parse.js';
import { parseJsonl } from '../jsonl/parse.js';
import { parseMd } from '../parse.js';
import { parseYaml } from '../yaml/parse.js';
import {
  formatOcPath,
  hasWildcard,
  OcPathError,
  parseOcPath,
} from '../oc-path.js';
import {
  resolveOcPath,
  setOcPath,
} from '../universal.js';

// ---------- hasWildcard ----------------------------------------------------

describe('hasWildcard', () => {
  it('detects single-segment * in any slot', () => {
    expect(hasWildcard(parseOcPath('oc://X/*/y'))).toBe(true);
    expect(hasWildcard(parseOcPath('oc://X/a/*'))).toBe(true);
    expect(hasWildcard(parseOcPath('oc://X/a/b/*'))).toBe(true);
  });

  it('detects ** in any slot', () => {
    expect(hasWildcard(parseOcPath('oc://X/**'))).toBe(true);
    expect(hasWildcard(parseOcPath('oc://X/a/**/c'))).toBe(true);
  });

  it('detects wildcards inside dotted sub-segments', () => {
    expect(hasWildcard(parseOcPath('oc://X/a.*.c'))).toBe(true);
    expect(hasWildcard(parseOcPath('oc://X/a.**.c'))).toBe(true);
  });

  it('returns false for plain paths', () => {
    expect(hasWildcard(parseOcPath('oc://X/a/b/c'))).toBe(false);
    expect(hasWildcard(parseOcPath('oc://X/a.b.c'))).toBe(false);
  });

  it('treats `*` inside an identifier as literal', () => {
    expect(hasWildcard(parseOcPath('oc://X/foo*bar'))).toBe(false);
    expect(hasWildcard(parseOcPath('oc://X/a*'))).toBe(false);
  });
});

// ---------- Wildcard guard on resolveOcPath / setOcPath -------------------

describe('wildcard guard', () => {
  const yaml = parseYaml('steps:\n  - id: a\n    command: foo\n').ast;

  it('resolveOcPath throws OcPathError for wildcard pattern (F16)', () => {
    // Previously returned `null` — indistinguishable from "path doesn't
    // resolve". Now throws with `OC_PATH_WILDCARD_IN_RESOLVE` so the
    // CLI / consumers can surface "use findOcPaths" rather than "not
    // found". setOcPath uses a discriminated `wildcard-not-allowed`
    // reason; this is the resolve-side analogue.
    expect(() =>
      resolveOcPath(yaml, parseOcPath('oc://wf/steps/*/command')),
    ).toThrow(/findOcPaths/);
    try {
      resolveOcPath(yaml, parseOcPath('oc://wf/**'));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OcPathError);
      expect((err as OcPathError).code).toBe('OC_PATH_WILDCARD_IN_RESOLVE');
    }
  });

  it('setOcPath returns wildcard-not-allowed for wildcard pattern', () => {
    const r = setOcPath(yaml, parseOcPath('oc://wf/steps/*/command'), 'bar');
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.reason).toBe('wildcard-not-allowed');}
  });

  it('setOcPath wildcard guard reason carries actionable detail', () => {
    const r = setOcPath(yaml, parseOcPath('oc://wf/**'), 'bar');
    expect(r.ok).toBe(false);
    if (!r.ok) {expect(r.detail).toContain('findOcPaths');}
  });
});

// ---------- findOcPaths — fast-path (no wildcards) -------------------------

describe('findOcPaths — non-wildcard fast-path', () => {
  it('wraps resolveOcPath result for plain path', () => {
    const ast = parseYaml('name: x\n').ast;
    const out = findOcPaths(ast, parseOcPath('oc://wf/name'));
    expect(out).toHaveLength(1);
    expect(out[0].match.kind).toBe('leaf');
    expect(formatOcPath(out[0].path)).toBe('oc://wf/name');
  });

  it('returns empty for unresolved plain path', () => {
    const ast = parseYaml('name: x\n').ast;
    expect(findOcPaths(ast, parseOcPath('oc://wf/missing'))).toHaveLength(0);
  });
});

// ---------- findOcPaths — YAML --------------------------------------------

describe('findOcPaths — YAML kind', () => {
  const yaml = parseYaml(
    'steps:\n' +
    '  - id: build\n' +
    '    command: npm run build\n' +
    '  - id: test\n' +
    '    command: npm test\n' +
    '  - id: lint\n' +
    '    command: npm run lint\n'
  ).ast;

  it('* in item slot enumerates each step', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf.lobster/steps/*/command'));
    expect(out).toHaveLength(3);
    const paths = out.map((m) => formatOcPath(m.path));
    expect(paths).toEqual([
      'oc://wf.lobster/steps/0/command',
      'oc://wf.lobster/steps/1/command',
      'oc://wf.lobster/steps/2/command',
    ]);
  });

  it('preserves slot shape — concrete path has matched value in item slot', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/*/id'));
    expect(out).toHaveLength(3);
    for (const m of out) {
      expect(m.path.section).toBe('steps');
      expect(m.path.field).toBe('id');
      expect(m.path.item).toMatch(/^[0-2]$/);
    }
  });

  it('returns leaf valueText for each match', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/*/id'));
    const leaves = out.map((m) => m.match.kind === 'leaf' ? m.match.valueText : null);
    expect(leaves).toEqual(['build', 'test', 'lint']);
  });

  it('** descends recursively', () => {
    const yaml2 = parseYaml(
      'a:\n  b:\n    c: deep\n  d: shallow\n'
    ).ast;
    const out = findOcPaths(yaml2, parseOcPath('oc://wf/**'));
    // ** matches root + a + a.b + a.b.c + a.d
    const leaves = out.filter((m) => m.match.kind === 'leaf').map((m) => m.match.kind === 'leaf' ? m.match.valueText : '');
    expect(leaves.toSorted()).toEqual(['deep', 'shallow']);
  });

  it('returns empty for path that does not match', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/missing/*/x'));
    expect(out).toHaveLength(0);
  });

  it('every returned path is consumable by resolveOcPath', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/*/command'));
    for (const m of out) {
      const r = resolveOcPath(yaml, m.path);
      expect(r).not.toBeNull();
      expect(r?.kind).toBe('leaf');
    }
  });
});

// ---------- findOcPaths — JSONC --------------------------------------------

describe('findOcPaths — JSONC kind', () => {
  const jsonc = parseJsonc(
    '{\n' +
    '  "plugins": {\n' +
    '    "github": {"enabled": true},\n' +
    '    "gitlab": {"enabled": false},\n' +
    '    "slack": {"enabled": true}\n' +
    '  }\n' +
    '}\n'
  ).ast;

  it('* in item slot enumerates each plugin', () => {
    const out = findOcPaths(jsonc, parseOcPath('oc://config/plugins/*/enabled'));
    expect(out).toHaveLength(3);
    const keys = out.map((m) => m.path.item);
    expect(keys.toSorted((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['github', 'gitlab', 'slack']);
  });

  it('returns boolean leaves with leafType', () => {
    const out = findOcPaths(jsonc, parseOcPath('oc://config/plugins/*/enabled'));
    for (const m of out) {
      expect(m.match.kind).toBe('leaf');
      if (m.match.kind === 'leaf') {
        expect(m.match.leafType).toBe('boolean');
      }
    }
  });
});

// ---------- findOcPaths — JSONL --------------------------------------------

describe('findOcPaths — JSONL kind', () => {
  const jsonl = parseJsonl(
    '{"event":"start","userId":"u1"}\n' +
    '{"event":"action","userId":"u1"}\n' +
    '{"event":"end","userId":"u1"}\n'
  ).ast;

  it('* in section slot enumerates each value line', () => {
    const out = findOcPaths(jsonl, parseOcPath('oc://session/*/event'));
    expect(out).toHaveLength(3);
    const events = out.map((m) => m.match.kind === 'leaf' ? m.match.valueText : '');
    expect(events).toEqual(['start', 'action', 'end']);
  });

  it('preserves Lnnn line addresses in concrete paths', () => {
    const out = findOcPaths(jsonl, parseOcPath('oc://session/*/event'));
    for (const m of out) {
      expect(m.path.section).toMatch(/^L\d+$/);
    }
  });

  // F8 — line-slot union and predicate. Without these, yaml/jsonc
  // walkers handled them but JSONL fell through to `pickLine(addr)`
  // which returns null for union/predicate shapes → silent zero matches.
  it('union {L1,L2} at line slot enumerates each alternative', () => {
    const out = findOcPaths(jsonl, parseOcPath('oc://session/{L1,L3}/event'));
    expect(out).toHaveLength(2);
    const events = out.map((m) => (m.match.kind === 'leaf' ? m.match.valueText : ''));
    expect(events).toEqual(['start', 'end']);
  });

  it('union of positional + literal line addresses works', () => {
    const out = findOcPaths(jsonl, parseOcPath('oc://session/{L1,$last}/event'));
    expect(out).toHaveLength(2);
    const events = out.map((m) => (m.match.kind === 'leaf' ? m.match.valueText : ''));
    expect(events).toEqual(['start', 'end']);
  });

  it('predicate [event=action] at line slot filters by top-level field', () => {
    const out = findOcPaths(jsonl, parseOcPath('oc://session/[event=action]/userId'));
    expect(out).toHaveLength(1);
    if (out[0]?.match.kind === 'leaf') {expect(out[0].match.valueText).toBe('u1');}
  });

  it('predicate [event=missing] at line slot matches zero lines (silent zero is correct)', () => {
    const out = findOcPaths(jsonl, parseOcPath('oc://session/[event=missing]/userId'));
    expect(out).toHaveLength(0);
  });
});

// ---------- Positional primitives ($first / $last / -N) -------------------

describe('positional primitives — yaml', () => {
  const yaml = parseYaml(
    'steps:\n  - id: a\n  - id: b\n  - id: c\n'
  ).ast;

  it('resolveOcPath accepts $first', () => {
    const m = resolveOcPath(yaml, parseOcPath('oc://wf/steps/$first/id'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('a');}
  });

  it('resolveOcPath accepts $last', () => {
    const m = resolveOcPath(yaml, parseOcPath('oc://wf/steps/$last/id'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('c');}
  });

  it('resolveOcPath accepts negative index', () => {
    const m = resolveOcPath(yaml, parseOcPath('oc://wf/steps/-2/id'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('b');}
  });

  it('out-of-range positional returns null', () => {
    expect(resolveOcPath(yaml, parseOcPath('oc://wf/steps/-99/id'))).toBeNull();
  });

  it('positional on empty container returns null', () => {
    const empty = parseYaml('steps: []\n').ast;
    expect(resolveOcPath(empty, parseOcPath('oc://wf/steps/$first/id'))).toBeNull();
  });

  it('findOcPaths emits concrete index for positional', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/$last/id'));
    expect(out).toHaveLength(1);
    expect(out[0].path.item).toBe('2');
  });

  it('hasWildcard returns false for positional patterns', () => {
    // Positional ≠ wildcard — they resolve deterministically.
    expect(hasWildcard(parseOcPath('oc://X/$last/id'))).toBe(false);
    expect(hasWildcard(parseOcPath('oc://X/-1/id'))).toBe(false);
  });
});

describe('positional primitives — jsonc', () => {
  const jsonc = parseJsonc('{"items":[10,20,30]}').ast;

  it('$first picks first array element', () => {
    const m = resolveOcPath(jsonc, parseOcPath('oc://config/items/$first'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('10');}
  });

  it('$last picks last array element', () => {
    const m = resolveOcPath(jsonc, parseOcPath('oc://config/items/$last'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('30');}
  });

  it('$first on object picks first-declared key', () => {
    const obj = parseJsonc('{"a":1,"b":2,"c":3}').ast;
    const m = resolveOcPath(obj, parseOcPath('oc://config/$first'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('1');}
  });
});

describe('positional primitives — jsonl', () => {
  const jsonl = parseJsonl(
    '{"event":"start"}\n{"event":"step"}\n{"event":"end"}\n'
  ).ast;

  it('$first picks first value line', () => {
    const m = resolveOcPath(jsonl, parseOcPath('oc://session/$first/event'));
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('start');}
  });

  it('$last picks last value line (existing behavior)', () => {
    const m = resolveOcPath(jsonl, parseOcPath('oc://session/$last/event'));
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('end');}
  });

  it('-1 is alias for $last', () => {
    const m = resolveOcPath(jsonl, parseOcPath('oc://session/-1/event'));
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('end');}
  });
});

// ---------- Segment unions {a,b,c} -----------------------------------------

describe('union segments — yaml', () => {
  const yaml = parseYaml(
    'steps:\n' +
    '  - id: a\n    command: x\n' +
    '  - id: b\n    run: y\n' +
    '  - id: c\n    pipeline: z\n'
  ).ast;

  it('{command,run} matches each step that has either field', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/*/{command,run}'));
    expect(out).toHaveLength(2);
    const fields = out.map((m) => m.path.field);
    expect(fields.toSorted((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['command', 'run']);
  });

  it('preserves the chosen alternative in concrete paths', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/*/{command,pipeline}'));
    expect(out).toHaveLength(2);
    for (const m of out) {
      expect(['command', 'pipeline']).toContain(m.path.field);
    }
  });

  it('unions on top-level keys', () => {
    const yaml2 = parseYaml('a: 1\nb: 2\nc: 3\n').ast;
    const out = findOcPaths(yaml2, parseOcPath('oc://X/{a,c}'));
    expect(out).toHaveLength(2);
    const values = out.map((m) => m.match.kind === 'leaf' ? m.match.valueText : '');
    expect(values.toSorted()).toEqual(['1', '3']);
  });

  it('hasWildcard detects unions (single-match guard rejects them)', () => {
    expect(hasWildcard(parseOcPath('oc://X/{a,b}'))).toBe(true);
    // F16 — wildcard guard now throws OC_PATH_WILDCARD_IN_RESOLVE
    // instead of returning silent null.
    expect(() =>
      resolveOcPath(parseYaml('a: 1\nb: 2\n').ast, parseOcPath('oc://X/{a,b}')),
    ).toThrow(/findOcPaths/);
  });
});

// ---------- Value predicates [key=value] ----------------------------------

describe('value predicates — yaml', () => {
  const yaml = parseYaml(
    'steps:\n' +
    '  - id: build\n    command: npm run build\n' +
    '  - id: test\n    command: npm test\n' +
    '  - id: lint\n    command: npm run lint\n'
  ).ast;

  it('[id=test] selects the matching step', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/[id=test]/command'));
    expect(out).toHaveLength(1);
    if (out[0].match.kind === 'leaf') {
      expect(out[0].match.valueText).toBe('npm test');
    }
    expect(out[0].path.item).toBe('1'); // concrete index of the matched step
  });

  it('predicate yields no matches when key/value missing', () => {
    expect(findOcPaths(yaml, parseOcPath('oc://wf/steps/[id=nonexistent]/command'))).toHaveLength(0);
  });

  it('predicate concretizes the index — path round-trips through resolveOcPath', () => {
    const out = findOcPaths(yaml, parseOcPath('oc://wf/steps/[id=build]/command'));
    expect(out).toHaveLength(1);
    const resolved = resolveOcPath(yaml, out[0].path);
    expect(resolved?.kind).toBe('leaf');
  });

  it('predicate rejects single-match verbs (treated as wildcard)', () => {
    // F16 — wildcard guard throws on predicate too (predicate is a
    // multi-match shape; resolveOcPath is single-match only).
    expect(() =>
      resolveOcPath(yaml, parseOcPath('oc://wf/steps/[id=build]')),
    ).toThrow(/findOcPaths/);
  });
});

describe('quoted segments (v1.0)', () => {
  // Evidence: openclaw#69004 — model alias `anthropic/claude-opus-4-7`.
  // Slash inside the key has no other syntax that doesn't conflict with
  // path-level slash split.
  const jsonc = parseJsonc(
    '{"agents":{"defaults":{"models":{' +
      '"anthropic/claude-opus-4-7":{"alias":"opus47","contextWindow":1000000},' +
      '"github-copilot/claude-opus-4.7-1m-internal":{"alias":"copilot-opus-1m","contextWindow":1000000},' +
      '"plain":{"alias":"p","contextWindow":200000}' +
    '}}}}'
  ).ast;

  it('resolveOcPath — quoted segment with literal slash', () => {
    const m = resolveOcPath(
      jsonc,
      parseOcPath('oc://config/agents.defaults.models/"anthropic/claude-opus-4-7"/alias'),
    );
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('opus47');}
  });

  it('resolveOcPath — quoted segment with literal slash AND dot', () => {
    const m = resolveOcPath(
      jsonc,
      parseOcPath('oc://config/agents.defaults.models/"github-copilot/claude-opus-4.7-1m-internal"/alias'),
    );
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('copilot-opus-1m');}
  });

  it('quoted segment with whitespace', () => {
    const ast = parseJsonc('{"prompts":{"hello world":"value"}}').ast;
    const m = resolveOcPath(ast, parseOcPath('oc://X/prompts/"hello world"'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('value');}
  });

  it('quoted segment with embedded escape sequences', () => {
    // Key literally contains a backslash and a quote.
    const ast = parseJsonc('{"keys":{"a\\\\b":"v1","c\\"d":"v2"}}').ast;
    const m1 = resolveOcPath(ast, parseOcPath('oc://X/keys/"a\\\\b"'));
    expect(m1?.kind).toBe('leaf');
    if (m1?.kind === 'leaf') {expect(m1.valueText).toBe('v1');}
  });

  it('findOcPaths — wildcard returns paths with quoted keys when needed', () => {
    const out = findOcPaths(jsonc, parseOcPath('oc://config/agents.defaults.models/*/alias'));
    expect(out).toHaveLength(3);
    // The two slash-bearing keys round-trip via quotes; `plain` stays bare.
    const items = out.map((m) => m.path.item);
    expect(items.some((s) => s === 'plain')).toBe(true);
    expect(items.some((s) => s === '"anthropic/claude-opus-4-7"')).toBe(true);
    expect(items.some((s) => s === '"github-copilot/claude-opus-4.7-1m-internal"')).toBe(true);
  });

  it('findOcPaths — emitted paths round-trip through resolveOcPath', () => {
    const out = findOcPaths(jsonc, parseOcPath('oc://config/agents.defaults.models/*/alias'));
    for (const m of out) {
      const r = resolveOcPath(jsonc, m.path);
      expect(r?.kind).toBe('leaf');
    }
  });

  it('rejects unbalanced quotes at parse time', () => {
    expect(() => parseOcPath('oc://X/"unterminated')).toThrow(/Unbalanced/);
  });

  it('control characters still rejected inside quotes', () => {
    expect(() => parseOcPath('oc://X/"\x00"')).toThrow(/Control character/);
  });
});

describe('value predicates — numeric operators (v1.1)', () => {
  // Evidence: openclaw#54383 — compaction fails when maxTokens > model output cap.
  // Doctor lint rule: flag any model with maxTokens > 128000 (Anthropic per-request output cap).
  const jsonc = parseJsonc(
    '{"models":{"providers":{"anthropic":{"models":[' +
      '{"id":"claude-sonnet-4-6","contextWindow":1000000,"maxTokens":128000},' +
      '{"id":"claude-opus-4-7","contextWindow":1000000,"maxTokens":240000},' +
      '{"id":"claude-sonnet-4-7","contextWindow":200000,"maxTokens":64000}' +
    ']}}}}'
  ).ast;

  // Slot layout: section=`models.providers.anthropic.models`, item=predicate, field=`id`.
  const PREFIX = 'oc://config/models.providers.anthropic.models';

  it('> finds models exceeding the per-request output cap', () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[maxTokens>128000]/id`));
    expect(out).toHaveLength(1);
    if (out[0].match.kind === 'leaf') {expect(out[0].match.valueText).toBe('claude-opus-4-7');}
  });

  it('>= matches the boundary', () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[maxTokens>=128000]/id`));
    const ids = out.map((m) => m.match.kind === 'leaf' ? m.match.valueText : '');
    expect(ids.toSorted()).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
  });

  it('< filters small context windows', () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[contextWindow<500000]/id`));
    expect(out).toHaveLength(1);
    if (out[0].match.kind === 'leaf') {expect(out[0].match.valueText).toBe('claude-sonnet-4-7');}
  });

  it('<= matches the boundary', () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[contextWindow<=200000]/id`));
    const ids = out.map((m) => m.match.kind === 'leaf' ? m.match.valueText : '');
    expect(ids).toEqual(['claude-sonnet-4-7']);
  });

  it('numeric operator rejects non-numeric leaves silently', () => {
    // String leaf, numeric op — predicate doesn't match (no false positive).
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[id>5]/id`));
    expect(out).toHaveLength(0);
  });

  it('rejects numeric predicate value that is not a number', () => {
    const out = findOcPaths(jsonc, parseOcPath(`${PREFIX}/[maxTokens>foo]/id`));
    expect(out).toHaveLength(0);
  });
});

describe('value predicates — jsonc', () => {
  const jsonc = parseJsonc(
    '{"plugins":{"github":{"enabled":true,"role":"vcs"},"slack":{"enabled":false,"role":"chat"},"jira":{"enabled":true,"role":"tracker"}}}'
  ).ast;

  it('[enabled=true] filters by sibling boolean', () => {
    const out = findOcPaths(jsonc, parseOcPath('oc://config/plugins/[enabled=true]/role'));
    expect(out).toHaveLength(2);
    const roles = out.map((m) => m.match.kind === 'leaf' ? m.match.valueText : '');
    expect(roles.toSorted()).toEqual(['tracker', 'vcs']);
  });
});

// ---------- Ordinal addressing (#N) for distinct duplicate slugs ----------

describe('ordinal addressing — md', () => {
  // Two items with the same slug after slugify (`foo: a` and `foo: b`).
  const md = parseMd(
    '## Tools\n\n- foo: a\n- foo: b\n- bar: c\n'
  ).ast;

  it('#0 picks the first item by document order', () => {
    const m = resolveOcPath(md, parseOcPath('oc://AGENTS.md/tools/#0/foo'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('a');}
  });

  it('#1 picks the second item — distinct from #0 even though slug collides', () => {
    const m = resolveOcPath(md, parseOcPath('oc://AGENTS.md/tools/#1/foo'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('b');}
  });

  it('out-of-range #N returns null', () => {
    expect(resolveOcPath(md, parseOcPath('oc://AGENTS.md/tools/#99/foo'))).toBeNull();
  });

  it('findOcPaths disambiguates duplicate-slug items via #N', () => {
    const out = findOcPaths(md, parseOcPath('oc://AGENTS.md/tools/*/foo'));
    // 2 items have key `foo` (and matching slug); 1 has `bar` (no match).
    expect(out).toHaveLength(2);
    const items = out.map((m) => m.path.item);
    expect(items).toEqual(['#0', '#1']);
    const values = out.map((m) => m.match.kind === 'leaf' ? m.match.valueText : '');
    expect(values.toSorted()).toEqual(['a', 'b']);
  });

  it('non-duplicate slug keeps slug form (back-compat)', () => {
    const md2 = parseMd('## Tools\n\n- foo: a\n- bar: b\n').ast;
    const out = findOcPaths(md2, parseOcPath('oc://AGENTS.md/tools/*'));
    const items = out.map((m) => m.path.item);
    // Both unique → both stay as slugs.
    expect(items.toSorted((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['bar', 'foo']);
  });
});

// ---------- findOcPaths — Markdown -----------------------------------------

describe('findOcPaths — Markdown kind', () => {
  const md = parseMd(
    '---\nname: drafter\nrole: writer\n---\n\n' +
    '## Tools\n\n' +
    '- send_email: enabled\n' +
    '- search: enabled\n' +
    '- read_email: disabled\n'
  ).ast;

  it('* in field slot enumerates frontmatter keys', () => {
    const out = findOcPaths(md, parseOcPath('oc://SOUL.md/[frontmatter]/*'));
    expect(out).toHaveLength(2);
    const keys = out.map((m) => m.path.item ?? m.path.field);
    expect(keys.toSorted((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(['name', 'role']);
  });

  it('* in field slot enumerates each item kv key', () => {
    // Item slug is the kv-key slug ('send_email' → 'send-email').
    const out = findOcPaths(md, parseOcPath('oc://SKILL.md/Tools/send-email/*'));
    expect(out).toHaveLength(1);
    expect(out[0].match.kind).toBe('leaf');
    if (out[0].match.kind === 'leaf') {
      expect(out[0].match.valueText).toBe('enabled');
    }
  });

  it('* in item slot + matching field returns each item whose kv key matches', () => {
    // The kv key on `- send_email: enabled` is `send_email`. Pattern
    // field='send_email' matches that one item; the other two items
    // (search, read_email) have different kv keys.
    const out = findOcPaths(md, parseOcPath('oc://SKILL.md/Tools/*/send_email'));
    expect(out).toHaveLength(1);
    expect(out[0].path.item).toBe('send-email');
  });

  it('** at section slot matches items at every depth (F14 — cross-kind symmetry)', () => {
    // Without the retain-i branch on `**`, walkMd only descended one
    // level (i + 1, consumed `**`) — yaml/jsonc walkers also retain
    // `**` to keep matching deeper. Lint rules expecting universal
    // `**` behavior across kinds (sweep all sections for `risk:`)
    // would silently get 0 md matches on a multi-block file.
    //
    // Pattern `**/send-email` — `**` matches the `tools` block, then
    // `send-email` (kebab slug) matches the item under it. Without the
    // retain-i branch, the walker descends with `**` consumed at the
    // section layer and then can't satisfy the item slot since the
    // walker is now inside the wrong block looking for an item slug.
    const multiBlock = parseMd(
      '## Boundaries\n\n' +
        '- never: rm -rf\n\n' +
        '## Tools\n\n' +
        '- send_email: enabled\n' +
        '- search: enabled\n',
    ).ast;
    const out = findOcPaths(multiBlock, parseOcPath('oc://SOUL.md/**/send-email'));
    // The `send-email` item is under the `tools` block. Pin that we
    // get at least one match (the substrate's md `**` should reach it).
    expect(out.length).toBeGreaterThanOrEqual(1);
    const items = out.map((m) => m.path.item).filter((v): v is string => v !== undefined);
    expect(items).toContain('send-email');
  });
});

describe('findOcPaths — quoted segments survive expansion (regression: resolve↔find symmetry)', () => {
  it('finds keys with slashes when the path quotes them and a sibling wildcards', () => {
    // Closes ClawSweeper P2 on PR #78678: when a pattern needs
    // expansion (e.g. trailing union or wildcard), the JSONC walker
    // bypassed `resolveJsoncOcPath` and compared object keys to the
    // raw `cur.value` directly. Patterns with quoted literals
    // returned no matches even though resolve worked. This test
    // exercises a quoted middle segment + a trailing union.
    const raw = `{
  "agents": {
    "defaults": {
      "models": {
        "github-copilot/claude-opus-4-7": {
          "alias": "opus-internal",
          "contextWindow": 200000
        }
      }
    }
  }
}
`;
    const { ast } = parseJsonc(raw);
    const out = findOcPaths(
      ast,
      parseOcPath(
        'oc://config.jsonc/agents.defaults.models/"github-copilot/claude-opus-4-7"/{alias,contextWindow}',
      ),
    );
    // Both alternatives in the union should match.
    expect(out.length).toBe(2);
    const fields = out.map((m) => m.path.field).toSorted((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(fields).toEqual(['alias', 'contextWindow']);
  });
});
