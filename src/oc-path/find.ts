/**
 * `findOcPaths` — universal multi-match verb. Pattern syntax extends
 * `OcPath` with two wildcard tokens:
 *
 *   `*`   — match a single sub-segment (one map key / one array index)
 *   `**`  — match zero or more sub-segments at any depth (recursive)
 *
 * **Why a separate verb**: `resolveOcPath` and `setOcPath` are
 * single-match — they require an exact path because they return one
 * value or write one leaf. A pattern would be ambiguous. `findOcPaths`
 * is the search verb: pass a pattern, get every concrete OcPath that
 * matches plus its `OcMatch` (kind + leaf text / node descriptor).
 *
 * Every returned `OcPathMatch` carries a concrete (wildcard-free)
 * `OcPath`, so callers can pipe results through `setOcPath` or
 * `resolveOcPath` without rebuilding the path. The slot shape of the
 * input pattern is preserved (a `*` in the `item` slot produces a
 * concrete path with the matched value still in `item`).
 *
 * **Use cases driving v0**:
 *   - lint rules iterating `oc://workflow.lobster/steps/* /command`
 *   - jsonl session walks `oc://session/* /eventType`
 *   - md frontmatter sweeps `oc://SOUL.md/[frontmatter]/*`
 *
 * @module @openclaw/oc-path/find
 */

