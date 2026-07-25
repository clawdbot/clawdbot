/**
 * Resolve `OcPath` against `JsoncAst`. Slot segments concat as if
 * dotted; segments are bracket/quote-aware-split so quoted keys
 * containing `/` or `.` round-trip cleanly.
 *
 * @module @openclaw/oc-path/jsonc/resolve
 */

import type { OcPath } from "../oc-path.js";
import { isQuotedSeg, splitRespectingBrackets, unquoteSeg } from "../oc-path.js";
import type { JsoncAst, JsoncEntry, JsoncValue } from "./ast.js";
import { resolveJsoncValueOcPath } from "./resolve-value.js";

type JsoncOcPathMatch =
  | { readonly kind: "root"; readonly node: JsoncAst }
  | { readonly kind: "value"; readonly node: JsoncValue; readonly path: readonly string[] }
  | {
      readonly kind: "object-entry";
      readonly node: JsoncEntry;
      readonly path: readonly string[];
    };

export function resolveJsoncOcPath(ast: JsoncAst, path: OcPath): JsoncOcPathMatch | null {
  if (ast.root === null) {
    return null;
  }

  const segments: string[] = [];
  const collect = (slot: string | undefined): void => {
    if (slot === undefined) {
      return;
    }
    for (const s of splitRespectingBrackets(slot, ".")) {
      segments.push(isQuotedSeg(s) ? unquoteSeg(s) : s);
    }
  };
  collect(path.section);
  collect(path.item);
  collect(path.field);

  if (segments.length === 0) {
    return { kind: "root", node: ast };
  }

  return resolveJsoncValueOcPath(ast.root, segments);
}
