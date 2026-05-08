/**
 * Universal `setOcPath` and `resolveOcPath` — the public verbs.
 *
 * **Strategic frame**: addressing is universal. Encoding is per-kind.
 * The OcPath syntax encodes WHAT to do (set leaf vs. insert vs. address
 * a structural node); the AST kind encodes HOW the substrate carries it
 * out. Callers pass any AST + a path + a string value; the substrate
 * dispatches via `ast.kind` and coerces the value based on the path's
 * syntax and the AST shape at the resolution point.
 *
 * **Path syntax vocabulary** (v0):
 *
 *   oc://FILE/section/item/field          → leaf address (set/replace value)
 *   oc://FILE/section/+                   → end-insertion at section
 *   oc://FILE/section/+key                → keyed insertion (object key add)
 *   oc://FILE/section/+0                  → indexed insertion (array splice)
 *   oc://FILE/+                           → file-root insertion (jsonl line append, md new section)
 *
 * **Coercion at leaves** is driven by the AST type at the resolution point:
 *   - md leaf  → value used verbatim (md is text-native)
 *   - jsonc/jsonl leaf, existing string → value verbatim
 *   - jsonc/jsonl leaf, existing number → parseFloat (parse-error if NaN)
 *   - jsonc/jsonl leaf, existing boolean → 'true'/'false' literal
 *   - jsonc/jsonl leaf, existing null → only `value === 'null'`
 *   - insertion → `JSON.parse(value)` for jsonc/jsonl; raw text for md
 *
 * @module @openclaw/oc-path/universal
 */

import type { MdAst } from './ast.js';
import type { JsoncAst, JsoncEntry, JsoncValue } from './jsonc/ast.js';
import { setJsoncOcPath } from './jsonc/edit.js';
import { resolveJsoncOcPath } from './jsonc/resolve.js';
import type { JsonlAst } from './jsonl/ast.js';
import { appendJsonlOcPath as appendJsonlLine, setJsonlOcPath } from './jsonl/edit.js';
import { resolveJsonlOcPath } from './jsonl/resolve.js';
import { setMdOcPath } from './edit.js';
import type { OcPath } from './oc-path.js';
import {
  formatOcPath,
  hasWildcard,
  isQuotedSeg,
  OcPathError,
  splitRespectingBrackets,
  unquoteSeg,
} from './oc-path.js';
import { resolveMdOcPath } from './resolve.js';
import { emitJsonc } from './jsonc/emit.js';
import { emitJsonl } from './jsonl/emit.js';
import type { YamlAst } from './yaml/ast.js';
import { insertYamlOcPath, setYamlOcPath } from './yaml/edit.js';
import { resolveYamlOcPath } from './yaml/resolve.js';

// ---------- Public types ---------------------------------------------------

/** Tagged-union of every AST kind the substrate supports. */
export type OcAst = MdAst | JsoncAst | JsonlAst | YamlAst;

/**
 * Universal resolve result. Same shape regardless of AST kind so
 * consumers branch only on `match.kind`.
 *
 * `leaf` carries the value as a string — the canonical leaf form on
 * the wire, suitable for direct comparison or display. Numeric/bool
 * leaves are stringified deterministically (`String(42)` → `'42'`,
 * `String(true)` → `'true'`).
 *
 * `node` describes which kind of structural node the path resolved to
 * (md-block, jsonc-object, jsonl-line, etc.) — the descriptor lets
 * tooling format / drill in without re-parsing the kind tag.
 *
 * `insertion-point` is returned when the path's terminal segment is
 * an insertion marker (`+`, `+key`, `+nnn`) and the parent is a valid
 * container.
 *
 * **`line`** is the 1-based source line of the matched node, or `1`
 * for the root / synthetic constructions where no source line exists.
 * Lint rules use it directly for diagnostic positioning instead of
 * walking the kind-specific AST a second time.
 */
export type OcMatch =
  | { readonly kind: 'root'; readonly ast: OcAst; readonly line: number }
  | { readonly kind: 'leaf'; readonly valueText: string; readonly leafType: LeafType; readonly line: number }
  | { readonly kind: 'node'; readonly descriptor: NodeDescriptor; readonly line: number }
  | { readonly kind: 'insertion-point'; readonly container: ContainerKind; readonly line: number };

export type LeafType = 'string' | 'number' | 'boolean' | 'null';

export type NodeDescriptor =
  | 'md-block'
  | 'md-item'
  | 'jsonc-object'
  | 'jsonc-array'
  | 'jsonl-line'
  | 'yaml-map'
  | 'yaml-seq';

