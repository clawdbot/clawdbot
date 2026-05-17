/**
 * Mutate a `JsonlAst` at an OcPath. Append uses `appendJsonlOcPath`;
 * `setJsonlOcPath` only edits existing addresses.
 *
 * @module @openclaw/oc-path/jsonl/edit
 */

import type { JsoncEntry, JsoncValue } from "../jsonc/ast.js";
import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import type { JsonlAst, JsonlLine } from "./ast.js";
import { emitJsonl } from "./emit.js";

export type JsonlEditResult =
  | { readonly ok: true; readonly ast: JsonlAst }
  | { readonly ok: false; readonly reason: "unresolved" | "not-a-value-line" };

export function setJsonlOcPath(ast: JsonlAst, path: OcPath, newValue: JsoncValue): JsonlEditResult {
  const head = path.section;
  if (head === undefined) {
    return { ok: false, reason: "unresolved" };
  }

  const lineIdx = pickLineIndex(ast, head);
  if (lineIdx === -1) {
    return { ok: false, reason: "unresolved" };
  }
  const target = ast.lines[lineIdx];
  if (target === undefined) {
    return { ok: false, reason: "unresolved" };
  }

  // No item/field — replace the whole line. Requires an existing value line.
  if (path.item === undefined && path.field === undefined) {
    if (target.kind !== "value") {
      return { ok: false, reason: "not-a-value-line" };
    }
    const newLine: JsonlLine = {
      kind: "value",
      line: target.line,
      value: newValue,
      raw: target.raw,
    };
    return finalize(ast, lineIdx, newLine, path.file);
  }

  if (target.kind !== "value") {
    return { ok: false, reason: "not-a-value-line" };
  }

  // Quote-aware split keeps edit symmetric with resolveJsonlOcPath.
  const segments: string[] = [];
  if (path.item !== undefined) {
    segments.push(...splitRespectingBrackets(path.item, "."));
  }
  if (path.field !== undefined) {
    segments.push(...splitRespectingBrackets(path.field, "."));
  }

  const replaced = replaceAt(target.value, segments, 0, newValue);
  if (replaced === null) {
    return { ok: false, reason: "unresolved" };
  }
  const newLine: JsonlLine = {
    kind: "value",
    line: target.line,
    value: replaced,
    raw: target.raw,
  };
  return finalize(ast, lineIdx, newLine, path.file);
}

function replaceAt(
  current: JsoncValue,
  segments: readonly string[],
  i: number,
  newValue: JsoncValue,
): JsoncValue | null {
  const seg = segments[i];
  if (seg === undefined) {
    return newValue;
  }
  if (seg.length === 0) {
    return null;
  }

  if (current.kind === "object") {
    // Positional tokens resolve against the entries' ordered key list;
    // quoted segments are unquoted before literal-key comparison.
    let segNorm = seg;
    if (isPositionalSeg(seg)) {
      const resolved = resolvePositionalSeg(seg, {
        indexable: false,
        size: current.entries.length,
        keys: current.entries.map((e) => e.key),
      });
      if (resolved === null) {
        return null;
      }
      segNorm = resolved;
    }
    const lookupKey = isQuotedSeg(segNorm) ? unquoteSeg(segNorm) : segNorm;
    const idx = current.entries.findIndex((e) => e.key === lookupKey);
    if (idx === -1) {
      return null;
    }
    const child = current.entries[idx];
    if (child === undefined) {
      return null;
    }
    const replacedChild = replaceAt(child.value, segments, i + 1, newValue);
    if (replacedChild === null) {
      return null;
    }
    const newEntry: JsoncEntry = { ...child, value: replacedChild };
    const newEntries = current.entries.slice();
    newEntries[idx] = newEntry;
    return {
      kind: "object",
      entries: newEntries,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  if (current.kind === "array") {
    let segNorm = seg;
    if (isPositionalSeg(seg)) {
      const resolved = resolvePositionalSeg(seg, {
        indexable: true,
        size: current.items.length,
      });
      if (resolved === null) {
        return null;
      }
      segNorm = resolved;
    }
    const idx = Number(segNorm);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) {
      return null;
    }
    const child = current.items[idx];
    if (child === undefined) {
      return null;
    }
    const replacedChild = replaceAt(child, segments, i + 1, newValue);
    if (replacedChild === null) {
      return null;
    }
    const newItems = current.items.slice();
    newItems[idx] = replacedChild;
    return {
      kind: "array",
      items: newItems,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  return null;
}

function pickLineIndex(ast: JsonlAst, addr: string): number {
  if (addr === "$first") {
    return ast.lines.findIndex((line) => line.kind === "value");
  }
  if (addr === "$last") {
    for (let i = ast.lines.length - 1; i >= 0; i--) {
      if (ast.lines[i]?.kind === "value") {
        return i;
      }
    }
    return -1;
  }
  const m = /^L(\d+)$/.exec(addr);
  if (m === null || m[1] === undefined) {
    return -1;
  }
  const target = Number(m[1]);
  return ast.lines.findIndex((l) => l.line === target);
}

function finalize(
  ast: JsonlAst,
  lineIdx: number,
  newLine: JsonlLine,
  fileName?: string,
): JsonlEditResult {
  const newLines = ast.lines.slice();
  newLines[lineIdx] = newLine;
  const next: JsonlAst = {
    kind: "jsonl",
    raw: "",
    lines: newLines,
    ...(ast.lineEnding !== undefined ? { lineEnding: ast.lineEnding } : {}),
  };
  const opts =
    fileName !== undefined
      ? { mode: "render" as const, fileNameForGuard: fileName }
      : { mode: "render" as const };
  const rendered = emitJsonl(next, opts);
  return { ok: true, ast: { ...next, raw: rendered } };
}

/** Append a value as the next line. Line numbers are substrate-assigned. */
export function appendJsonlOcPath(ast: JsonlAst, value: JsoncValue): JsonlAst {
  const nextLineNo = ast.lines.length === 0 ? 1 : (ast.lines[ast.lines.length - 1]?.line ?? 0) + 1;
  const newLine: JsonlLine = {
    kind: "value",
    line: nextLineNo,
    value,
    raw: "",
  };
  const next: JsonlAst = {
    kind: "jsonl",
    raw: "",
    lines: [...ast.lines, newLine],
    ...(ast.lineEnding !== undefined ? { lineEnding: ast.lineEnding } : {}),
  };
  const rendered = emitJsonl(next, { mode: "render" });
  return { ...next, raw: rendered };
}
