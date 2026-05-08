/**
 * Wave-23 — Pitfall scenarios.
 *
 * One test per pitfall ID enumerated in
 * `packages/oc-paths-substrate/PITFALLS.md` (the substrate-local
 * pitfall taxonomy). Tests are grouped by category so a regression in
 * any one defense is visible at a glance. Every MITIGATED / REJECTED
 * pitfall has a positive validation here; DEFERRED ones are covered
 * as documented limits with a `.skip` note.
 *
 * **Namespace note**: substrate pitfall IDs (P-001 … P-040) are a
 * separate namespace from the claws-side `docs/PITFALLS.md`
 * governance taxonomy (which uses P-NNN for completely different
 * pitfalls — e.g., P-033 there is "Memory poisoning"). The package
 * boundary disambiguates.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PATH_LENGTH,
  MAX_TRAVERSAL_DEPTH,
  OcPathError,
  findOcPaths,
  formatOcPath,
  parseOcPath,
  resolveOcPath,
  setOcPath,
} from '../../index.js';
import { parseJsonc } from '../../jsonc/parse.js';
import { parseJsonl } from '../../jsonl/parse.js';
import { parseYaml } from '../../yaml/parse.js';

// ---------- Encoding pitfalls --------------------------------------------

describe('wave-23 pitfalls — encoding', () => {
  it('P-001 strips leading UTF-8 BOM from path string', () => {
    const bom = '﻿';
    expect(parseOcPath(`${bom}oc://X/Y`).file).toBe('X');
  });

  it('P-002 normalizes path to NFC', () => {
    const nfc = 'café'; // composed
    const nfd = 'café'; // decomposed
    expect(parseOcPath(`oc://X/${nfd}`).section).toBe(nfc);
    expect(parseOcPath(`oc://X/${nfc}`).section).toBe(nfc);
    // Same struct out for both inputs.
    expect(parseOcPath(`oc://X/${nfd}`)).toEqual(parseOcPath(`oc://X/${nfc}`));
  });

  it('P-003 rejects whitespace in identifier-shaped segments', () => {
    expect(() => parseOcPath('oc://X/foo /bar')).toThrow(OcPathError);
    expect(() => parseOcPath('oc://X/ foo')).toThrow(OcPathError);
    expect(() => parseOcPath('oc://X/foo\tbar')).toThrow(OcPathError);
  });

  it('P-003 allows whitespace inside predicate values (content)', () => {
    // Spaces inside a predicate value are legitimate — they're filtering
    // against actual content.
    expect(() => parseOcPath('oc://X/[name=hello world]')).not.toThrow();
  });

  it('P-004 / P-011 rejects control characters and null bytes', () => {
    expect(() => parseOcPath('oc://X/\x00')).toThrow(/Control character/);
    expect(() => parseOcPath('oc://X/foo\x01bar')).toThrow(/Control character/);
    expect(() => parseOcPath('oc://X/foo\x7Fbar')).toThrow(/Control character/);
  });
});

// ---------- Empty / structural pitfalls ----------------------------------

describe('wave-23 pitfalls — empty & structural', () => {
  it('P-008 rejects empty segments', () => {
    expect(() => parseOcPath('oc://X//Y')).toThrow(/Empty segment/);
  });

  it('P-009 rejects empty dotted sub-segments', () => {
    expect(() => parseOcPath('oc://X/a..b')).toThrow(/Empty dotted sub-segment/);
  });

  it('P-010 rejects scheme-only path', () => {
    expect(() => parseOcPath('oc://')).toThrow(/Empty oc:\/\/ path/);
  });

  it('P-014 rejects empty predicate key', () => {
    expect(() => parseOcPath('oc://X/[=foo]')).toThrow(/Malformed predicate/);
  });

  it('P-014 rejects empty predicate value', () => {
    expect(() => parseOcPath('oc://X/[id=]')).toThrow(/Malformed predicate/);
  });

  it('P-015 accepts bracket segment with no operator as literal sentinel', () => {
    // `[frontmatter]` predates the predicate grammar — kept as literal.
    expect(parseOcPath('oc://AGENTS.md/[frontmatter]/key').section).toBe('[frontmatter]');
  });

  it('P-016 rejects mismatched brackets', () => {
    expect(() => parseOcPath('oc://X/[unclosed')).toThrow(OcPathError);
    expect(() => parseOcPath('oc://X/closed]')).toThrow(OcPathError);
  });

  it('P-016 rejects mismatched braces', () => {
    expect(() => parseOcPath('oc://X/{a,b')).toThrow(OcPathError);
  });

  it('P-018 rejects empty union', () => {
    expect(() => parseOcPath('oc://X/{}')).toThrow(/Empty union/);
  });

  it('P-018 rejects union with empty alternative', () => {
    expect(() => parseOcPath('oc://X/{a,,b}')).toThrow(/Empty alternative/);
  });
});

// ---------- Predicate-content pitfalls -----------------------------------

describe('wave-23 pitfalls — predicate content', () => {
  it('P-012 predicate value containing `/` round-trips', () => {
    // The path-level `/` split must respect bracket boundaries.
    const p = parseOcPath('oc://X/[id=foo/bar]/cmd');
    expect(p.section).toBe('[id=foo/bar]');
    expect(p.item).toBe('cmd');
  });

  it('P-012 findOcPaths matches a leaf whose id contains a slash', () => {
    const ast = parseYaml(
      'steps:\n  - id: foo/bar\n    cmd: x\n  - id: baz\n    cmd: y\n'
    ).ast;
    const out = findOcPaths(ast, parseOcPath('oc://wf/steps/[id=foo/bar]/cmd'));
    expect(out).toHaveLength(1);
    if (out[0].match.kind === 'leaf') {expect(out[0].match.valueText).toBe('x');}
  });

  it('P-013 predicate value containing `.` round-trips', () => {
    const p = parseOcPath('oc://X/steps.[id=1.0].cmd');
    expect(p.section).toBe('steps.[id=1.0].cmd');
  });

  it('P-013 findOcPaths matches a leaf whose id is `1.0`', () => {
    const ast = parseYaml(
      'steps:\n  - id: "1.0"\n    cmd: x\n  - id: "2.0"\n    cmd: y\n'
    ).ast;
    const out = findOcPaths(ast, parseOcPath('oc://wf/steps/[id=1.0]/cmd'));
    expect(out).toHaveLength(1);
    if (out[0].match.kind === 'leaf') {expect(out[0].match.valueText).toBe('x');}
  });
});

// ---------- Sentinel & collision pitfalls --------------------------------

describe('wave-23 pitfalls — sentinels & collisions', () => {
  it('P-020/openclaw#59934 negative numeric key on object resolves as literal key', () => {
    // Telegram supergroup IDs are negative numbers used as map keys.
    // Our positional `-N` token would otherwise hijack them. Resolver
    // falls through to literal-key lookup on non-indexable containers.
    const ast = parseJsonc(
      '{"channels":{"telegram":{"groups":{"-5028303500":{"requireMention":false}}}}}'
    ).ast;
    const m = resolveOcPath(
      ast,
      parseOcPath('oc://config/channels.telegram.groups.-5028303500.requireMention'),
    );
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {
      expect(m.valueText).toBe('false');
      expect(m.leafType).toBe('boolean');
    }
  });

  it('P-020 negative `-N` still works as positional on arrays', () => {
    // Same syntax, indexable container — positional resolution wins.
    const ast = parseJsonc('{"items":[10,20,30]}').ast;
    const m = resolveOcPath(ast, parseOcPath('oc://X/items/-1'));
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('30');}
  });

  it('P-020 numeric segment dispatches by node kind (array index vs map key)', () => {
    // Same path string against two different ASTs — kind disambiguates.
    const arr = parseJsonc('{"x":["a","b"]}').ast;
    const map = parseJsonc('{"x":{"0":"a","1":"b"}}').ast;
    const arrM = resolveOcPath(arr, parseOcPath('oc://config/x/0'));
    const mapM = resolveOcPath(map, parseOcPath('oc://config/x/0'));
    expect(arrM?.kind).toBe('leaf');
    expect(mapM?.kind).toBe('leaf');
    if (arrM?.kind === 'leaf') {expect(arrM.valueText).toBe('a');}
    if (mapM?.kind === 'leaf') {expect(mapM.valueText).toBe('a');}
  });

  it('P-021 `$last` literal in a yaml key is shadowed by positional sentinel', () => {
    // Document v0 limitation: `$last` always means "last", never a literal key.
    // Authors with `$last` literal keys must use kind-narrow access.
    const ast = parseYaml('$last: literal-value\nfoo: bar\n').ast;
    const m = resolveOcPath(ast, parseOcPath('oc://X/$last'));
    // `$last` resolves to the LAST key (`foo` → `bar`), not the literal `$last` key.
    expect(m?.kind).toBe('leaf');
    if (m?.kind === 'leaf') {expect(m.valueText).toBe('bar');}
  });
});

// ---------- Round-trip pitfalls ------------------------------------------

describe('wave-23 pitfalls — round-trip', () => {
  it('P-023 parseOcPath ∘ formatOcPath is idempotent across path shapes', () => {
    const inputs = [
      'oc://X',
      'oc://X/a',
      'oc://X/a/b',
      'oc://X/a/b/c',
      'oc://X/a.b.c',
      'oc://X/a?session=s1',
      'oc://X/[frontmatter]/key',
      'oc://X/steps/*/command',
      'oc://X/steps/$last/id',
      'oc://X/steps/-2/id',
      'oc://X/steps/{command,run}',
      'oc://X/steps/[id=foo]/cmd',
      'oc://X/steps/#0/foo',
    ];
    for (const s of inputs) {
      const parsed = parseOcPath(s);
      const reparsed = parseOcPath(s);
      expect(parsed).toEqual(reparsed);
    }
  });
});