export type ContainerKind =
  | 'md-section'      // append item to a section
  | 'md-file'         // append a section to the file
  | 'md-frontmatter'  // add a frontmatter key
  | 'jsonc-object'
  | 'jsonc-array'
  | 'jsonl-file'      // append a line
  | 'yaml-map'        // add key to YAML map
  | 'yaml-seq';       // append item to YAML seq

export type SetResult =
  | { readonly ok: true; readonly ast: OcAst }
  | {
      readonly ok: false;
      readonly reason:
        | 'unresolved'
        | 'no-root'
        | 'not-writable'
        | 'no-item-kv'
        | 'not-a-value-line'
        | 'parse-error'
        | 'type-mismatch'
        | 'wildcard-not-allowed';
      readonly detail?: string;
    };

// ---------- Insertion-syntax detection -------------------------------------

/**
 * Inspect the path for an insertion marker on the deepest segment.
 * A segment of `+`, `+<key>`, or `+<index>` indicates insertion at the
 * parent. Returns the parent path (with insertion segment stripped) +
 * the marker; or `null` for a plain (non-insertion) path.
 */
export interface InsertionInfo {
  readonly parentPath: OcPath;
  readonly marker: '+' | { kind: 'keyed'; key: string } | { kind: 'indexed'; index: number };
}

export function detectInsertion(path: OcPath): InsertionInfo | null {
  // Find the deepest defined segment.
  const segments: Array<{ slot: 'section' | 'item' | 'field'; value: string }> = [];
  if (path.section !== undefined) {segments.push({ slot: 'section', value: path.section });}
  if (path.item !== undefined) {segments.push({ slot: 'item', value: path.item });}
  if (path.field !== undefined) {segments.push({ slot: 'field', value: path.field });}
  if (segments.length === 0) {return null;}

  const last = segments[segments.length - 1];
  if (!last.value.startsWith('+')) {return null;}

  const rest = last.value.slice(1);
  let marker: InsertionInfo['marker'];
  if (rest.length === 0) {marker = '+';}
  else if (/^\d+$/.test(rest)) {marker = { kind: 'indexed', index: Number(rest) };}
  else {marker = { kind: 'keyed', key: rest };}

  // Strip the deepest segment from the path.
  const parentPath: OcPath = {
    file: path.file,
    ...(last.slot !== 'section' && path.section !== undefined ? { section: path.section } : {}),
    ...(last.slot !== 'item' && path.item !== undefined ? { item: path.item } : {}),
    ...(last.slot !== 'field' && path.field !== undefined ? { field: path.field } : {}),
    ...(path.session !== undefined ? { session: path.session } : {}),
  };
  return { parentPath, marker };
}

// ---------- Universal resolve ----------------------------------------------

/**
 * Resolve an `OcPath` against any AST. Returns a kind-agnostic match
 * shape or `null` when the path doesn't resolve.
 *
 * Insertion-marker paths return `{kind: 'insertion-point', container}`
 * if the parent is a valid container; otherwise `null`.
 */
export function resolveOcPath(ast: OcAst, path: OcPath): OcMatch | null {
  // Wildcard guard: `resolveOcPath` is the single-match verb. Wildcards
  // belong to `findOcPaths` (multi-match). Throw with a structured code
  // (consistent with `setOcPath`'s `wildcard-not-allowed` discriminator)
  // — silent `null` here is indistinguishable from "path doesn't
  // resolve", so consumers couldn't tell whether they should switch to
  // findOcPaths or accept the address as missing.
  if (hasWildcard(path)) {
    throw new OcPathError(
      `resolveOcPath received a wildcard pattern; use findOcPaths instead: ${formatOcPath(path)}`,
      formatOcPath(path),
      'OC_PATH_WILDCARD_IN_RESOLVE',
    );
  }
  const insertion = detectInsertion(path);
  if (insertion !== null) {
    return resolveInsertion(ast, insertion);
  }

  switch (ast.kind) {
    case 'md':
      return resolveMdToUniversal(ast, path);
    case 'jsonc':
      return resolveJsoncToUniversal(ast, path);
    case 'jsonl':
      return resolveJsonlToUniversal(ast, path);
    case 'yaml':
      return resolveYamlToUniversal(ast, path);
  }
  return null;
}

