/**
 * `findOcPaths` — multi-match verb. `*` matches one sub-segment;
 * `**` matches zero or more (recursive). Returns concrete OcPaths
 * preserving the input pattern's slot shape, so each result is
 * pipeable into `resolveOcPath` / `setOcPath`.
 *
 * @module @openclaw/oc-path/find
 */

import { isMap, isScalar, isSeq, type Node, type Pair } from "yaml";
import type { MdAst } from "./ast.js";
import type { JsoncValue } from "./jsonc/ast.js";
import type { JsonlAst, JsonlLine } from "./jsonl/ast.js";
import type { OcPath } from "./oc-path.js";
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
} from "./oc-path.js";
import type { PredicateSpec } from "./oc-path.js";
import type { OcAst, OcMatch } from "./universal.js";
import { resolveOcPath } from "./universal.js";

// ---------- Public types ---------------------------------------------------

/** A find result: a concrete (wildcard-free) path plus its match info. */
export interface OcPathMatch {
  readonly path: OcPath;
  readonly match: OcMatch;
}

type Slot = "section" | "item" | "field";
interface SlotSub {
  readonly slot: Slot;
  readonly value: string;
}
interface PatternSub {
  readonly slot: Slot;
  readonly value: string;
}

type OnMatch = (subs: readonly SlotSub[]) => void;

// ---------- Public verb ----------------------------------------------------

export function findOcPaths(ast: OcAst, pattern: OcPath): readonly OcPathMatch[] {
  const subs = patternSubs(pattern);
  // Fast-path: no expansion needed — pure literals just resolve.
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

  const concretePaths: OcPath[] = [];
  const onMatch: OnMatch = (slotSubs) => {
    concretePaths.push(repackSlotSubs(pattern, slotSubs));
  };
  switch (ast.kind) {
    case "jsonc":
      if (ast.root !== null) {
        walkJsonc(ast.root, subs, 0, [], onMatch);
      }
      break;
    case "jsonl":
      walkJsonl(ast, subs, 0, [], onMatch);
      break;
    case "md":
      walkMd({ kind: "root", ast }, subs, 0, [], onMatch);
      break;
    case "yaml":
      if (ast.doc.contents !== null) {
        walkYaml(ast.doc.contents, subs, 0, [], onMatch);
      }
      break;
  }

  const out: OcPathMatch[] = [];
  for (const concrete of concretePaths) {
    const m = resolveOcPath(ast, concrete);
    if (m !== null) {
      out.push({ path: concrete, match: m });
    }
  }
  return out;
}

// ---------- Pattern unpacking ---------------------------------------------

function patternSubs(pattern: OcPath): readonly PatternSub[] {
  const out: PatternSub[] = [];
  // Bracket-aware split so dots inside `[k=1.0]` or `{a.b,c}` aren't
  // treated as sub-segment delimiters.
  if (pattern.section !== undefined) {
    for (const v of splitRespectingBrackets(pattern.section, ".")) {
      out.push({ slot: "section", value: v });
    }
  }
  if (pattern.item !== undefined) {
    for (const v of splitRespectingBrackets(pattern.item, ".")) {
      out.push({ slot: "item", value: v });
    }
  }
  if (pattern.field !== undefined) {
    for (const v of splitRespectingBrackets(pattern.field, ".")) {
      out.push({ slot: "field", value: v });
    }
  }
  return out;
}

function repackSlotSubs(pattern: OcPath, slotSubs: readonly SlotSub[]): OcPath {
  const sectionSubs: string[] = [];
  const itemSubs: string[] = [];
  const fieldSubs: string[] = [];
  for (const s of slotSubs) {
    if (s.slot === "section") {
      sectionSubs.push(s.value);
    } else if (s.slot === "item") {
      itemSubs.push(s.value);
    } else {
      fieldSubs.push(s.value);
    }
  }
  return {
    file: pattern.file,
    ...(sectionSubs.length > 0 ? { section: sectionSubs.join(".") } : {}),
    ...(itemSubs.length > 0 ? { item: itemSubs.join(".") } : {}),
    ...(fieldSubs.length > 0 ? { field: fieldSubs.join(".") } : {}),
    ...(pattern.session !== undefined ? { session: pattern.session } : {}),
  };
}