import { isMap, isScalar, isSeq, type Node, type Pair } from 'yaml';
import type { JsoncValue } from './jsonc/ast.js';
import type { JsonlAst, JsonlLine } from './jsonl/ast.js';
import type { MdAst } from './ast.js';
import type { OcPath } from './oc-path.js';
import {
  MAX_TRAVERSAL_DEPTH,
  OcPathError,
  WILDCARD_RECURSIVE,
  WILDCARD_SINGLE,
  evaluatePredicate,
  isOrdinalSeg,
  isPositionalSeg,
  isPredicateSeg,
  isQuotedSeg,
  isUnionSeg,
  parseOrdinalSeg,
  parsePredicateSeg,
  parseUnionSeg,
  quoteSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from './oc-path.js';
import type { PredicateSpec } from './oc-path.js';
import type { OcAst, OcMatch } from './universal.js';
import { resolveOcPath } from './universal.js';

// ---------- Public types ---------------------------------------------------

/** A find result: a concrete (wildcard-free) path plus its match info. */
export interface OcPathMatch {
  readonly path: OcPath;
  readonly match: OcMatch;
}

/**
 * The slot a sub-segment came from in the input pattern. Walker outputs
 * carry slot tags so re-packing into `OcPath` preserves the pattern's
 * shape (a `*` in the `item` slot produces a path with the matched
 * value in `item`, not joined into `section`).
 */
type Slot = 'section' | 'item' | 'field';
interface SlotSub {
  readonly slot: Slot;
  readonly value: string;
}

/** A single tagged sub-segment of the pattern (post dot-split). */
interface PatternSub {
  readonly slot: Slot;
  readonly value: string;
}

// ---------- Public verb ----------------------------------------------------

/**
 * Match `pattern` against `ast` and return every concrete OcPath that
 * resolves. Empty array when nothing matches.
 *
 * Pattern semantics: same shape as `OcPath`, but any sub-segment may be
 * `*` (single-segment wildcard) or `**` (recursive descent). A pattern
 * with no wildcards is equivalent to a single `resolveOcPath` call,
 * wrapped into the find shape.
 *
 * **Insertion-marker patterns are not supported**: a `+`/`+key`/`+nnn`
 * suffix is meaningless in find context (you don't search for a place
 * to insert). Such patterns return an empty array.
 */
export function findOcPaths(ast: OcAst, pattern: OcPath): readonly OcPathMatch[] {
  const subs = patternSubs(pattern);
  // Fast-path: no expansion needed — pure literals just resolve.
  // Anything that can yield 0+ matches (wildcard, positional, union,
  // predicate) flows through the walker.
  const needsExpansion = subs.some(
    (s) =>
      s.value === WILDCARD_SINGLE ||
      s.value === WILDCARD_RECURSIVE ||
      isPositionalSeg(s.value) ||
      isUnionSeg(s.value) ||
      isPredicateSeg(s.value),
  );
  if (!needsExpansion) {
    const m = resolveOcPath(ast, pattern);
    return m === null ? [] : [{ path: pattern, match: m }];
  }
  const concretePaths = expand(ast, subs, pattern);

  const out: OcPathMatch[] = [];
  for (const concrete of concretePaths) {
    const m = resolveOcPath(ast, concrete);
    if (m !== null) {out.push({ path: concrete, match: m });}
  }
  return out;
}

// ---------- Pattern unpacking ---------------------------------------------

function patternSubs(pattern: OcPath): readonly PatternSub[] {
  const out: PatternSub[] = [];
  // Bracket-aware split so dots inside `[k=1.0]` or `{a.b,c}` aren't
  // treated as sub-segment delimiters (P-012/P-013).
  if (pattern.section !== undefined) {
    for (const v of splitRespectingBrackets(pattern.section, '.')) {out.push({ slot: 'section', value: v });}
  }
  if (pattern.item !== undefined) {
    for (const v of splitRespectingBrackets(pattern.item, '.')) {out.push({ slot: 'item', value: v });}
  }
  if (pattern.field !== undefined) {
    for (const v of splitRespectingBrackets(pattern.field, '.')) {out.push({ slot: 'field', value: v });}
  }
  return out;
}

function repackSlotSubs(pattern: OcPath, slotSubs: readonly SlotSub[]): OcPath {
  const sectionSubs: string[] = [];
  const itemSubs: string[] = [];
  const fieldSubs: string[] = [];
  for (const s of slotSubs) {
    if (s.slot === 'section') {sectionSubs.push(s.value);}
    else if (s.slot === 'item') {itemSubs.push(s.value);}
    else {fieldSubs.push(s.value);}
  }
  return {
    file: pattern.file,
    ...(sectionSubs.length > 0 ? { section: sectionSubs.join('.') } : {}),
    ...(itemSubs.length > 0 ? { item: itemSubs.join('.') } : {}),
    ...(fieldSubs.length > 0 ? { field: fieldSubs.join('.') } : {}),
    ...(pattern.session !== undefined ? { session: pattern.session } : {}),
  };
}

// ---------- Per-kind dispatch ---------------------------------------------

function expand(ast: OcAst, subs: readonly PatternSub[], pattern: OcPath): readonly OcPath[] {
  const concretePaths: OcPath[] = [];
  // Walker enumerates concrete sub-segments by walking the AST against
  // `subs`, emitting one slot-tagged-sub list per leaf. Each list is
  // re-packed into an OcPath preserving the pattern's slot shape.
  const onMatch = (slotSubs: readonly SlotSub[]): void => {
    concretePaths.push(repackSlotSubs(pattern, slotSubs));
  };
  switch (ast.kind) {
    case 'yaml':
      walkYaml(ast.doc.contents as Node | null, subs, 0, [], onMatch);
      break;
    case 'jsonc':
      if (ast.root !== null) {walkJsonc(ast.root, subs, 0, [], onMatch);}
      break;
    case 'jsonl':
      walkJsonl(ast, subs, 0, [], onMatch);
      break;
    case 'md':
      walkMd(ast, subs, 0, [], onMatch);
      break;
  }
  return concretePaths;
}

// ---------- YAML walker ----------------------------------------------------

function walkYaml(
  node: Node | null,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: (subs: readonly SlotSub[]) => void,
): void {
  // P-031 / P-033 (substrate pitfall taxonomy — see
  // `oc-paths-substrate/PITFALLS.md`) — depth cap kills runaway
  // recursion from `**` over deeply nested ASTs and from yaml-anchor
  // cycles (a cycle just makes recursion unbounded). Cap is liberal
  // (256) — real workspaces top out around 50 — and covers both
  // pitfalls with one defense.
  if (walked.length > MAX_TRAVERSAL_DEPTH) {
    throw new OcPathError(
      `findOcPaths exceeded MAX_TRAVERSAL_DEPTH (${MAX_TRAVERSAL_DEPTH}) — likely a cycle or pathological pattern`,
      '',
      'OC_PATH_DEPTH_EXCEEDED',
    );
  }
  // Out of pattern → emit at whatever node we landed on.
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  if (node === null) {return;}
  let cur = subs[i];

  // Union `{a,b,c}` — fan out into one walk per alternative. Each
  // alternative replaces `cur.value` with the chosen literal.
  if (isUnionSeg(cur.value)) {
    const alts = parseUnionSeg(cur.value);
    if (alts === null) {return;}
    for (const alt of alts) {
      const altSubs = subs.slice();
      altSubs[i] = { slot: cur.slot, value: alt };
      walkYaml(node, altSubs, i, walked, onMatch);
    }
    return;
  }

  // Predicate `[key<op>value]` — like wildcard, but emit only children
  // whose `key` field matches the predicate.
  if (isPredicateSeg(cur.value)) {
    const pred = parsePredicateSeg(cur.value);
    if (pred === null) {return;}
    if (isMap(node)) {
      for (const pair of (node as { items: Pair[] }).items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        const childVal = pair.value as Node;
        if (yamlChildMatchesPredicate(childVal, pred)) {
          walkYaml(childVal, subs, i + 1, [...walked, { slot: cur.slot, value: quoteSeg(k) }], onMatch);
        }
      }
    } else if (isSeq(node)) {
      (node as { items: Node[] }).items.forEach((child, idx) => {
        if (yamlChildMatchesPredicate(child, pred)) {
          walkYaml(child, subs, i + 1, [...walked, { slot: cur.slot, value: String(idx) }], onMatch);
        }
      });
    }
    return;
  }

  // Positional tokens (`$first` / `$last` / `-N`) → resolve to a
  // single concrete segment and descend as if the pattern had carried
  // that literal. Walker then continues with the concrete value, so
  // emitted paths carry the resolved index/key.
  if (isPositionalSeg(cur.value)) {
    const concrete = positionalForYamlNode(node, cur.value);
    if (concrete === null) {return;}
    cur = { slot: cur.slot, value: concrete };
  }

  // `**` — match 0 or more segments.
  if (cur.value === WILDCARD_RECURSIVE) {
    // 0-match: skip past `**`, retry pattern at this node.
    walkYaml(node, subs, i + 1, walked, onMatch);
    // 1+ match: descend one step, stay on this `**` slot.
    if (isMap(node)) {
      for (const pair of (node as { items: Pair[] }).items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        walkYaml(pair.value as Node, subs, i, [...walked, { slot: cur.slot, value: quoteSeg(k) }], onMatch);
      }
    } else if (isSeq(node)) {
      (node as { items: Node[] }).items.forEach((child, idx) => {
        walkYaml(child, subs, i, [...walked, { slot: cur.slot, value: String(idx) }], onMatch);
      });
    }
    return;
  }

  // `*` — match exactly one segment.
  if (cur.value === WILDCARD_SINGLE) {
    if (isMap(node)) {
      for (const pair of (node as { items: Pair[] }).items) {
        const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        walkYaml(pair.value as Node, subs, i + 1, [...walked, { slot: cur.slot, value: quoteSeg(k) }], onMatch);
      }
    } else if (isSeq(node)) {
      (node as { items: Node[] }).items.forEach((child, idx) => {
        walkYaml(child, subs, i + 1, [...walked, { slot: cur.slot, value: String(idx) }], onMatch);
      });
    }
    return;
  }

  // Literal — descend exactly into the matching key/index.
  // Literal lookup — quoted segments unwrap to their literal key form.
  const literal = isQuotedSeg(cur.value) ? unquoteSeg(cur.value) : cur.value;
  if (isMap(node)) {
    const pair = (node as { items: Pair[] }).items.find((p) => {
      const k = isScalar(p.key) ? String(p.key.value) : String(p.key);
      return k === literal;
    });
    if (pair === undefined) {return;}
    walkYaml(
      pair.value as Node,
      subs,
      i + 1,
      [...walked, { slot: cur.slot, value: cur.value }],
      onMatch,
    );
    return;
  }
  if (isSeq(node)) {
    const idx = Number(literal);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (node as { items: Node[] }).items.length) {return;}
    walkYaml(
      (node as { items: Node[] }).items[idx],
      subs,
      i + 1,
      [...walked, { slot: cur.slot, value: cur.value }],
      onMatch,
    );
    return;
  }
}