function resolveYamlToUniversal(ast: YamlAst, path: OcPath): OcMatch | null {
  const m = resolveYamlOcPath(ast, path);
  if (m === null) {return null;}
  if (m.kind === 'root') {return { kind: 'root', ast, line: 1 };}
  // Walk the AST one more time to extract the matched node's range
  // — the per-kind YamlOcPathMatch shape doesn't surface it directly.
  // Cheap relative to the resolve cost; trades CPU for type cleanliness.
  const line = locateYamlLine(ast, path);
  if (m.kind === 'map') {return { kind: 'node', descriptor: 'yaml-map', line };}
  if (m.kind === 'seq') {return { kind: 'node', descriptor: 'yaml-seq', line };}
  if (m.kind === 'scalar' || m.kind === 'pair') {
    const v = m.value;
    if (v === null) {return { kind: 'leaf', valueText: 'null', leafType: 'null', line };}
    if (typeof v === 'string') {return { kind: 'leaf', valueText: v, leafType: 'string', line };}
    if (typeof v === 'number') {return { kind: 'leaf', valueText: String(v), leafType: 'number', line };}
    if (typeof v === 'boolean') {return { kind: 'leaf', valueText: String(v), leafType: 'boolean', line };}
    // Anything else (Date / BigInt / collection) — JSON-stringify so we
    // don't end up with `[object Object]` in the leaf text. Falls back
    // to literal "null" if JSON.stringify yields undefined.
    const valueText = JSON.stringify(v) ?? 'null';
    return { kind: 'leaf', valueText, leafType: 'string', line };
  }
  return null;
}

function locateYamlLine(ast: YamlAst, path: OcPath): number {
  // Re-walk the yaml CST to find the matched node's byte range, then
  // convert via the AST's `lineCounter`. Quote-aware split + unquote so
  // a quoted segment containing `.` survives as a single key (matches
  // `resolveYamlOcPath`'s lookup behavior; without this a key like
  // `"github.com/foo"` would shred and the line locator would fall back
  // to line 1 silently).
  const segments: string[] = [];
  const collect = (slot: string | undefined) => {
    if (slot === undefined) {return;}
    for (const sub of splitRespectingBrackets(slot, '.')) {
      segments.push(isQuotedSeg(sub) ? unquoteSeg(sub) : sub);
    }
  };
  collect(path.section);
  collect(path.item);
  collect(path.field);
  if (segments.length === 0) {return 1;}
  let node: unknown = ast.doc.contents;
  for (const seg of segments) {
    if (node === null || node === undefined) {return 1;}
    const n = node as { items?: unknown[] };
    if (Array.isArray(n.items)) {
      // Map or seq.
      const items = n.items;
      const isMap = items.length > 0 && typeof items[0] === 'object' && items[0] !== null && 'key' in (items[0]);
      if (isMap) {
        const pair = (items as { key: { value?: unknown }; value: unknown }[]).find((p) => {
          const k = p.key !== null && typeof p.key === 'object' && 'value' in p.key ? p.key.value : p.key;
          return String(k) === seg;
        });
        if (pair === undefined) {return 1;}
        node = pair.value;
      } else {
        const idx = Number(seg);
        if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {return 1;}
        node = items[idx];
      }
    } else {
      return 1;
    }
  }
  if (node === null || typeof node !== 'object') {return 1;}
  const range = (node as { range?: readonly [number, number, number] }).range;
  if (range === undefined) {return 1;}
  return ast.lineCounter.linePos(range[0]).line;
}

function resolveMdToUniversal(ast: MdAst, path: OcPath): OcMatch | null {
  const m = resolveMdOcPath(ast, path);
  if (m === null) {return null;}
  switch (m.kind) {
    case 'root':
      return { kind: 'root', ast, line: 1 };
    case 'frontmatter':
      return { kind: 'leaf', valueText: m.node.value, leafType: 'string', line: m.node.line };
    case 'block':
      return { kind: 'node', descriptor: 'md-block', line: m.node.line };
    case 'item':
      return { kind: 'node', descriptor: 'md-item', line: m.node.line };
    case 'item-field':
      return { kind: 'leaf', valueText: m.value, leafType: 'string', line: m.node.line };
  }
  return null;
}

function resolveJsoncToUniversal(ast: JsoncAst, path: OcPath): OcMatch | null {
  const m = resolveJsoncOcPath(ast, path);
  if (m === null) {return null;}
  if (m.kind === 'root') {return { kind: 'root', ast, line: 1 };}
  if (m.kind === 'object-entry') {
    return jsoncValueToMatch(m.node.value, m.node.line);
  }
  // m.kind === 'value' — array element or root: line lives on the value itself.
  return jsoncValueToMatch(m.node, m.node.line ?? 1);
}

