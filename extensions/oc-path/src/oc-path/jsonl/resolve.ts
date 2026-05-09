/**
 * Resolve an `OcPath` against a `JsonlAst`.
 *
 * Convention for JSONL OcPaths:
 *
 *   oc://session-events/L42                  → entire line 42 value
 *   oc://session-events/L42/result           → field on line 42's value
 *   oc://session-events/L42/result.detail    → dotted descent
 *   oc://session-events/$last                → final non-blank value
 *
 * `Lnnn` (line address) and `$last` are the addressing primitives
 * unique to JSONL — they're how forensics / replay refers to a
 * specific entry without committing to a content key.
 *
 * @module @openclaw/oc-path/jsonl/resolve
 */

import type { JsoncEntry, JsoncValue } from "../jsonc/ast.js";
import type { OcPath } from "../oc-path.js";
import {
  POS_LAST,
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import type { JsonlAst, JsonlLine } from "./ast.js";

export type JsonlOcPathMatch =
  | { readonly kind: "root"; readonly node: JsonlAst }
  | { readonly kind: "line"; readonly node: JsonlLine }
  | {
      readonly kind: "value";
      readonly node: JsoncValue;
      readonly line: number;
      readonly path: readonly string[];
    }
  | {
      readonly kind: "object-entry";
      readonly node: JsoncEntry;
      readonly line: number;
      readonly path: readonly string[];
    };

export function resolveJsonlOcPath(ast: JsonlAst, path: OcPath): JsonlOcPathMatch | null {
  // The first non-file segment is the line address (Lnnn or $last).
  const head = path.section;
  if (head === undefined) {
    return { kind: "root", node: ast };
  }

  const lineEntry = pickLine(ast, head);
  if (lineEntry === null) {
    return null;
  }

  // No further descent — return the line entry itself.
  if (path.item === undefined && path.field === undefined) {
    return { kind: "line", node: lineEntry };
  }

  if (lineEntry.kind !== "value") {
    return null;
  }

  const segments: string[] = [];
  if (path.item !== undefined) {
    for (const s of splitRespectingBrackets(path.item, ".")) {
      segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
    }
  }
  if (path.field !== undefined) {
    for (const s of splitRespectingBrackets(path.field, ".")) {
      segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
    }
  }

  let current: JsoncValue = lineEntry.value;
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
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) {
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
    return {
      kind: "object-entry",
      node: lastEntry,
      line: lineEntry.line,
      path: walked,
    };
  }
  return { kind: "value", node: current, line: lineEntry.line, path: walked };
}

function pickLine(ast: JsonlAst, addr: string): JsonlLine | null {
  if (addr === POS_LAST) {
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