// ---------- Shared dispatch ----------------------------------------------

// Per-kind ops the dispatcher uses to drive recursion. Each kind's
// walker fills these in; the dispatcher handles every segment shape.
interface WalkOps<T> {
  enumerate(node: T): Iterable<{ keySub: string; child: T }>;
  lookup(node: T, key: string): { keySub: string; child: T } | null;
  positional(node: T, seg: string): { keySub: string; child: T } | null;
  predicate(node: T, pred: PredicateSpec): Iterable<{ keySub: string; child: T }>;
  walk(
    node: T,
    subs: readonly PatternSub[],
    i: number,
    walked: readonly SlotSub[],
    onMatch: OnMatch,
  ): void;
}

function checkDepth(walked: readonly SlotSub[]): void {
  if (walked.length > MAX_TRAVERSAL_DEPTH) {
    throw new OcPathError(
      `findOcPaths exceeded MAX_TRAVERSAL_DEPTH (${MAX_TRAVERSAL_DEPTH}) — likely a pathological pattern`,
      "",
      "OC_PATH_DEPTH_EXCEEDED",
    );
  }
}

function dispatchSeg<T>(
  node: T,
  ops: WalkOps<T>,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  const cur = subs[i];

  if (isUnionSeg(cur.value)) {
    const alts = parseUnionSeg(cur.value);
    if (alts === null) {
      return;
    }
    for (const alt of alts) {
      const altSubs = subs.slice();
      altSubs[i] = { slot: cur.slot, value: alt };
      ops.walk(node, altSubs, i, walked, onMatch);
    }
    return;
  }

  if (isPredicateSeg(cur.value)) {
    const pred = parsePredicateSeg(cur.value);
    if (pred === null) {
      return;
    }
    for (const m of ops.predicate(node, pred)) {
      ops.walk(m.child, subs, i + 1, [...walked, { slot: cur.slot, value: m.keySub }], onMatch);
    }
    return;
  }

  if (cur.value === WILDCARD_RECURSIVE) {
    // `**` — descend with `**` consumed (i+1) AND retained (i) so
    // deeper structures still match. Emit if no subs remain.
    if (i + 1 >= subs.length) {
      onMatch(walked);
    }
    for (const m of ops.enumerate(node)) {
      const nextWalked: readonly SlotSub[] = [...walked, { slot: cur.slot, value: m.keySub }];
      ops.walk(m.child, subs, i + 1, nextWalked, onMatch);
      ops.walk(m.child, subs, i, nextWalked, onMatch);
    }
    return;
  }

  if (cur.value === WILDCARD_SINGLE) {
    for (const m of ops.enumerate(node)) {
      ops.walk(m.child, subs, i + 1, [...walked, { slot: cur.slot, value: m.keySub }], onMatch);
    }
    return;
  }

  if (isPositionalSeg(cur.value)) {
    const m = ops.positional(node, cur.value);
    if (m === null) {
      return;
    }
    ops.walk(m.child, subs, i + 1, [...walked, { slot: cur.slot, value: m.keySub }], onMatch);
    return;
  }

  const m = ops.lookup(node, cur.value);
  if (m === null) {
    return;
  }
  ops.walk(m.child, subs, i + 1, [...walked, { slot: cur.slot, value: m.keySub }], onMatch);
}

// ---------- JSONC walker ---------------------------------------------------

function walkJsonc(
  node: JsoncValue,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  checkDepth(walked);
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  dispatchSeg(node, jsoncOps, subs, i, walked, onMatch);
}