function jsoncValueToMatch(value: JsoncValue, line: number): OcMatch {
  switch (value.kind) {
    case 'object':
      return { kind: 'node', descriptor: 'jsonc-object', line };
    case 'array':
      return { kind: 'node', descriptor: 'jsonc-array', line };
    case 'string':
      return { kind: 'leaf', valueText: value.value, leafType: 'string', line };
    case 'number':
      return { kind: 'leaf', valueText: String(value.value), leafType: 'number', line };
    case 'boolean':
      return { kind: 'leaf', valueText: String(value.value), leafType: 'boolean', line };
    case 'null':
      return { kind: 'leaf', valueText: 'null', leafType: 'null', line };
  }
  throw new Error(`unreachable: jsoncValueToMatch kind`);
}

function resolveJsonlToUniversal(ast: JsonlAst, path: OcPath): OcMatch | null {
  const m = resolveJsonlOcPath(ast, path);
  if (m === null) {return null;}
  if (m.kind === 'root') {return { kind: 'root', ast, line: 1 };}
  if (m.kind === 'line') {return { kind: 'node', descriptor: 'jsonl-line', line: m.node.line };}
  // Inside-line jsonc parser starts numbering at 1 for each jsonl
  // line, so `m.node.line` would always be 1 for any jsonl-resolved
  // match. Use `m.line` (the JsonlLine's file-level line) — by
  // construction every inside-line node sits on the same file line.
  if (m.kind === 'object-entry') {return jsoncValueToMatch(m.node.value, m.line);}
  return jsoncValueToMatch(m.node, m.line);
}

function resolveInsertion(ast: OcAst, info: InsertionInfo): OcMatch | null {
  // For an insertion to be valid the parent must resolve to a container
  // we know how to extend. Inspect the parent.
  switch (ast.kind) {
    case 'md':
      return resolveMdInsertion(ast, info);
    case 'jsonc':
      return resolveJsoncInsertion(ast, info);
    case 'jsonl':
      return resolveJsonlInsertion(ast, info);
    case 'yaml':
      return resolveYamlInsertion(ast, info);
  }
  return null;
}

function resolveYamlInsertion(ast: YamlAst, info: InsertionInfo): OcMatch | null {
  const m = resolveYamlOcPath(ast, info.parentPath);
  if (m === null) {return null;}
  const line = locateYamlLine(ast, info.parentPath);
  if (m.kind === 'map') {return { kind: 'insertion-point', container: 'yaml-map', line };}
  if (m.kind === 'seq') {return { kind: 'insertion-point', container: 'yaml-seq', line };}
  if (m.kind === 'root') {
    // Top-level: inspect the document root.
    const root = ast.doc.contents;
    if (root === null) {return null;}
    if ('items' in (root as object)) {
      const isMapLike = (root as { items: { key?: unknown }[] }).items.every((p) => 'key' in p);
      return { kind: 'insertion-point', container: isMapLike ? 'yaml-map' : 'yaml-seq', line: 1 };
    }
    return null;
  }
  return null;
}

function resolveMdInsertion(ast: MdAst, info: InsertionInfo): OcMatch | null {
  const p = info.parentPath;
  // oc://FILE/+ → file-root insertion (new section)
  if (p.section === undefined) {
    return { kind: 'insertion-point', container: 'md-file', line: 1 };
  }
  // oc://FILE/[frontmatter]/+key → frontmatter add
  if (p.section === '[frontmatter]') {
    return { kind: 'insertion-point', container: 'md-frontmatter', line: 1 };
  }
  // oc://FILE/section/+ → append item to section
  if (p.item === undefined && p.field === undefined) {
    const m = resolveMdOcPath(ast, p);
    if (m === null || m.kind !== 'block') {return null;}
    return { kind: 'insertion-point', container: 'md-section', line: m.node.line };
  }
  return null;
}

function resolveJsoncInsertion(ast: JsoncAst, info: InsertionInfo): OcMatch | null {
  const m = resolveJsoncOcPath(ast, info.parentPath);
  if (m === null) {return null;}
  let containerNode: JsoncValue;
  if (m.kind === 'root') {
    if (ast.root === null) {return null;}
    containerNode = ast.root;
  } else if (m.kind === 'object-entry') {
    containerNode = m.node.value;
  } else {
    containerNode = m.node;
  }
  const line = containerNode.line ?? 1;
  if (containerNode.kind === 'object') {
    return { kind: 'insertion-point', container: 'jsonc-object', line };
  }
  if (containerNode.kind === 'array') {
    return { kind: 'insertion-point', container: 'jsonc-array', line };
  }
  return null;
}