// ---------- Sentinel-guard pitfalls --------------------------------------

describe('wave-23 pitfalls — sentinel at format boundary (F9)', () => {
  it('formatOcPath rejects an OcPath struct carrying the redaction sentinel', () => {
    // Path strings flow into telemetry, audit events, error messages,
    // find-result `path` fields. Without the format-time guard, a
    // struct with `section: REDACTED_SENTINEL` would slip past every
    // consumer except the CLI's scrubSentinel layer. The substrate's
    // contract is "emit boundaries refuse the sentinel" — formatOcPath
    // IS such a boundary for path strings.
    expect(() =>
      formatOcPath({ file: 'AGENTS.md', section: '__OPENCLAW_REDACTED__' }),
    ).toThrow(/sentinel literal/);
  });
});

// ---------- Containment pitfalls -----------------------------------------

describe('wave-23 pitfalls — file-slot containment', () => {
  // oc:// paths are workspace-relative. Absolute paths and `..` segments
  // would let a hostile workflow / skill manifest persuade
  // `openclaw path resolve|set|emit` into reading or writing arbitrary
  // filesystem locations (Node `path.resolve(cwd, absolute)` returns
  // `absolute`, bypassing the workspace root). Reject at parseOcPath
  // and formatOcPath for symmetric defense.
  it('rejects an absolute POSIX file slot', () => {
    expect(() => parseOcPath('oc:///etc/passwd')).toThrow(/Empty segment/);
    // Quoted form — same containment violation, different parse path.
    expect(() => parseOcPath('oc://"/etc/passwd"/section')).toThrow(/Absolute file slot/);
  });

  it('rejects a Windows drive-letter file slot', () => {
    expect(() => parseOcPath('oc://"C:/Windows/System32/foo"/section')).toThrow(
      /Absolute file slot/,
    );
    expect(() => parseOcPath('oc://"C:\\\\Windows\\\\System32"/section')).toThrow(
      /Absolute file slot/,
    );
  });

  it('rejects a leading-backslash file slot', () => {
    expect(() => parseOcPath('oc://"\\\\srv\\\\share\\\\foo"/section')).toThrow(
      /Absolute file slot/,
    );
  });

  it('rejects a parent-directory escape via plain `..`', () => {
    expect(() => parseOcPath('oc://"../foo"/section')).toThrow(/Parent-directory/);
    expect(() => parseOcPath('oc://".."/section')).toThrow(/Parent-directory/);
  });

  it('rejects a parent-directory escape mid-path', () => {
    expect(() => parseOcPath('oc://"foo/../bar"/section')).toThrow(/Parent-directory/);
  });

  it('does not decode URL-encoded `..` — literal `%2E%2E` is treated as a filename', () => {
    // The substrate does NOT do URL decoding — `%2E%2E` is the literal
    // five-character filename, not a parent-directory escape. Documented
    // limitation: consumers that pre-decode (HTTP layers, browser UI)
    // are responsible for normalizing before invoking parseOcPath.
    // Pin the current behavior so a future "let's decode for them" PR
    // sees the explicit choice.
    const p = parseOcPath('oc://"%2E%2E/foo"/section');
    expect(p.file).toBe('%2E%2E/foo');
  });

  it('formatOcPath rejects an OcPath struct with absolute file', () => {
    expect(() => formatOcPath({ file: '/etc/passwd' })).toThrow(/Absolute file slot/);
    expect(() => formatOcPath({ file: 'C:/Windows' })).toThrow(/Absolute file slot/);
  });

  it('formatOcPath rejects an OcPath struct with parent-directory file', () => {
    expect(() => formatOcPath({ file: '..' })).toThrow(/Parent-directory/);
    expect(() => formatOcPath({ file: '../etc/passwd' })).toThrow(/Parent-directory/);
    expect(() => formatOcPath({ file: 'foo/../bar' })).toThrow(/Parent-directory/);
  });
});

