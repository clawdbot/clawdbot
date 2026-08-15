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
import { resolveJsoncValueOcPath } from "../jsonc/resolve-value.js";
import type { OcPath } from "../oc-path.js";
import { isQuotedSeg, splitRespectingBrackets, unquoteSeg } from "../oc-path.js";
import type { JsonlAst, JsonlLine } from "./ast.js";
import { pickJsonlLine } from "./line.js";

type JsonlOcPathMatch =
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

  const lineEntry = pickJsonlLine(ast, head);
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

  const match = resolveJsoncValueOcPath(lineEntry.value, segments);
  if (match === null) {
    return null;
  }
  if (match.kind === "object-entry") {
    return {
      kind: "object-entry",
      node: match.node,
      line: lineEntry.line,
      path: match.path,
    };
  }
  return { kind: "value", node: match.node, line: lineEntry.line, path: match.path };
}