// ---------- JSONC walker ---------------------------------------------------

function walkJsonc(
  node: JsoncValue,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: (subs: readonly SlotSub[]) => void,
): void {
  if (walked.length > MAX_TRAVERSAL_DEPTH) {
    throw new OcPathError(
      `findOcPaths exceeded MAX_TRAVERSAL_DEPTH (${MAX_TRAVERSAL_DEPTH}) — likely a pathological pattern`,
      '',
      'OC_PATH_DEPTH_EXCEEDED',
    );
  }
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  let cur = subs[i];

  if (isUnionSeg(cur.value)) {
    const alts = parseUnionSeg(cur.value);
    if (alts === null) {return;}
    for (const alt of alts) {
      const altSubs = subs.slice();
      altSubs[i] = { slot: cur.slot, value: alt };
      walkJsonc(node, altSubs, i, walked, onMatch);
    }
    return;
  }

  if (isPredicateSeg(cur.value)) {
    const pred = parsePredicateSeg(cur.value);
    if (pred === null) {return;}
    if (node.kind === 'object') {
      for (const e of node.entries) {
        if (jsoncChildMatchesPredicate(e.value, pred)) {
          walkJsonc(e.value, subs, i + 1, [...walked, { slot: cur.slot, value: quoteSeg(e.key) }], onMatch);
        }
      }
    } else if (node.kind === 'array') {
      node.items.forEach((child, idx) => {
        if (jsoncChildMatchesPredicate(child, pred)) {
          walkJsonc(child, subs, i + 1, [...walked, { slot: cur.slot, value: String(idx) }], onMatch);
        }
      });
    }
    return;
  }

  if (isPositionalSeg(cur.value)) {
    const concrete = positionalForJsoncNode(node, cur.value);
    if (concrete === null) {return;}
    cur = { slot: cur.slot, value: concrete };
  }

  if (cur.value === WILDCARD_RECURSIVE) {
    walkJsonc(node, subs, i + 1, walked, onMatch);
    if (node.kind === 'object') {
      for (const e of node.entries) {
        walkJsonc(e.value, subs, i, [...walked, { slot: cur.slot, value: quoteSeg(e.key) }], onMatch);
      }
    } else if (node.kind === 'array') {
      node.items.forEach((child, idx) => {
        walkJsonc(child, subs, i, [...walked, { slot: cur.slot, value: String(idx) }], onMatch);
      });
    }
    return;
  }

  if (cur.value === WILDCARD_SINGLE) {
    if (node.kind === 'object') {
      for (const e of node.entries) {
        walkJsonc(e.value, subs, i + 1, [...walked, { slot: cur.slot, value: quoteSeg(e.key) }], onMatch);
      }
    } else if (node.kind === 'array') {
      node.items.forEach((child, idx) => {
        walkJsonc(child, subs, i + 1, [...walked, { slot: cur.slot, value: String(idx) }], onMatch);
      });
    }
    return;
  }

  if (node.kind === 'object') {
    // `cur.value` may be a quoted segment (e.g. `"a/b"`); AST entry
    // keys are already unquoted. Strip the quotes before comparing
    // so the find-expansion walker matches `resolveJsoncOcPath`'s
    // unquoting behavior — closes the resolve-vs-find asymmetry
    // flagged on PR #78678.
    const lookupKey = isQuotedSeg(cur.value) ? unquoteSeg(cur.value) : cur.value;
    const e = node.entries.find((entry) => entry.key === lookupKey);
    if (e === undefined) {return;}
    walkJsonc(e.value, subs, i + 1, [...walked, { slot: cur.slot, value: cur.value }], onMatch);
    return;
  }
  if (node.kind === 'array') {
    const idx = Number(cur.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) {return;}
    walkJsonc(node.items[idx], subs, i + 1, [...walked, { slot: cur.slot, value: cur.value }], onMatch);
  }
}