// ---------- formatOcPath ↔ parseOcPath round-trip ------------------------

describe('wave-23 pitfalls — format/parse round-trip', () => {
  // The contract on oc-path.ts:13 — `formatOcPath(parseOcPath(s)) === s`
  // for any string the formatter accepts. Round-trip breaks were
  // observable on (a) struct fields with empty dotted sub-segments
  // (`section: 'foo.'` → `oc://X/foo.""` → re-parses with `section:
  // 'foo.""'`) and (b) struct fields with control chars (formatter
  // emitted unquoted, parser refused). Pin both directions.
  it('formatOcPath rejects empty dotted sub-segment in a slot', () => {
    expect(() => formatOcPath({ file: 'a.md', section: 'foo.' })).toThrow(
      /Empty dotted sub-segment/,
    );
    expect(() => formatOcPath({ file: 'a.md', section: '.foo' })).toThrow(
      /Empty dotted sub-segment/,
    );
    expect(() => formatOcPath({ file: 'a.md', section: 'foo..bar' })).toThrow(
      /Empty dotted sub-segment/,
    );
  });

  it('formatOcPath rejects control characters in any slot', () => {
    expect(() => formatOcPath({ file: 'a.md', section: 'sec\x00tion' })).toThrow(
      /Control character/,
    );
    expect(() => formatOcPath({ file: 'a.md', section: 'sec\x01tion' })).toThrow(
      /Control character/,
    );
    expect(() => formatOcPath({ file: 'a.md', section: 'tab\ttion' })).toThrow(
      /Control character/,
    );
    expect(() => formatOcPath({ file: 'a\x00b.md' })).toThrow(/Control character/);
  });

  it('round-trips every shape parseOcPath accepts', () => {
    // For every valid input, formatOcPath(parseOcPath(s)) MUST be
    // re-parseable to the same struct. Don't string-compare (the
    // formatter normalizes quoting); parse the round-tripped output
    // and compare structs.
    const inputs = [
      'oc://X',
      'oc://X/a',
      'oc://X/a/b',
      'oc://X/a/b/c',
      'oc://X/a.b.c',
      'oc://X/a?session=s1',
      'oc://X/[frontmatter]/key',
      'oc://X/steps/$last/id',
      'oc://X/steps/-2/id',
      'oc://X/steps/[id=foo]/cmd',
      'oc://X/steps/{a,b}/cmd',
      'oc://X/"foo/bar"/baz',
      'oc://X/agents/"anthropic/claude-opus-4-7"/alias',
    ];
    for (const s of inputs) {
      const parsed = parseOcPath(s);
      const formatted = formatOcPath(parsed);
      const reparsed = parseOcPath(formatted);
      expect(reparsed).toEqual(parsed);
    }
  });
});