function resolveJsonlInsertion(ast: JsonlAst, info: InsertionInfo): OcMatch | null {
  // jsonl insertion only makes sense at the file level: `oc://FILE/+`.
  if (info.parentPath.section !== undefined) {return null;}
  // The only insertion point for jsonl is "after the last line" — the
  // line surfaced is `lastLine + 1` so consumers can render correctly.
  const lastLine = ast.lines.length > 0 ? ast.lines[ast.lines.length - 1].line : 0;
  return { kind: 'insertion-point', container: 'jsonl-file', line: lastLine + 1 };
}

// ---------- Universal set --------------------------------------------------

/**
 * Replace or insert at `path` with `value` (always a string).
 * Substrate dispatches via `ast.kind` and coerces value at leaves
 * based on the existing AST shape at the path location.
 *
 * For insertion-marker paths (`+`, `+key`, `+nnn`) the value is parsed
 * as kind-appropriate content (JSON for jsonc/jsonl; plain text for md).
 *
 * Returns a structured result; never throws on parser-tolerated input.
 * Sentinel-guard violations DO throw `OcEmitSentinelError` (defense in
 * depth — refuse to write redacted content even when caller "asked").
 */
export function setOcPath(ast: OcAst, path: OcPath, value: string): SetResult {
  // Wildcard guard: `setOcPath` writes a single concrete leaf. A pattern
  // would be ambiguous (which match wins?) so we reject early. Callers
  // who want multi-set should `findOcPaths(...)` then `setOcPath` per
  // resolved path — the explicit loop is the right shape.
  if (hasWildcard(path)) {
    return {
      ok: false,
      reason: 'wildcard-not-allowed',
      detail: 'setOcPath requires a concrete path; use findOcPaths to enumerate matches first',
    };
  }
  const insertion = detectInsertion(path);
  if (insertion !== null) {
    return setInsertion(ast, insertion, value);
  }

  switch (ast.kind) {
    case 'md':
      return setMdLeaf(ast, path, value);
    case 'jsonc':
      return setJsoncLeaf(ast, path, value);
    case 'jsonl':
      return setJsonlLeaf(ast, path, value);
    case 'yaml':
      return setYamlLeaf(ast, path, value);
  }
  throw new Error(`unreachable: setOcPath kind`);
}

function setYamlLeaf(ast: YamlAst, path: OcPath, value: string): SetResult {
  const existing = resolveYamlOcPath(ast, path);
  if (existing === null) {return { ok: false, reason: 'unresolved' };}
  if (existing.kind === 'root') {
    return { ok: false, reason: 'not-writable', detail: 'root replacement not supported via setOcPath' };
  }
  // Coerce value based on existing scalar type.
  let coerced: unknown = value;
  if (existing.kind === 'scalar' || existing.kind === 'pair') {
    const cur = existing.value;
    if (typeof cur === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) {return { ok: false, reason: 'parse-error' };}
      coerced = n;
    } else if (typeof cur === 'boolean') {
      if (value === 'true') {coerced = true;}
      else if (value === 'false') {coerced = false;}
      else {return { ok: false, reason: 'parse-error' };}
    } else if (cur === null && value !== 'null') {
      return { ok: false, reason: 'parse-error' };
    } else if (cur === null && value === 'null') {
      coerced = null;
    }
  }
  const r = setYamlOcPath(ast, path, coerced);
  if (r.ok) {return { ok: true, ast: r.ast };}
  return { ok: false, reason: r.reason };
}

function setMdLeaf(ast: MdAst, path: OcPath, value: string): SetResult {
  const r = setMdOcPath(ast, path, value);
  if (r.ok) {return { ok: true, ast: r.ast };}
  return { ok: false, reason: r.reason };
}

function setJsoncLeaf(ast: JsoncAst, path: OcPath, value: string): SetResult {
  // Inspect the existing leaf to determine target type for coercion.
  const existing = resolveJsoncOcPath(ast, path);
  if (existing === null) {return { ok: false, reason: 'unresolved' };}
  if (existing.kind === 'root') {
    return { ok: false, reason: 'not-writable', detail: 'root replacement is not supported via setOcPath' };
  }
  const leafValue = existing.kind === 'object-entry' ? existing.node.value : existing.node;
  const coerced = coerceJsoncLeaf(value, leafValue);
  if (coerced === null) {
    return { ok: false, reason: 'parse-error', detail: `cannot coerce "${value}" to ${leafValue.kind}` };
  }
  const r = setJsoncOcPath(ast, path, coerced);
  if (r.ok) {return { ok: true, ast: r.ast };}
  return { ok: false, reason: r.reason };
}

