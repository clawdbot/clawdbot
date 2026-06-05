// OC Path module implements resolve value behavior.
import { isPositionalSeg, parseArrayIndexSegment, resolvePositionalSeg } from "../oc-path.js";
import type { JsoncEntry, JsoncValue } from "./ast.js";

export type JsoncValueOcPathMatch =
  | { readonly kind: "value"; readonly node: JsoncValue; readonly path: readonly string[] }
  | {
      readonly kind: "object-entry";
      readonly node: JsoncEntry;
      readonly path: readonly string[];
    };

export function resolveJsoncValueOcPath(
  root: JsoncValue,
  segments: readonly string[],
): JsoncValueOcPathMatch | null {
  let current: JsoncValue = root;
  let lastEntry: JsoncEntry | null = null;
  const walked: string[] = [];

  for (let seg of segments) {
    if (seg.length === 0) {
      return null;
    }
    if (isPositionalSeg(seg)) {
      const concrete = positionalForJsonc(current, seg);
      if (concrete !== null) {
        seg = concrete;
      }
    }
    walked.push(seg);
    if (current.kind === "object") {
      const entry = current.entries.find((e) => e.key === seg);
      if (entry === undefined) {
        return null;
      }
      lastEntry = entry;
      current = entry.value;
      continue;
    }
    if (current.kind === "array") {
      const idx = parseArrayIndexSegment(seg, current.items.length);
      if (idx === null) {
        return null;
      }
      lastEntry = null;
      const item = current.items[idx];
      if (item === undefined) {
        return null;
      }
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