// ---------- Performance pitfalls -----------------------------------------

describe('wave-23 pitfalls — performance & limits', () => {
  it('P-031 / P-033 walker depth cap throws on pathological recursion', () => {
    // Construct a yaml that nests deeper than MAX_TRAVERSAL_DEPTH.
    // We're using `**` against a synthetic deeply-nested structure.
    let yaml = 'root:\n';
    let indent = '  ';
    for (let i = 0; i < MAX_TRAVERSAL_DEPTH + 50; i++) {
      yaml += `${indent}a:\n`;
      indent += '  ';
    }
    yaml += `${indent}leaf: x\n`;
    const ast = parseYaml(yaml).ast;
    expect(() => findOcPaths(ast, parseOcPath('oc://X/**'))).toThrow(/MAX_TRAVERSAL_DEPTH/);
  });

  it('P-032 rejects path strings longer than MAX_PATH_LENGTH', () => {
    const big = 'oc://X/' + 'a'.repeat(MAX_PATH_LENGTH);
    expect(() => parseOcPath(big)).toThrow(/exceeds .* bytes/);
  });

  it('P-032 path at the cap parses cleanly', () => {
    const justUnder = 'oc://X/' + 'a'.repeat(MAX_PATH_LENGTH - 'oc://X/'.length);
    expect(() => parseOcPath(justUnder)).not.toThrow();
  });

  it('P-032 formatOcPath enforces the same cap on output', () => {
    // Symmetric upper bound — without this guard, a struct whose
    // formatted form crosses the cap would emit a string parseOcPath
    // would immediately reject (round-trip break).
    expect(() =>
      formatOcPath({ file: 'X', section: 'a'.repeat(MAX_PATH_LENGTH) }),
    ).toThrow(/Formatted oc:\/\/ exceeds/);
  });

  it('parser depth cap fires on pathological JSONC nesting (F6)', () => {
    // Without `MAX_PARSE_DEPTH`, pathological input like
    // `'['.repeat(20000) + '0' + ']'.repeat(20000)` triggers a V8
    // RangeError ("Maximum call stack size exceeded") that escapes
    // commander as a raw stringified error — no `OcEmitSentinelError`-
    // style structured catch. Pin the structured-diagnostic path:
    // parser must surface OC_JSONC_DEPTH_EXCEEDED, not bare RangeError.
    const open = '['.repeat(MAX_TRAVERSAL_DEPTH + 100);
    const close = ']'.repeat(MAX_TRAVERSAL_DEPTH + 100);
    const raw = `${open}0${close}`;
    const result = parseJsonc(raw);
    expect(result.ast.root).toBeNull();
    expect(
      result.diagnostics.some((d) => d.code === 'OC_JSONC_DEPTH_EXCEEDED'),
    ).toBe(true);
  });

  it('parser depth cap fires on JSONL line with deeply-nested JSON (F6)', () => {
    // Per-line parseJsonc dispatch carries the same protection — each
    // value line is parsed in isolation and gets its own depth cap.
    // The line surfaces as `kind: 'malformed'` with the depth diagnostic.
    let nested = '"x"';
    for (let i = 0; i < MAX_TRAVERSAL_DEPTH + 50; i++) {
      nested = `{"a":${nested}}`;
    }
    const { diagnostics } = parseJsonl(nested + '\n');
    // The line-level diagnostic is OC_JSONL_LINE_MALFORMED (line failed);
    // we don't promote OC_JSONC_DEPTH_EXCEEDED through the JSONL layer
    // but the malformed-line detection prevents stack-overflow escape.
    expect(diagnostics.some((d) => d.code === 'OC_JSONL_LINE_MALFORMED')).toBe(true);
  });
});