function setJsonlLeaf(ast: JsonlAst, path: OcPath, value: string): SetResult {
  const existing = resolveJsonlOcPath(ast, path);
  if (existing === null) {return { ok: false, reason: 'unresolved' };}
  if (existing.kind === 'root') {
    return { ok: false, reason: 'not-writable', detail: 'root replacement is not supported via setOcPath' };
  }
  if (existing.kind === 'line') {
    // Replacing a whole line — value should be JSON.
    const parsed = tryParseJson(value);
    if (parsed === undefined) {
      return { ok: false, reason: 'parse-error', detail: `line replacement requires JSON value` };
    }
    const r = setJsonlOcPath(ast, path, jsonToJsoncValue(parsed));
    if (r.ok) {return { ok: true, ast: r.ast };}
    return { ok: false, reason: r.reason };
  }
  // Field on a line — leaf coercion.
  const leafValue = existing.kind === 'object-entry' ? existing.node.value : existing.node;
  const coerced = coerceJsoncLeaf(value, leafValue);
  if (coerced === null) {
    return { ok: false, reason: 'parse-error', detail: `cannot coerce "${value}" to ${leafValue.kind}` };
  }
  const r = setJsonlOcPath(ast, path, coerced);
  if (r.ok) {return { ok: true, ast: r.ast };}
  return { ok: false, reason: r.reason };
}

function setInsertion(ast: OcAst, info: InsertionInfo, value: string): SetResult {
  switch (ast.kind) {
    case 'md':
      return setMdInsertion(ast, info, value);
    case 'jsonc':
      return setJsoncInsertion(ast, info, value);
    case 'jsonl':
      return setJsonlInsertion(ast, info, value);
    case 'yaml':
      return setYamlInsertion(ast, info, value);
  }
  throw new Error(`unreachable: setInsertion kind`);
}

function setYamlInsertion(ast: YamlAst, info: InsertionInfo, value: string): SetResult {
  // YAML insertion accepts a JSON-shaped value string (so callers can
  // insert structured nodes uniformly). For simple scalars the JSON
  // form `"foo"` / `42` / `true` works; complex shapes use objects.
  const parsed = tryParseJson(value);
  if (parsed === undefined) {
    return { ok: false, reason: 'parse-error', detail: 'yaml insertion requires JSON value' };
  }
  const r = insertYamlOcPath(ast, info.parentPath, info.marker, parsed);
  if (r.ok) {return { ok: true, ast: r.ast };}
  return { ok: false, reason: r.reason };
}

function setMdInsertion(ast: MdAst, info: InsertionInfo, value: string): SetResult {
  const p = info.parentPath;
  // file-level: append a section. Value is the heading text; body empty.
  if (p.section === undefined) {
    if (info.marker !== '+') {
      return { ok: false, reason: 'not-writable', detail: 'md file-level insertion uses bare `+`' };
    }
    const newAst: MdAst = {
      ...ast,
      blocks: [
        ...ast.blocks,
        {
          heading: value,
          slug: slugifyHeading(value),
          line: 0,
          bodyText: '',
          items: [],
          tables: [],
          codeBlocks: [],
        },
      ],
    };
    return { ok: true, ast: rebuildMdRaw(newAst) };
  }

  // [frontmatter] — keyed insertion only
  if (p.section === '[frontmatter]') {
    if (typeof info.marker !== 'object' || info.marker.kind !== 'keyed') {
      return { ok: false, reason: 'not-writable', detail: 'md frontmatter insertion requires +key' };
    }
    const key = info.marker.key;
    if (ast.frontmatter.some((e) => e.key === key)) {
      return { ok: false, reason: 'type-mismatch', detail: `frontmatter key '${key}' already exists; use set, not insert` };
    }
    const newAst: MdAst = {
      ...ast,
      frontmatter: [...ast.frontmatter, { key, value, line: 0 }],
    };
    return { ok: true, ast: rebuildMdRaw(newAst) };
  }

  // section-level: append item. Value can be `key: value` (kv) or plain text.
  if (p.item === undefined && p.field === undefined) {
    if (info.marker !== '+') {
      return { ok: false, reason: 'not-writable', detail: 'md section insertion uses bare `+`' };
    }
    const blockIdx = ast.blocks.findIndex((b) => b.slug === p.section!.toLowerCase());
    if (blockIdx === -1) {return { ok: false, reason: 'unresolved' };}
    const block = ast.blocks[blockIdx];
    const kvMatch = /^([^:]+?)\s*:\s*(.+)$/.exec(value);
    const itemLine = `- ${value}`;
    const newItem = {
      text: value,
      slug: slugifyHeading(kvMatch ? kvMatch[1] : value),
      line: 0,
      ...(kvMatch !== null
        ? { kv: { key: kvMatch[1].trim(), value: kvMatch[2].trim() } }
        : {}),
    };
    const newBodyText = block.bodyText.length === 0
      ? itemLine
      : block.bodyText.replace(/\n*$/, '\n') + itemLine;
    const newBlocks = ast.blocks.slice();
    newBlocks[blockIdx] = {
      ...block,
      items: [...block.items, newItem],
      bodyText: newBodyText,
    };
    return { ok: true, ast: rebuildMdRaw({ ...ast, blocks: newBlocks }) };
  }

  return { ok: false, reason: 'not-writable' };
}

