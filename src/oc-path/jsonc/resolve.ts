/**
 * Resolve an `OcPath` against a `JsoncAst`.
 *
 * The OcPath model has 4 segments (file, section, item, field) — for
 * JSONC artifacts that's not enough depth, so segments concat with `/`
 * AND a section/item/field MAY contain dots (`.`) for deeper traversal.
 * Both forms work:
 *
 *   oc://config/plugins/entries/foo               (segment-per-key)
 *   oc://config/plugins.entries.foo               (dotted section)
 *   oc://config/plugins/entries.foo               (mixed)
 *
 * Each segment is split on `.`, and the resulting flat list of keys
 * walks the value tree from `ast.root`. Numeric segments index into
 * arrays.
 *
 * @module @openclaw/oc-path/jsonc/resolve
 */

import type { OcPath } from '../oc-path.js';
import {
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from '../oc-path.js';
import type { JsoncAst, JsoncEntry, JsoncValue } from './ast.js';

export type JsoncOcPathMatch =
  | { readonly kind: 'root'; readonly node: JsoncAst }
  | { readonly kind: 'value'; readonly node: JsoncValue; readonly path: readonly string[] }
  | {
      readonly kind: 'object-entry';
      readonly node: JsoncEntry;
      readonly path: readonly string[];
    };

/**
 * Walk the JSONC tree following the OcPath. Returns the matched node
 * or `null`. Numeric path segments index into arrays.
 */
export function resolveJsoncOcPath(
  ast: JsoncAst,
  path: OcPath,
): JsoncOcPathMatch | null {
  if (ast.root === null) {return null;}

  // Bracket-aware split + unquote: `"foo/bar".baz` becomes
  // [`foo/bar`, `baz`] (literal slash preserved in the first sub).
  const segments: string[] = [];
  if (path.section !== undefined) {
    for (const s of splitRespectingBrackets(path.section, '.')) {
      segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
    }
  }
  if (path.item !== undefined) {
    for (const s of splitRespectingBrackets(path.item, '.')) {
      segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
    }
  }
  if (path.field !== undefined) {
    for (const s of splitRespectingBrackets(path.field, '.')) {
      segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
    }
  }

  if (segments.length === 0) {return { kind: 'root', node: ast };}

  let current: JsoncValue = ast.root;
  let lastEntry: JsoncEntry | null = null;
  const walked: string[] = [];

  for (let seg of segments) {
    if (seg.length === 0) {return null;}
    // Positional resolution: `$first` / `$last` always; `-N` only on
    // indexable (array) containers. On a keyed (object) container, a
    // `-N` segment falls through to literal-key lookup so paths like
    // `groups.-5028303500.requireMention` (Telegram supergroup IDs —
    // openclaw#59934) address the literal key instead of crashing.
    if (isPositionalSeg(seg)) {
      const concrete = positionalForJsonc(current, seg);
      if (concrete !== null) {seg = concrete;}
      // null means "not applicable" — fall through to literal lookup.
    }
    walked.push(seg);
    if (current.kind === 'object') {
      const entry = current.entries.find((e) => e.key === seg);
      if (entry === undefined) {return null;}
      lastEntry = entry;
      current = entry.value;
      continue;
    }
    if (current.kind === 'array') {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) {return null;}
      lastEntry = null;
      const item = current.items[idx];
      if (item === undefined) {return null;}
      current = item;
      continue;
    }
    // Primitive — can't descend further.
    return null;
  }

  if (lastEntry !== null && current === lastEntry.value) {
    return { kind: 'object-entry', node: lastEntry, path: walked };
  }
  return { kind: 'value', node: current, path: walked };
}

function positionalForJsonc(node: JsoncValue, seg: string): string | null {
  if (node.kind === 'object') {
    const keys = node.entries.map((e) => e.key);
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (node.kind === 'array') {
    return resolvePositionalSeg(seg, { indexable: true, size: node.items.length });
  }
  return null;
}
