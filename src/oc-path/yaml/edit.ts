/**
 * Mutate a `YamlAst` at an OcPath. Returns a new AST with the value
 * replaced.
 *
 * Implementation uses `doc.setIn(path, value)` from the `yaml` package
 * — comment-preserving on edit. Adding a new key does NOT preserve
 * surrounding formatting verbatim (the `yaml` library handles
 * pretty-printing); for byte-exact preservation use round-trip emit
 * on unmodified ASTs.
 *
 * @module @openclaw/oc-path/yaml/edit
 */

import {
  Document,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
  type Pair,
} from 'yaml';
import type { OcPath } from '../oc-path.js';
import {
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from '../oc-path.js';
import type { YamlAst } from './ast.js';

export type YamlEditResult =
  | { readonly ok: true; readonly ast: YamlAst }
  | {
      readonly ok: false;
      readonly reason: 'unresolved' | 'no-root' | 'parse-error';
    };

export function setYamlOcPath(
  ast: YamlAst,
  path: OcPath,
  newValue: unknown,
): YamlEditResult {
  if (ast.doc.contents === null) {return { ok: false, reason: 'no-root' };}

  const rawSegments = pathSegments(path);
  if (rawSegments.length === 0) {
    return { ok: false, reason: 'unresolved' };
  }

  // Resolve positional tokens ($first / $last / -N) against the actual
  // map keys / seq sizes BEFORE handing the segments to the yaml lib —
  // otherwise `hasIn(['$last'])` treats the token as a literal map key
  // and silently unresolves, producing a write↔read asymmetry with
  // resolveYamlOcPath (which honors positional tokens at lookup).
  const segments = resolvePositionalSegments(ast.doc.contents as Node, rawSegments);
  if (segments === null) {return { ok: false, reason: 'unresolved' };}

  // Verify the path resolves before mutating — `setIn` would create
  // missing intermediate nodes which is insertion semantics, not set.
  if (!ast.doc.hasIn(segments)) {
    return { ok: false, reason: 'unresolved' };
  }

  // Clone the document so the original AST is unchanged.
  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);
  cloned.setIn(segments, newValue);
  return { ok: true, ast: { kind: 'yaml', raw: cloned.toString(), doc: cloned, lineCounter } };
}

/**
 * Append-style insertion: add a new key to a map or push to a seq at
 * `path`. Used by the universal `setOcPath` when the path carries a
 * `+` / `+key` / `+nnn` insertion marker.
 */
export function insertYamlOcPath(
  ast: YamlAst,
  parentPath: OcPath,
  marker: '+' | { kind: 'keyed'; key: string } | { kind: 'indexed'; index: number },
  newValue: unknown,
): YamlEditResult {
  if (ast.doc.contents === null) {return { ok: false, reason: 'no-root' };}

  const rawParentSegments = pathSegments(parentPath);
  // Resolve positional tokens against the live document before walking
  // — same rationale as setYamlOcPath; `getIn(['$last'])` would treat
  // the token as a literal key and miss the actual last child.
  const segments =
    rawParentSegments.length === 0
      ? rawParentSegments
      : resolvePositionalSegments(ast.doc.contents as Node, rawParentSegments);
  if (segments === null) {return { ok: false, reason: 'unresolved' };}
  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);

  // Find the parent node.
  const parent = segments.length === 0 ? cloned.contents : cloned.getIn(segments, false);
  if (parent === undefined || parent === null) {return { ok: false, reason: 'unresolved' };}

  // Map insertion → keyed
  if (typeof parent === 'object' && 'items' in parent && Array.isArray((parent as { items: unknown[] }).items)) {
    const items = (parent as { items: { key?: unknown }[] }).items;
    // Array#every() already returns true on an empty array — no need
    // for the explicit length === 0 short-circuit.
    const isMapLike = items.every((p) => 'key' in p);

    if (isMapLike) {
      if (typeof marker !== 'object' || marker.kind !== 'keyed') {
        return { ok: false, reason: 'unresolved' };
      }
      // Reject duplicate
      if (cloned.hasIn([...segments, marker.key])) {
        return { ok: false, reason: 'unresolved' };
      }
      cloned.setIn([...segments, marker.key], newValue);
      return { ok: true, ast: { kind: 'yaml', raw: cloned.toString(), doc: cloned, lineCounter } };
    }

    // Seq insertion
    if (typeof marker === 'object' && marker.kind === 'keyed') {
      return { ok: false, reason: 'unresolved' };
    }
    const seqItems = items as unknown[];
    if (marker === '+') {
      cloned.addIn(segments, newValue);
    } else if (typeof marker === 'object' && marker.kind === 'indexed') {
      const idx = Math.min(marker.index, seqItems.length);
      const current = cloned.getIn(segments) as unknown[] | undefined;
      if (!Array.isArray(current)) {return { ok: false, reason: 'unresolved' };}
      const newArr = [...current];
      newArr.splice(idx, 0, newValue);
      cloned.setIn(segments, newArr);
    }
    return { ok: true, ast: { kind: 'yaml', raw: cloned.toString(), doc: cloned, lineCounter } };
  }

  return { ok: false, reason: 'unresolved' };
}