function setJsoncInsertion(ast: JsoncAst, info: InsertionInfo, value: string): SetResult {
  const containerMatch = resolveJsoncInsertion(ast, info);
  if (containerMatch === null) {return { ok: false, reason: 'unresolved' };}

  const parsed = tryParseJson(value);
  if (parsed === undefined) {
    return { ok: false, reason: 'parse-error', detail: 'jsonc insertion requires JSON value' };
  }
  const newJsoncValue = jsonToJsoncValue(parsed);

  if (containerMatch.kind !== 'insertion-point') {return { ok: false, reason: 'unresolved' };}

  if (containerMatch.container === 'jsonc-array') {
    // index `+0` valid; bare `+` appends; `+key` rejected.
    if (typeof info.marker === 'object' && info.marker.kind === 'keyed') {
      return { ok: false, reason: 'type-mismatch', detail: 'cannot insert by key into array' };
    }
    return mutateJsoncContainer(ast, info.parentPath, (container) => {
      if (container.kind !== 'array') {return null;}
      const items = container.items.slice();
      if (info.marker === '+') {
        items.push(newJsoncValue);
      } else if (typeof info.marker === 'object' && info.marker.kind === 'indexed') {
        const idx = Math.min(info.marker.index, items.length);
        items.splice(idx, 0, newJsoncValue);
      }
      return {
        kind: 'array',
        items,
        ...(container.line !== undefined ? { line: container.line } : {}),
      };
    });
  }

  // jsonc-object
  if (typeof info.marker !== 'object' || info.marker.kind !== 'keyed') {
    return { ok: false, reason: 'type-mismatch', detail: 'jsonc object insertion requires +key' };
  }
  const key = info.marker.key;
  return mutateJsoncContainer(ast, info.parentPath, (container) => {
    if (container.kind !== 'object') {return null;}
    if (container.entries.some((e) => e.key === key)) {return null;} // duplicate
    const newEntry: JsoncEntry = { key, value: newJsoncValue, line: 0 };
    return {
      kind: 'object',
      entries: [...container.entries, newEntry],
      ...(container.line !== undefined ? { line: container.line } : {}),
    };
  });
}

function setJsonlInsertion(ast: JsonlAst, info: InsertionInfo, value: string): SetResult {
  if (info.parentPath.section !== undefined || info.marker !== '+') {
    return { ok: false, reason: 'not-writable', detail: 'jsonl insertion only supports oc://FILE/+ append' };
  }
  const parsed = tryParseJson(value);
  if (parsed === undefined) {
    return { ok: false, reason: 'parse-error', detail: 'jsonl line append requires JSON value' };
  }
  return { ok: true, ast: appendJsonlLine(ast, jsonToJsoncValue(parsed)) };
}

// ---------- Internal helpers -----------------------------------------------

function coerceJsoncLeaf(valueText: string, existing: JsoncValue): JsoncValue | null {
  // Preserve the existing source line on coerced replacements — the
  // semantic node is the same; only its bytes change.
  const lineExt = existing.line !== undefined ? { line: existing.line } : {};
  if (existing.kind === 'string') {return { kind: 'string', value: valueText, ...lineExt };}
  if (existing.kind === 'number') {
    const n = Number(valueText);
    return Number.isFinite(n) ? { kind: 'number', value: n, ...lineExt } : null;
  }
  if (existing.kind === 'boolean') {
    if (valueText === 'true') {return { kind: 'boolean', value: true, ...lineExt };}
    if (valueText === 'false') {return { kind: 'boolean', value: false, ...lineExt };}
    return null;
  }
  if (existing.kind === 'null') {
    return valueText === 'null' ? { kind: 'null', ...lineExt } : null;
  }
  // Object/array leaf — caller should use insertion or full-replace path.
  return null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function jsonToJsoncValue(v: unknown): JsoncValue {
  // Synthetic values omit `line` (optional in the type) — the parser
  // alone is the source of truth for line metadata. Insertions /
  // mutations get the parent's line for surfacing in lint findings.
  if (v === null) {return { kind: 'null' };}
  if (typeof v === 'string') {return { kind: 'string', value: v };}
  if (typeof v === 'number') {return { kind: 'number', value: v };}
  if (typeof v === 'boolean') {return { kind: 'boolean', value: v };}
  if (Array.isArray(v)) {return { kind: 'array', items: v.map(jsonToJsoncValue) };}
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return {
      kind: 'object',
      entries: Object.entries(obj).map(([key, value]) => ({
        key,
        value: jsonToJsoncValue(value),
        line: 0,
      })),
    };
  }
  // Unsupported (undefined / function / symbol). JSON.parse never produces these.
  throw new Error(`unsupported JSON value type: ${typeof v}`);
}

