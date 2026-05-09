/**
 * Resolve `OcPath` against `JsoncAst`. Slot segments concat as if
 * dotted; segments are bracket/quote-aware-split so quoted keys
 * containing `/` or `.` round-trip cleanly.
 *
 * @module @openclaw/oc-path/jsonc/resolve
 */

import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import type { JsoncAst, JsoncEntry, JsoncValue } from "./ast.js";

export type JsoncOcPathMatch =
  | { readonly kind: "root"; readonly node: JsoncAst }
  | { readonly kind: "value"; readonly node: JsoncValue; readonly path: readonly string[] }
  | {
      readonly kind: "object-entry";
      readonly node: JsoncEntry;
      readonly path: readonly string[];
    };

export function resolveJsoncOcPath(ast: JsoncAst, path: OcPath): JsoncOcPathMatch | null {
  if (ast.root === null) {return null;}

  const segments: string[] = [];
  const collect = (slot: string | undefined): void => {
    if (slot === undefined) {return;}
    for (const s of splitRespectingBrackets(slot, ".")) {
      segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
    }
  };
  collect(path.section);
  collect(path.item);
  collect(path.field);

  if (segments.length === 0) {return { kind: "root", node: ast };}

  let current: JsoncValue = ast.root;
  let lastEntry: JsoncEntry | null = null;
  const walked: string[] = [];

  for (let seg of segments) {
    if (seg.length === 0) {return null;}
    if (isPositionalSeg(seg)) {
      const concrete = positionalForJsonc(current, seg);
      if (concrete !== null) {seg = concrete;}
    }
    walked.push(seg);
    if (current.kind === "object") {
      const entry = current.entries.find((e) => e.key === seg);
      if (entry === undefined) {return null;}
      lastEntry = entry;
      current = entry.value;
      continue;
    }
    if (current.kind === "array") {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) {return null;}
      lastEntry = null;
      const item = current.items[idx];
      if (item === undefined) {return null;}
      current = item;
      continue;
    }
    return null;
  }

  if (lastEntry !== null && current === lastEntry.value) {
    return { kind: "object-entry", node: lastEntry, path: walked };
  }
  return { kind: "value", node: current, path: walked };
}

function positionalForJsonc(node: JsoncValue, seg: string): string | null {
  if (node.kind === "object") {
    const keys = node.entries.map((e) => e.key);
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (node.kind === "array") {
    return resolvePositionalSeg(seg, { indexable: true, size: node.items.length });
  }
  return null;
}