const jsoncOps: WalkOps<JsoncValue> = {
  *enumerate(node) {
    if (node.kind === "object") {
      for (const e of node.entries) {
        yield { keySub: quoteSeg(e.key), child: e.value };
      }
    } else if (node.kind === "array") {
      for (let idx = 0; idx < node.items.length; idx++) {
        yield { keySub: String(idx), child: node.items[idx] };
      }
    }
  },
  lookup(node, key) {
    if (node.kind === "object") {
      // Entry keys are unquoted in the AST; strip quotes from a quoted
      // path key so the walker matches the resolver's behavior.
      const lookupKey = isQuotedSeg(key) ? unquoteSeg(key) : key;
      const e = node.entries.find((entry) => entry.key === lookupKey);
      return e === undefined ? null : { keySub: key, child: e.value };
    }
    if (node.kind === "array") {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) {
        return null;
      }
      return { keySub: key, child: node.items[idx] };
    }
    return null;
  },
  positional(node, seg) {
    const concrete = positionalForJsoncNode(node, seg);
    if (concrete === null) {
      return null;
    }
    return jsoncOps.lookup(node, concrete);
  },
  *predicate(node, pred) {
    if (node.kind === "object") {
      for (const e of node.entries) {
        if (jsoncChildMatchesPredicate(e.value, pred)) {
          yield { keySub: quoteSeg(e.key), child: e.value };
        }
      }
    } else if (node.kind === "array") {
      for (let idx = 0; idx < node.items.length; idx++) {
        if (jsoncChildMatchesPredicate(node.items[idx], pred)) {
          yield { keySub: String(idx), child: node.items[idx] };
        }
      }
    }
  },
  walk: walkJsonc,
};