// ---------- JSONL walker ---------------------------------------------------

function walkJsonl(
  ast: JsonlAst,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: (subs: readonly SlotSub[]) => void,
): void {
  // Bound recursion at the line-enumeration layer — without this guard,
  // a `**` pattern over a 100k-line forensic log dispatches per-line
  // walkJsonc (which has its own guard) but the JSONL outer driver has
  // no per-walker depth bound. JSONL session logs are exactly the kind
  // of file that grows unbounded in production (replay, audit), so
  // defense-in-depth at the outer layer mirrors the yaml/jsonc walkers.
  if (walked.length > MAX_TRAVERSAL_DEPTH) {
    throw new OcPathError(
      `findOcPaths exceeded MAX_TRAVERSAL_DEPTH (${MAX_TRAVERSAL_DEPTH}) — likely a pathological JSONL pattern`,
      '',
      'OC_PATH_DEPTH_EXCEEDED',
    );
  }
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  const cur = subs[i];

  // Line-address slot — `*` enumerates every value line; `**` adds a
  // 0-segment skip in addition to enumerating; literal matches `Lnnn`
  // / `$first` / `$last` / `-N` (negative index); union matches each
  // alternative; predicate filters by per-line top-level field.
  // The first sub MUST address a line; deeper subs walk inside the
  // line's JSON value.
  if (walked.length === 0) {
    if (cur.value === WILDCARD_RECURSIVE) {
      // 0-match has no meaning for jsonl (the file root has no leaves);
      // every remaining match must include a line. So skip the 0-match
      // expansion and only enumerate.
      forEachValueLine(ast, (l, addr) => {
        walkJsonlInsideLine(l, subs, i, [{ slot: cur.slot, value: addr }], onMatch);
      });
      return;
    }
    if (cur.value === WILDCARD_SINGLE) {
      forEachValueLine(ast, (l, addr) => {
        walkJsonlInsideLine(l, subs, i + 1, [{ slot: cur.slot, value: addr }], onMatch);
      });
      return;
    }
    if (isUnionSeg(cur.value)) {
      // `{L1,L2}` enumerates each alternative independently — yaml /
      // jsonc walkers handle union uniformly at every slot, so the
      // jsonl line slot must too. Each alternative goes through the
      // same single-line resolution as a literal `Lnnn` / `$first` /
      // `-N` would (so unions of positional tokens, e.g. `{L1,$last}`,
      // work as expected).
      const alts = parseUnionSeg(cur.value);
      if (alts === null) {return;}
      for (const alt of alts) {
        const line = pickLine(ast, alt);
        if (line === null) {continue;}
        const concreteAddr = line.kind === 'value' ? `L${line.line}` : alt;
        walkJsonlInsideLine(line, subs, i + 1, [{ slot: cur.slot, value: concreteAddr }], onMatch);
      }
      return;
    }
    if (isPredicateSeg(cur.value)) {
      // `[event=foo]` filters value lines by the predicate's key/op
      // applied to the top-level field of each line's parsed JSON.
      // Parsing is structural (no recursion into nested children) —
      // a predicate inside a line's body uses the same syntax inside
      // the JSONC walker's predicate path.
      const pred = parsePredicateSeg(cur.value);
      if (pred === null) {return;}
      forEachValueLine(ast, (l, addr) => {
        if (l.kind !== 'value') {return;}
        const actual = topLevelLeafText(l.value, pred.key);
        if (!evaluatePredicate(actual, pred)) {return;}
        walkJsonlInsideLine(l, subs, i + 1, [{ slot: cur.slot, value: addr }], onMatch);
      });
      return;
    }
    // Positional / Lnnn / literal — pickLine handles all single-line
    // addressing tokens. The emitted concrete address is `Lnnn` (the
    // canonical line-address form) regardless of how it was looked up.
    const line = pickLine(ast, cur.value);
    if (line === null) {return;}
    const concreteAddr = line.kind === 'value' ? `L${line.line}` : cur.value;
    walkJsonlInsideLine(line, subs, i + 1, [{ slot: cur.slot, value: concreteAddr }], onMatch);
    return;
  }
}