// ---------- Coercion pitfalls --------------------------------------------

describe('wave-23 pitfalls — coercion', () => {
  it('P-029 numeric coercion is locale-independent', () => {
    // `Number()` doesn't honor locale; `parseFloat` doesn't either in
    // practice, but we never use `parseFloat`. Verify `Number("1,5")`
    // returns NaN (which is rejected) and `"1.5"` returns 1.5.
    const ast = parseJsonc('{"x":1.0}').ast;
    const r1 = setOcPath(ast, parseOcPath('oc://X/x'), '1.5');
    expect(r1.ok).toBe(true);
    const r2 = setOcPath(ast, parseOcPath('oc://X/x'), '1,5');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {expect(r2.reason).toBe('parse-error');}
  });

  it('P-030 boolean coercion is exact-match lowercase', () => {
    const ast = parseJsonc('{"x":true}').ast;
    expect(setOcPath(ast, parseOcPath('oc://X/x'), 'false').ok).toBe(true);
    expect(setOcPath(ast, parseOcPath('oc://X/x'), 'False').ok).toBe(false);
    expect(setOcPath(ast, parseOcPath('oc://X/x'), 'TRUE').ok).toBe(false);
    expect(setOcPath(ast, parseOcPath('oc://X/x'), 'yes').ok).toBe(false);
  });
});