function positionalForJsoncNode(node: JsoncValue, seg: string): string | null {
  if (node.kind === "object") {
    const keys = node.entries.map((e) => e.key);
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (node.kind === "array") {
    return resolvePositionalSeg(seg, { indexable: true, size: node.items.length });
  }
  return null;
}

// ---------- JSONL walker ---------------------------------------------------

// First slot is a line address; subsequent slots descend into the
// line's jsonc value via jsonlOps.walk's holder unwrap.
function walkJsonl(
  ast: JsonlAst,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  checkDepth(walked);
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  if (walked.length === 0) {
    dispatchSeg(ast, jsonlOps, subs, i, walked, onMatch);
  }
}

const jsonlOps: WalkOps<JsonlAst> = {
  *enumerate(ast) {
    for (const l of ast.lines) {
      if (l.kind === "value") {
        yield { keySub: `L${l.line}`, child: lineHolder(ast, l) };
      }
    }
  },
  lookup(ast, key) {
    const line = pickLine(ast, key);
    if (line === null) {
      return null;
    }
    const concreteAddr = line.kind === "value" ? `L${line.line}` : key;
    return { keySub: concreteAddr, child: lineHolder(ast, line) };
  },
  positional(ast, seg) {
    return jsonlOps.lookup(ast, seg);
  },
  *predicate(ast, pred) {
    for (const l of ast.lines) {
      if (l.kind !== "value") {
        continue;
      }
      const actual = topLevelLeafText(l.value, pred.key);
      if (evaluatePredicate(actual, pred)) {
        yield { keySub: `L${l.line}`, child: lineHolder(ast, l) };
      }
    }
  },
  // After the line slot is consumed, descend into the line's jsonc
  // value via the holder's WeakMap-tagged line. Otherwise this is a
  // top-level walkJsonl entry — go through line-slot dispatch.
  walk(child, subs, i, walked, onMatch) {
    const line = unwrapHolder(child);
    if (line === null) {
      walkJsonl(child, subs, i, walked, onMatch);
      return;
    }
    if (i >= subs.length) {
      onMatch(walked);
      return;
    }
    if (line.kind !== "value") {
      return;
    }
    walkJsonc(line.value, subs, i, walked, onMatch);
  },
};

// JsonlAst-typed wrapper around a single line so jsonlOps.walk can
// distinguish "top-level ast (descend the line slot)" from "we
// already picked a line, walk inside it." A WeakMap keeps the wrapping
// structural (no JsonlAst surface change).
const lineByHolder = new WeakMap<object, JsonlLine>();
function lineHolder(ast: JsonlAst, line: JsonlLine): JsonlAst {
  // Synthesize a tagged JsonlAst that carries the chosen line. The
  // outer structure is preserved (kind, raw, lines) so type checks
  // remain happy; the WeakMap holds the per-line tag.
  const holder: JsonlAst = { kind: "jsonl", raw: ast.raw, lines: ast.lines };
  lineByHolder.set(holder, line);
  return holder;
}
function unwrapHolder(holder: JsonlAst): JsonlLine | null {
  return lineByHolder.get(holder) ?? null;
}

function topLevelLeafText(value: JsoncValue, key: string): string | null {
  if (value.kind !== "object") {
    return null;
  }
  const entry = value.entries.find((e) => e.key === key);
  if (entry === undefined) {
    return null;
  }
  const v = entry.value;
  if (v.kind === "string") {
    return v.value;
  }
  if (v.kind === "number" || v.kind === "boolean") {
    return String(v.value);
  }
  return null;
}

function pickLine(ast: JsonlAst, addr: string): JsonlLine | null {
  if (addr === "$first") {
    for (const l of ast.lines) {
      if (l.kind === "value") {
        return l;
      }
    }
    return null;
  }
  if (addr === "$last") {
    for (let i = ast.lines.length - 1; i >= 0; i--) {
      const l = ast.lines[i];
      if (l !== undefined && l.kind === "value") {
        return l;
      }
    }
    return null;
  }
  const m = /^L(\d+)$/.exec(addr);
  if (m === null || m[1] === undefined) {
    return null;
  }
  const target = Number(m[1]);
  for (const l of ast.lines) {
    if (l.line === target) {
      return l;
    }
  }
  return null;
}

// ---------- YAML walker ----------------------------------------------------

function walkYaml(
  node: Node,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  checkDepth(walked);
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  dispatchSeg(node, yamlOps, subs, i, walked, onMatch);
}

const yamlOps: WalkOps<Node> = {
  *enumerate(node) {
    if (isMap(node)) {
      for (const p of (node as { items: readonly Pair[] }).items) {
        const k = isScalar(p.key) ? p.key.value : p.key;
        if (p.value !== null) {
          yield { keySub: quoteSeg(String(k)), child: p.value as Node };
        }
      }
    } else if (isSeq(node)) {
      for (let idx = 0; idx < node.items.length; idx++) {
        const child = node.items[idx];
        if (child !== null) {
          yield { keySub: String(idx), child: child as Node };
        }
      }
    }
  },
  lookup(node, key) {
    if (isMap(node)) {
      const lookupKey = isQuotedSeg(key) ? unquoteSeg(key) : key;
      const pair = (node as { items: readonly Pair[] }).items.find((p) => {
        const k = isScalar(p.key) ? p.key.value : p.key;
        return String(k) === lookupKey;
      });
      return pair?.value === undefined || pair.value === null
        ? null
        : { keySub: key, child: pair.value as Node };
    }
    if (isSeq(node)) {
      const idx = Number(key);
      const child = node.items[idx];
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length || child === null) {
        return null;
      }
      return { keySub: key, child: child as Node };
    }
    return null;
  },
  positional(node, seg) {
    const concrete = positionalForYamlNode(node, seg);
    return concrete === null ? null : yamlOps.lookup(node, concrete);
  },
  *predicate(node, pred) {
    if (isMap(node)) {
      for (const p of (node as { items: readonly Pair[] }).items) {
        const k = isScalar(p.key) ? p.key.value : p.key;
        if (p.value !== null && yamlChildMatchesPredicate(p.value as Node, pred)) {
          yield { keySub: quoteSeg(String(k)), child: p.value as Node };
        }
      }
    } else if (isSeq(node)) {
      for (let idx = 0; idx < node.items.length; idx++) {
        const child = node.items[idx];
        if (child !== null && yamlChildMatchesPredicate(child as Node, pred)) {
          yield { keySub: String(idx), child: child as Node };
        }
      }
    }
  },
  walk: walkYaml,
};