function mutateJsoncContainer(
  ast: JsoncAst,
  parentPath: OcPath,
  mutate: (container: JsoncValue) => JsoncValue | null,
): SetResult {
  if (ast.root === null) {return { ok: false, reason: 'no-root' };}

  // Quote-aware split so JSONC insertion under a key containing
  // `/`, `.`, or other special chars works through the parent path.
  // `resolveJsoncOcPath` validates with quote-aware splitting; the
  // mutation walker MUST use the same predicate or insertion validity
  // can be reported and then fail as unresolved.
  const segments: string[] = [];
  if (parentPath.section !== undefined) {segments.push(...splitRespectingBrackets(parentPath.section, '.'));}
  if (parentPath.item !== undefined) {segments.push(...splitRespectingBrackets(parentPath.item, '.'));}
  if (parentPath.field !== undefined) {segments.push(...splitRespectingBrackets(parentPath.field, '.'));}

  const newRoot = segments.length === 0
    ? mutate(ast.root)
    : mutateAt(ast.root, segments, 0, mutate);
  if (newRoot === null) {return { ok: false, reason: 'unresolved' };}

  const next: JsoncAst = { kind: 'jsonc', raw: '', root: newRoot };
  return { ok: true, ast: { ...next, raw: emitJsonc(next, { mode: 'render' }) } };
}

function mutateAt(
  current: JsoncValue,
  segments: readonly string[],
  i: number,
  mutate: (container: JsoncValue) => JsoncValue | null,
): JsoncValue | null {
  const seg = segments[i];
  if (seg === undefined) {return mutate(current);}
  if (seg.length === 0) {return null;}

  if (current.kind === 'object') {
    // Match `setJsoncOcPath`'s lookup: AST entry keys are unquoted,
    // so strip quoting from the path segment before comparing.
    const lookupKey = isQuotedSeg(seg) ? unquoteSeg(seg) : seg;
    const idx = current.entries.findIndex((e) => e.key === lookupKey);
    if (idx === -1) {return null;}
    const child = current.entries[idx];
    const replaced = mutateAt(child.value, segments, i + 1, mutate);
    if (replaced === null) {return null;}
    const newEntries = current.entries.slice();
    newEntries[idx] = { ...child, value: replaced };
    return {
      kind: 'object',
      entries: newEntries,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }
  if (current.kind === 'array') {
    const idx = Number(seg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) {return null;}
    const child = current.items[idx];
    const replaced = mutateAt(child, segments, i + 1, mutate);
    if (replaced === null) {return null;}
    const newItems = current.items.slice();
    newItems[idx] = replaced;
    return {
      kind: 'array',
      items: newItems,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }
  return null;
}

function rebuildMdRaw(ast: MdAst): MdAst {
  const parts: string[] = [];
  if (ast.frontmatter.length > 0) {
    parts.push('---');
    for (const fm of ast.frontmatter) {
      parts.push(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
    }
    parts.push('---');
  }
  if (ast.preamble.length > 0) {
    if (parts.length > 0) {parts.push('');}
    parts.push(ast.preamble);
  }
  for (const block of ast.blocks) {
    if (parts.length > 0) {parts.push('');}
    parts.push(`## ${block.heading}`);
    if (block.bodyText.length > 0) {parts.push(block.bodyText);}
  }
  // Suppress unused — emitJsonl is imported for symmetry but only emitJsonc
  // is used in the jsonc mutation helper.
  void emitJsonl;
  return { ...ast, raw: parts.join('\n') };
}

function formatFrontmatterValue(value: string): string {
  if (value.length === 0) {return '""';}
  if (/[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function slugifyHeading(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