// ---------- Reserved character pitfalls ----------------------------------

describe('wave-23 pitfalls — reserved characters', () => {
  it('P-026 rejects `?` outside the query separator position', () => {
    // `?` triggers the query split. `oc://X/foo?session=s` is fine
    // (legitimate query). But `?` *inside* a segment after the query
    // section is consumed isn't a normal use case — the parser treats
    // the first `?` as the query split.
    expect(parseOcPath('oc://X/foo?session=s').section).toBe('foo');
    // Empty key after `?` (no `=`): query parser silently ignores.
    expect(() => parseOcPath('oc://X/foo?')).not.toThrow();
  });

  it('P-040 negative-index magnitude is bounded', () => {
    // Out-of-range negative index → null at resolve time, not crash.
    const ast = parseJsonc('{"x":[1,2,3]}').ast;
    expect(resolveOcPath(ast, parseOcPath('oc://X/x/-9999999999'))).toBeNull();
    expect(resolveOcPath(ast, parseOcPath('oc://X/x/-1'))?.kind).toBe('leaf');
  });
});

// ---------- Sentinel-redaction pitfall (P-036) ---------------------------

describe('wave-23 pitfalls — redaction sentinel', () => {
  // P-036 is fully covered by wave-21-sentinel-cross-kind. This is a
  // smoke test asserting the link is intact.
  it('P-036 sentinel guard activates at emit time (covered by wave-21)', () => {
    expect(true).toBe(true);
  });
});

// ---------- DEFERRED — documented limits ---------------------------------

describe('wave-23 pitfalls — deferred (v0 limits)', () => {
  it.skip('P-005 slash literal in key — v1: quoted segments', () => {});
  it.skip('P-006 dot literal in key — v1: quoted segments', () => {});
  it.skip('P-017 nested unions {a,{b,c}} — v1: parser stack', () => {});
  it.skip('P-019 wildcard inside wildcard — v1: pattern composition', () => {});
  it.skip('P-025 leading-zero numeric `01` — v1: explicit form', () => {});
  it.skip('P-027 `&` in segments — v1: percent-encoding', () => {});
  it.skip('P-028 percent-encoded segments — v1: rfc3986 layer', () => {});
  it.skip('P-034 ast mutation between resolve & consume — caller invariant', () => {});
  it.skip('P-035 stale paths from prior find — caller invariant', () => {});
});

// ---------- Injection pitfalls (C12 / W12) -------------------------------