function positionalForYamlNode(node: Node, seg: string): string | null {
  if (isMap(node)) {
    const keys = (node as { items: readonly Pair[] }).items.map((p) =>
      String(isScalar(p.key) ? p.key.value : p.key),
    );
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (isSeq(node)) {
    return resolvePositionalSeg(seg, { indexable: true, size: node.items.length });
  }
  return null;
}

function yamlChildMatchesPredicate(node: Node, pred: PredicateSpec): boolean {
  return evaluatePredicate(yamlChildFieldText(node, pred.key), pred);
}

function yamlChildFieldText(node: Node, key: string): string | null {
  if (!isMap(node)) {
    return null;
  }
  const pair = (node as { items: readonly Pair[] }).items.find((p) => {
    const k = isScalar(p.key) ? p.key.value : p.key;
    return String(k) === key;
  });
  if (pair === undefined || pair.value === null) {
    return null;
  }
  return yamlScalarToText(pair.value);
}

function yamlScalarToText(value: unknown): string | null {
  if (!isScalar(value)) {
    return null;
  }
  const scalar = value.value;
  if (typeof scalar === "string") {
    return scalar;
  }
  if (typeof scalar === "number" || typeof scalar === "boolean") {
    return String(scalar);
  }
  if (scalar === null) {
    return "null";
  }
  if (typeof scalar === "bigint" || typeof scalar === "symbol") {
    return scalar.toString();
  }
  if (scalar instanceof Date) {
    return scalar.toISOString();
  }
  return JSON.stringify(scalar) ?? null;
}

// ---------- Markdown walker -----------------------------------------------

type MdItem = MdAst["blocks"][number]["items"][number];
type MdBlock = MdAst["blocks"][number];

type MdLevel =
  | { readonly kind: "root"; readonly ast: MdAst }
  | { readonly kind: "block"; readonly block: MdBlock; readonly ast: MdAst }
  | { readonly kind: "item"; readonly item: MdItem; readonly ast: MdAst };

function walkMd(
  level: MdLevel,
  subs: readonly PatternSub[],
  i: number,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  if (i >= subs.length) {
    onMatch(walked);
    return;
  }
  const cur = subs[i];

  // Frontmatter sentinel short-circuits regular dispatch.
  if (level.kind === "root" && walked.length === 0 && cur.value === "[frontmatter]") {
    const next = subs[i + 1];
    if (next === undefined) {
      onMatch([{ slot: cur.slot, value: cur.value }]);
      return;
    }
    if (next.value === WILDCARD_SINGLE || next.value === WILDCARD_RECURSIVE) {
      for (const fm of level.ast.frontmatter) {
        onMatch([
          { slot: cur.slot, value: cur.value },
          { slot: next.slot, value: fm.key },
        ]);
      }
      return;
    }
    const fmKey = isQuotedSeg(next.value) ? unquoteSeg(next.value) : next.value;
    const entry = level.ast.frontmatter.find((e) => e.key === fmKey);
    if (entry === undefined) {
      return;
    }
    onMatch([
      { slot: cur.slot, value: cur.value },
      { slot: next.slot, value: next.value },
    ]);
    return;
  }

  // Item-level field slot is terminal — descending would loop.
  if (level.kind === "item") {
    walkMdItemField(level.item, cur, walked, onMatch);
    return;
  }

  dispatchSeg(level, mdOps, subs, i, walked, onMatch);
}

function walkMdItemField(
  item: MdItem,
  cur: PatternSub,
  walked: readonly SlotSub[],
  onMatch: OnMatch,
): void {
  if (item.kv === undefined) {
    return;
  }
  const key = item.kv.key;
  const emit = (value: string): void => {
    onMatch([...walked, { slot: cur.slot, value }]);
  };
  if (isUnionSeg(cur.value)) {
    const alts = parseUnionSeg(cur.value);
    if (alts === null) {
      return;
    }
    for (const alt of alts) {
      if (alt.toLowerCase() === key.toLowerCase()) {
        emit(key);
      }
    }
    return;
  }
  if (isPredicateSeg(cur.value)) {
    const pred = parsePredicateSeg(cur.value);
    if (pred !== null && mdItemMatchesPredicate(item, pred)) {
      emit(key);
    }
    return;
  }
  if (cur.value === WILDCARD_SINGLE || cur.value === WILDCARD_RECURSIVE) {
    emit(key);
    return;
  }
  if (key.toLowerCase() === cur.value.toLowerCase()) {
    emit(cur.value);
  }
}

function blockSlugCounts(items: readonly MdItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.slug, (counts.get(item.slug) ?? 0) + 1);
  }
  return counts;
}