/**
 * Stringify the top-level field's leaf value for predicate evaluation
 * at the jsonl line slot. Only string/number/boolean/null leaves
 * compare; nested objects/arrays return `null` (predicate doesn't
 * match a non-leaf sibling).
 */
function topLevelLeafText(value: JsoncValue, key: string): string | null {
  if (value.kind !== 'object') {return null;}
  const entry = value.entries.find((e) => e.key === key);
  if (entry === undefined) {return null;}
  const v = entry.value;
  if (v.kind === 'string') {return v.value;}
  if (v.kind === 'number' || v.kind === 'boolean') {return String(v.value);}
  if (v.kind === 'null') {return null;}
  return null;
}

function walkJsonlInsideLine(
  line: JsonlLine,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: (subs: readonly SlotSub[]) => void,
): void {
  // Mirror the outer guard so a hostile pattern that bypasses the
  // top-of-walkJsonl path (e.g., reached via direct call from a future
  // helper) still lands on the depth bound. walkJsonc inside has its
  // own bound, but the slot-sub list extends across both layers — the
  // depth check must consider the full `walked` history.
  if (walked.length > MAX_TRAVERSAL_DEPTH) {
    throw new OcPathError(
      `findOcPaths exceeded MAX_TRAVERSAL_DEPTH (${MAX_TRAVERSAL_DEPTH}) — likely a pathological JSONL pattern`,
      '',
      'OC_PATH_DEPTH_EXCEEDED',
    );
  }
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  if (line.kind !== 'value') {return;}
  walkJsonc(line.value, subs, i, walked, onMatch);
}