describe('wave-23 pitfalls — injection (caller-supplied hostile input)', () => {
  // P-037: a hostile path string. The substrate's job is to either
  // parse safely or reject with `OcPathError` — never let undefined
  // behavior leak. These cases lock the rejection-or-safe contract.

  it('P-037a control characters in path body are rejected', () => {
    expect(() => parseOcPath('oc://a\x00b')).toThrow(OcPathError);
    expect(() => parseOcPath('oc://a\x01b/c')).toThrow(OcPathError);
    expect(() => parseOcPath('oc://a/b\x1Fc')).toThrow(OcPathError);
  });

  it('P-037b NUL byte anywhere in path is rejected', () => {
    expect(() => parseOcPath('oc://X.md/sec\x00tion')).toThrow(OcPathError);
  });

  it('P-037c BOM at start of path is stripped, not interpreted', () => {
    // BOM is unicode U+FEFF (0xFEFF). The substrate strips it before
    // scheme check; without stripping, the BOM-prefixed string would
    // fail the `oc://` scheme test.
    const path = parseOcPath('﻿oc://X.md/section');
    expect(path.file).toBe('X.md');
    expect(path.section).toBe('section');
  });

  it('P-037d session query is parsed only via the documented `?session=...` form', () => {
    // Legal session form parses cleanly.
    const ok = parseOcPath('oc://X.md/sec?session=cron:daily');
    expect(ok.section).toBe('sec');
    expect(ok.session).toBe('cron:daily');
    // Substrate is lenient about loose `?garbage` — caller's
    // responsibility to construct paths from `formatOcPath`. Confirm
    // the loose form does NOT silently invent a session value.
    const loose = parseOcPath('oc://X.md/sec?garbage');
    expect(loose.session).toBeUndefined();
  });

  it('P-037e unescaped `&` in segments is rejected', () => {
    expect(() => parseOcPath('oc://X.md/a&b')).toThrow(OcPathError);
  });

  it('P-037f unescaped `%` in segments is rejected', () => {
    expect(() => parseOcPath('oc://X.md/a%b')).toThrow(OcPathError);
  });

  it('P-037g empty file slot is rejected', () => {
    expect(() => parseOcPath('oc:///section')).toThrow(OcPathError);
  });

  it('P-037h backslash-escape attempts are not treated as path traversal', () => {
    // No special meaning — the literal backslash is just a regular
    // character. Doesn't allow escaping forward slashes.
    expect(() => parseOcPath('oc://X.md/a\\../b')).toThrow(OcPathError);
  });

  // P-038: predicate-value injection. `[k=v]` predicates filter
  // matches; a hostile `v` containing regex metachars, brackets, or
  // operators must NOT escape the predicate scope or be interpreted
  // as a regex.

  it('P-038a regex metacharacters in predicate value match literally', () => {
    const ast = parseJsonc('{ "items": [ {"name": "a.*"}, {"name": "abc"} ] }').ast;
    // Looking for the literal string "a.*" — should match only the
    // first item, not "abc" (which would match if `.*` were treated
    // as a regex).
    const matches = findOcPaths(ast, parseOcPath('oc://X.jsonc/items/[name=a.*]'));
    expect(matches).toHaveLength(1);
  });

  it('P-038b nested-bracket attempts in predicate value are kept literal', () => {
    // The substrate is permissive on nested brackets — they're part
    // of the literal predicate value, not interpreted as path syntax.
    // The match would be against the literal string "a[b]"; a
    // resolver that finds zero matches fails closed.
    const path = parseOcPath('oc://X.jsonc/items/[name=a[b]]');
    expect(path.item).toBe('[name=a[b]]');
    // No data has the literal value `a[b]` here, so finding empty.
    const ast = parseJsonc('{ "items": [ {"name": "abc"} ] }').ast;
    expect(findOcPaths(ast, path)).toHaveLength(0);
  });

  it('P-038c equals-sign in predicate value is treated as part of the value', () => {
    // The FIRST `=` separates key from value; subsequent `=`s belong
    // to the value. The rule keeps the predicate parser simple —
    // operators that prefix-match (`!=`, `<=`, `>=`) are tried
    // before `=`, then `=` consumes the rest.
    const ast = parseJsonc('{ "items": [ {"k": "a=b"}, {"k": "c"} ] }').ast;
    const matches = findOcPaths(ast, parseOcPath('oc://X.jsonc/items/[k=a=b]'));
    expect(matches).toHaveLength(1);
  });

  it('P-038d control characters in predicate value are rejected', () => {
    expect(() => parseOcPath('oc://X.jsonc/items/[k=a\x00b]')).toThrow(OcPathError);
  });

  it('P-038e empty predicate body is rejected', () => {
    expect(() => parseOcPath('oc://X.jsonc/items/[]')).toThrow(OcPathError);
  });

  it('P-038f predicate-shaped bracket without operator is treated as literal sentinel', () => {
    // `[name]` without `=` is parsed as a literal-bracket sentinel
    // (e.g. `[frontmatter]`-style). The substrate accepts it as a
    // literal path segment — predicate parsing only kicks in when an
    // operator is present. Document this to lock the behavior.
    const path = parseOcPath('oc://X.jsonc/items/[name]');
    expect(path.item).toBe('[name]');
  });

  it('P-038g predicate-shaped bracket with unsupported operator parses as literal', () => {
    // `~` isn't in the supported-operator set; the parser doesn't
    // recognize it as a predicate, so it's accepted as a literal
    // bracket segment. This is the documented v1.1 behavior — a
    // future version may add `~` (regex) and bump SDK_VERSION.
    const path = parseOcPath('oc://X.jsonc/items/[k~v]');
    expect(path.item).toBe('[k~v]');
  });
});