// `mdOps` only handles root / block levels. Item-level dispatch is
// terminal and runs inline in `walkMd` (see `walkMdItemField`).
const mdOps: WalkOps<MdLevel> = {
  *enumerate(level) {
    if (level.kind === "root") {
      for (const block of level.ast.blocks) {
        yield { keySub: block.slug, child: { kind: "block", block, ast: level.ast } };
      }
      return;
    }
    if (level.kind === "block") {
      // Disambiguate duplicate slugs via `#N` ordinal so each emitted
      // path round-trips through resolveOcPath to its own item.
      const counts = blockSlugCounts(level.block.items);
      for (let idx = 0; idx < level.block.items.length; idx++) {
        const item = level.block.items[idx];
        const seg = (counts.get(item.slug) ?? 0) > 1 ? `#${idx}` : item.slug;
        yield { keySub: seg, child: { kind: "item", item, ast: level.ast } };
      }
    }
  },
  lookup(level, key) {
    if (level.kind === "root") {
      const target = key.toLowerCase();
      const block = level.ast.blocks.find((b) => b.slug === target);
      return block === undefined
        ? null
        : { keySub: key, child: { kind: "block", block, ast: level.ast } };
    }
    if (level.kind === "block") {
      // Ordinal `#N` short-circuits slug lookup.
      if (isOrdinalSeg(key)) {
        const n = parseOrdinalSeg(key);
        if (n === null || n < 0 || n >= level.block.items.length) {
          return null;
        }
        return { keySub: key, child: { kind: "item", item: level.block.items[n], ast: level.ast } };
      }
      const target = key.toLowerCase();
      const item = level.block.items.find((it) => it.slug === target);
      return item === undefined
        ? null
        : { keySub: key, child: { kind: "item", item, ast: level.ast } };
    }
    return null;
  },
  positional(level, seg) {
    if (level.kind !== "block") {
      return null;
    }
    const concrete = resolvePositionalSeg(seg, {
      indexable: true,
      size: level.block.items.length,
    });
    if (concrete === null) {
      return null;
    }
    // Preserve the positional token in keySub so the resolver
    // re-evaluates positionally on round-trip.
    const item = level.block.items[Number(concrete)];
    return { keySub: seg, child: { kind: "item", item, ast: level.ast } };
  },
  *predicate(level, pred) {
    if (level.kind === "root") {
      for (const block of level.ast.blocks) {
        if (mdBlockHasMatchingItem(block, pred)) {
          yield { keySub: block.slug, child: { kind: "block", block, ast: level.ast } };
        }
      }
      return;
    }
    if (level.kind === "block") {
      const counts = blockSlugCounts(level.block.items);
      for (let idx = 0; idx < level.block.items.length; idx++) {
        const item = level.block.items[idx];
        if (mdItemMatchesPredicate(item, pred)) {
          const seg = (counts.get(item.slug) ?? 0) > 1 ? `#${idx}` : item.slug;
          yield { keySub: seg, child: { kind: "item", item, ast: level.ast } };
        }
      }
    }
  },
  walk: walkMd,
};

function mdItemMatchesPredicate(item: MdItem, pred: PredicateSpec): boolean {
  if (item.kv === undefined) {
    return false;
  }
  if (item.kv.key.toLowerCase() !== pred.key.toLowerCase()) {
    return false;
  }
  return evaluatePredicate(item.kv.value, pred);
}

function mdBlockHasMatchingItem(block: MdBlock, pred: PredicateSpec): boolean {
  for (const item of block.items) {
    if (mdItemMatchesPredicate(item, pred)) {
      return true;
    }
  }
  return false;
}

function jsoncChildMatchesPredicate(node: JsoncValue, pred: PredicateSpec): boolean {
  return evaluatePredicate(jsoncChildFieldText(node, pred.key), pred);
}

function jsoncChildFieldText(node: JsoncValue, key: string): string | null {
  if (node.kind !== "object") {
    return null;
  }
  const e = node.entries.find((entry) => entry.key === key);
  if (e === undefined) {
    return null;
  }
  const v = e.value;
  if (v.kind === "string") {
    return v.value;
  }
  if (v.kind === "number" || v.kind === "boolean") {
    return String(v.value);
  }
  if (v.kind === "null") {
    return "null";
  }
  return null;
}