function forEachValueLine(
  ast: JsonlAst,
  visit: (line: JsonlLine, addr: string) => void,
): void {
  for (const l of ast.lines) {
    if (l.kind === 'value') {visit(l, `L${l.line}`);}
  }
}

function pickLine(ast: JsonlAst, addr: string): JsonlLine | null {
  if (addr === '$last') {
    for (let i = ast.lines.length - 1; i >= 0; i--) {
      const l = ast.lines[i];
      if (l !== undefined && l.kind === 'value') {return l;}
    }
    return null;
  }
  if (addr === '$first') {
    for (const l of ast.lines) {
      if (l.kind === 'value') {return l;}
    }
    return null;
  }
  if (/^-\d+$/.test(addr)) {
    const valueLines = ast.lines.filter((l): l is Extract<JsonlLine, { kind: 'value' }> => l.kind === 'value');
    const n = valueLines.length + Number(addr);
    return n >= 0 && n < valueLines.length ? valueLines[n] : null;
  }
  const m = /^L(\d+)$/.exec(addr);
  if (m === null || m[1] === undefined) {return null;}
  const target = Number(m[1]);
  for (const l of ast.lines) {
    if (l.line === target) {return l;}
  }
  return null;
}

// Helpers shared by the walkers above.
function positionalForYamlNode(node: Node, seg: string): string | null {
  if (isMap(node)) {
    const pairs = (node as { items: Pair[] }).items;
    const keys = pairs.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (isSeq(node)) {
    const items = (node as { items: Node[] }).items;
    return resolvePositionalSeg(seg, { indexable: true, size: items.length });
  }
  return null;
}

function positionalForJsoncNode(node: JsoncValue, seg: string): string | null {
  if (node.kind === 'object') {
    const keys = node.entries.map((e) => e.key);
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (node.kind === 'array') {
    return resolvePositionalSeg(seg, { indexable: true, size: node.items.length });
  }
  return null;
}

// Predicate-evaluation helpers: look up `node[key]` and compare its
// string-coerced leaf value via `evaluatePredicate`. Used by
// `[key<op>value]` filtering in find walkers.
function yamlChildMatchesPredicate(node: Node | null, pred: PredicateSpec): boolean {
  return evaluatePredicate(yamlChildFieldText(node, pred.key), pred);
}

function yamlChildFieldText(node: Node | null, key: string): string | null {
  if (node === null) {return null;}
  if (!isMap(node)) {return null;}
  for (const pair of (node as { items: Pair[] }).items) {
    const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (k !== key) {continue;}
    const v = pair.value;
    if (isScalar(v)) {
      const sv = v.value;
      if (sv === null) {return 'null';}
      if (typeof sv === 'string') {return sv;}
      if (typeof sv === 'number' || typeof sv === 'boolean') {return String(sv);}
      return JSON.stringify(sv) ?? 'null';
    }
    return null;
  }
  return null;
}

function jsoncChildMatchesPredicate(node: JsoncValue, pred: PredicateSpec): boolean {
  return evaluatePredicate(jsoncChildFieldText(node, pred.key), pred);
}

function jsoncChildFieldText(node: JsoncValue, key: string): string | null {
  if (node.kind !== 'object') {return null;}
  const e = node.entries.find((entry) => entry.key === key);
  if (e === undefined) {return null;}
  const v = e.value;
  if (v.kind === 'string') {return v.value;}
  if (v.kind === 'number') {return String(v.value);}
  if (v.kind === 'boolean') {return String(v.value);}
  if (v.kind === 'null') {return 'null';}
  return null;
}

// ---------- Markdown walker -----------------------------------------------

function walkMd(
  ast: MdAst,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: (subs: readonly SlotSub[]) => void,
): void {
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  const cur = subs[i];

  // Frontmatter addressing: literal `[frontmatter]` in section slot.
  if (walked.length === 0 && cur.value === '[frontmatter]') {
    // Next sub addresses a frontmatter key.
    const next = subs[i + 1];
    if (next === undefined) {
      onMatch([{ slot: cur.slot, value: cur.value }]);
      return;
    }
    if (next.value === WILDCARD_SINGLE || next.value === WILDCARD_RECURSIVE) {
      for (const fm of ast.frontmatter) {
        onMatch([
          { slot: cur.slot, value: cur.value },
          { slot: next.slot, value: fm.key },
        ]);
      }
      return;
    }
    // Same quote-aware lookup as the JSONC walker — frontmatter
    // entry keys are unquoted in the AST, so a quoted-segment path
    // segment must be unquoted before comparing.
    const fmKey = isQuotedSeg(next.value) ? unquoteSeg(next.value) : next.value;
    const entry = ast.frontmatter.find((e) => e.key === fmKey);
    if (entry === undefined) {return;}
    onMatch([
      { slot: cur.slot, value: cur.value },
      { slot: next.slot, value: next.value },
    ]);
    return;
  }

  // Section slot first.
  if (walked.length === 0) {
    if (cur.value === WILDCARD_SINGLE || cur.value === WILDCARD_RECURSIVE) {
      for (const block of ast.blocks) {
        walkMdInsideBlock(
          block,
          ast,
          subs,
          i + 1,
          [{ slot: cur.slot, value: block.slug }],
          onMatch,
        );
        // `**` retain-i branch: in addition to descending with `**`
        // consumed (i + 1), also descend with `**` still active (i)
        // so the next sub can match deeper. Without this, md `**`
        // semantics diverged from yaml/jsonc — `oc://X.md/**/value`
        // only matched the immediate-block layer and silently missed
        // deeper hierarchies (cross-kind asymmetry — same lint rule
        // worked on yaml but produced 0 matches on md).
        if (cur.value === WILDCARD_RECURSIVE) {
          walkMdInsideBlock(
            block,
            ast,
            subs,
            i,
            [{ slot: cur.slot, value: block.slug }],
            onMatch,
          );
        }
      }
      // `**` 0-match: emit at root if any.
      if (cur.value === WILDCARD_RECURSIVE && i + 1 >= subs.length) {
        onMatch([]);
      }
      return;
    }
    const targetSlug = cur.value.toLowerCase();
    const block = ast.blocks.find((b) => b.slug === targetSlug);
    if (block === undefined) {return;}
    walkMdInsideBlock(
      block,
      ast,
      subs,
      i + 1,
      [{ slot: cur.slot, value: cur.value }],
      onMatch,
    );
  }
}

function walkMdInsideBlock(
  block: { readonly items: readonly { readonly slug: string; readonly kv?: { readonly key: string; readonly value: string } }[] },
  ast: MdAst,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: (subs: readonly SlotSub[]) => void,
): void {
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  const cur = subs[i];

  // Item slot.
  if (cur.value === WILDCARD_SINGLE || cur.value === WILDCARD_RECURSIVE) {
    // Disambiguate duplicate slugs via `#N` ordinal addressing so each
    // matched path round-trips through `resolveOcPath` to its own item.
    const slugCounts = new Map<string, number>();
    for (const item of block.items) {
      slugCounts.set(item.slug, (slugCounts.get(item.slug) ?? 0) + 1);
    }
    block.items.forEach((item, idx) => {
      const seg = (slugCounts.get(item.slug) ?? 0) > 1 ? `#${idx}` : item.slug;
      walkMdInsideItem(
        item,
        ast,
        subs,
        i + 1,
        [...walked, { slot: cur.slot, value: seg }],
        onMatch,
      );
    });
    if (cur.value === WILDCARD_RECURSIVE && i + 1 >= subs.length) {
      onMatch(walked);
    }
    return;
  }
  // Ordinal `#N` and positional `$first`/`$last`/`-N` short-circuit the
  // slug lookup — the resolver handles them, so the find walker just
  // descends into the appropriate item.
  let item: { readonly slug: string; readonly kv?: { readonly key: string; readonly value: string } } | undefined;
  if (isOrdinalSeg(cur.value)) {
    const n = parseOrdinalSeg(cur.value);
    if (n === null || n < 0 || n >= block.items.length) {return;}
    item = block.items[n];
  } else if (isPositionalSeg(cur.value)) {
    const concrete = resolvePositionalSeg(cur.value, {
      indexable: true,
      size: block.items.length,
    });
    if (concrete === null) {return;}
    item = block.items[Number(concrete)];
  } else {
    const targetItemSlug = cur.value.toLowerCase();
    item = block.items.find((it) => it.slug === targetItemSlug);
  }
  if (item === undefined) {return;}
  walkMdInsideItem(item, ast, subs, i + 1, [...walked, { slot: cur.slot, value: cur.value }], onMatch);
}

function walkMdInsideItem(
  item: { readonly kv?: { readonly key: string; readonly value: string } },
  _ast: MdAst,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: (subs: readonly SlotSub[]) => void,
): void {
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  const cur = subs[i];
  // Field slot — addresses kv.key (case-insensitive).
  if (item.kv === undefined) {return;}
  if (cur.value === WILDCARD_SINGLE || cur.value === WILDCARD_RECURSIVE) {
    onMatch([...walked, { slot: cur.slot, value: item.kv.key }]);
    return;
  }
  if (item.kv.key.toLowerCase() !== cur.value.toLowerCase()) {return;}
  onMatch([...walked, { slot: cur.slot, value: cur.value }]);
}