/**
 * Walk `segments` against the live document, replacing each positional
 * token (`$first` / `$last` / `-N`) with the concrete key (for maps) or
 * index (for seqs) at that depth. Returns `null` if a positional token
 * targets a missing or non-container node — caller treats that as
 * `unresolved` and refuses to write.
 *
 * Mirrors `positionalForYaml` in resolve.ts so read and write agree on
 * which child each token names.
 */
function resolvePositionalSegments(
  root: Node,
  segments: readonly string[],
): string[] | null {
  const out: string[] = [];
  let node: Node | null = root;
  for (const seg of segments) {
    if (node === null) {return null;}
    let segNorm = seg;
    if (isPositionalSeg(seg)) {
      const concrete = positionalForYamlNode(node, seg);
      if (concrete === null) {return null;}
      segNorm = concrete;
    }
    out.push(segNorm);
    if (isMap(node)) {
      const pairs: readonly Pair[] = (node as { items: readonly Pair[] }).items;
      const pair: Pair | undefined = pairs.find((p) => {
        const k = isScalar(p.key) ? p.key.value : p.key;
        return String(k) === segNorm;
      });
      node = (pair?.value as Node | undefined) ?? null;
      continue;
    }
    if (isSeq(node)) {
      const idx = Number(segNorm);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) {return null;}
      node = (node.items[idx] as Node | null) ?? null;
      continue;
    }
    // Scalar — we still emit the literal segment so the next-step
    // hasIn check sees the same shape and fails cleanly with
    // `unresolved`. Don't try to descend further.
    node = null;
  }
  return out;
}

function positionalForYamlNode(node: Node, seg: string): string | null {
  if (isMap(node)) {
    const pairs: readonly Pair[] = (node as { items: readonly Pair[] }).items;
    const keys: readonly string[] = pairs.map((p) =>
      String(isScalar(p.key) ? p.key.value : p.key),
    );
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (isSeq(node)) {
    const items: readonly Node[] = (node as { items: readonly Node[] }).items;
    return resolvePositionalSeg(seg, { indexable: true, size: items.length });
  }
  return null;
}

function pathSegments(path: OcPath): string[] {
  // Quote-aware split + unquote so YAML edit matches `resolveYamlOcPath`'s
  // lookup behavior. A quoted segment carrying `/` or `.` (e.g.
  // `"a/b"`) survives as a single segment, then gets stripped of
  // its surrounding quotes for the actual `getIn` / `setIn` key
  // comparison. Plain `.split('.')` would shred quoted keys and
  // produce silent resolve↔write asymmetry.
  const segs: string[] = [];
  const collect = (slot: string | undefined) => {
    if (slot === undefined) {return;}
    for (const sub of splitRespectingBrackets(slot, '.')) {
      segs.push(isQuotedSeg(sub) ? unquoteSeg(sub) : sub);
    }
  };
  collect(path.section);
  collect(path.item);
  collect(path.field);
  return segs;
}

function cloneDoc(doc: Document.Parsed): { doc: Document.Parsed; lineCounter: LineCounter } {
  // Round-trip via toString → parseDocument is the simplest comment-
  // preserving clone. yaml package doesn't expose a public `clone`.
  // Re-parse with a fresh LineCounter so the cloned AST has accurate
  // line positions for any subsequent inspection.
  const lineCounter = new LineCounter();
  const cloned = parseDocument(doc.toString(), {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter,
  });
  return { doc: cloned, lineCounter };
}
