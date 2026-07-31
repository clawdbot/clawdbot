// OC Path module implements edit behavior.
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import type { OcPath } from "../oc-path.js";
import {
  isPositionalSeg,
  isQuotedSeg,
  parseArrayIndexSegment,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import { OcEmitSentinelError, REDACTED_SENTINEL } from "../sentinel.js";
import type { JsoncAst, JsoncValue } from "./ast.js";
import { parseJsonc } from "./parse.js";

type JsoncEditPath = Array<string | number>;
type JsoncEditTarget = { readonly path: JsoncEditPath; readonly value: JsoncValue };

type JsoncEditResult =
  | { readonly ok: true; readonly ast: JsoncAst }
  | { readonly ok: false; readonly reason: "unresolved" | "no-root" };

export function setJsoncOcPath(ast: JsoncAst, path: OcPath, newValue: JsoncValue): JsoncEditResult {
  if (ast.root === null) {
    return { ok: false, reason: "no-root" };
  }

  const target = resolveEditTarget(ast.root, pathSegments(path));
  if (target === null) {
    return { ok: false, reason: "unresolved" };
  }
  guardSentinel(newValue, `oc://${path.file}/${target.path.join("/")}`);
  return applyJsoncEdit(ast, target.path, newValue, false);
}

export function insertJsoncOcPath(
  ast: JsoncAst,
  parentPath: OcPath,
  indexOrKey: number | string,
  newValue: JsoncValue,
): JsoncEditResult {
  if (ast.root === null) {
    return { ok: false, reason: "no-root" };
  }

  const target = resolveEditTarget(ast.root, pathSegments(parentPath));
  if (target === null) {
    return { ok: false, reason: "unresolved" };
  }
  if (typeof indexOrKey === "string") {
    if (
      target.value.kind !== "object" ||
      target.value.entries.some((entry) => entry.key === indexOrKey)
    ) {
      return { ok: false, reason: "unresolved" };
    }
  } else if (target.value.kind !== "array") {
    return { ok: false, reason: "unresolved" };
  }

  const segment = typeof indexOrKey === "number" && indexOrKey < 0 ? -1 : indexOrKey;
  const editPath = [...target.path, segment];
  guardSentinel(newValue, `oc://${parentPath.file}/${editPath.join("/")}`);
  return applyJsoncEdit(ast, editPath, newValue, typeof segment === "number");
}

function applyJsoncEdit(
  ast: JsoncAst,
  path: JsoncEditPath,
  newValue: JsoncValue,
  isArrayInsertion: boolean,
): JsoncEditResult {
  const edits = modify(ast.raw, path, jsoncValueToJson(newValue), {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
    isArrayInsertion,
  });
  if (edits.length === 0) {
    return { ok: false, reason: "unresolved" };
  }

  const nextRaw = applyEdits(ast.raw, edits);
  const reparsed = parseJsonc(nextRaw);
  if (reparsed.ast.root === null) {
    return { ok: false, reason: "unresolved" };
  }
  return { ok: true, ast: reparsed.ast };
}

function guardSentinel(value: JsoncValue, guardPath: string): void {
  if (value.kind === "string") {
    if (value.value.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(guardPath);
    }
    return;
  }
  if (value.kind === "array") {
    value.items.forEach((item, index) => guardSentinel(item, `${guardPath}/${index}`));
    return;
  }
  if (value.kind === "object") {
    value.entries.forEach((entry) => guardSentinel(entry.value, `${guardPath}/${entry.key}`));
  }
}

function pathSegments(path: OcPath): string[] {
  const out: string[] = [];
  const collect = (slot: string | undefined) => {
    if (slot === undefined) {
      return;
    }
    for (const segment of splitRespectingBrackets(slot, ".")) {
      out.push(isQuotedSeg(segment) ? unquoteSeg(segment) : segment);
    }
  };
  collect(path.section);
  collect(path.item);
  collect(path.field);
  return out;
}

function resolveEditTarget(root: JsoncValue, segments: readonly string[]): JsoncEditTarget | null {
  const out: JsoncEditPath = [];
  let current: JsoncValue = root;
  for (let segment of segments) {
    if (segment.length === 0) {
      return null;
    }
    if (isPositionalSeg(segment)) {
      const concrete = positionalForJsonc(current, segment);
      if (concrete !== null) {
        segment = concrete;
      }
    }
    if (current.kind === "object") {
      const entry = current.entries.find((candidate) => candidate.key === segment);
      if (!entry) {
        return null;
      }
      out.push(segment);
      current = entry.value;
      continue;
    }
    if (current.kind === "array") {
      const index = parseArrayIndexSegment(segment, current.items.length);
      if (index === null) {
        return null;
      }
      out.push(index);
      current = current.items[index]!;
      continue;
    }
    return null;
  }
  return { path: out, value: current };
}

function positionalForJsonc(node: JsoncValue, segment: string): string | null {
  if (node.kind === "object") {
    const keys = node.entries.map((entry) => entry.key);
    return resolvePositionalSeg(segment, { indexable: false, size: keys.length, keys });
  }
  if (node.kind === "array") {
    return resolvePositionalSeg(segment, { indexable: true, size: node.items.length });
  }
  return null;
}

function jsoncValueToJson(value: JsoncValue): unknown {
  switch (value.kind) {
    case "object":
      return Object.fromEntries(
        value.entries.map((entry) => [entry.key, jsoncValueToJson(entry.value)]),
      );
    case "array":
      return value.items.map(jsoncValueToJson);
    case "string":
      return value.value;
    case "number":
      return value.value;
    case "boolean":
      return value.value;
    case "null":
      return null;
  }
  return null;
}
