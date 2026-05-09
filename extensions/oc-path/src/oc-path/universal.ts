/**
 * Universal `setOcPath` / `resolveOcPath` / `detectInsertion`.
 * Addressing is universal; encoding is per-kind. Callers pass any AST
 * + path + value; the substrate dispatches on `ast.kind` and coerces
 * the value based on the AST shape at the resolution point. Wildcard,
 * union, and predicate expansion belong to `findOcPaths`; `resolveOcPath`
 * and `setOcPath` require concrete paths.
 *
 *   oc://FILE/section/item/field   → leaf address
 *   oc://FILE/section/+            → end-insertion
 *   oc://FILE/section/+key         → keyed insertion
 *   oc://FILE/section/+0           → indexed insertion
 *   oc://FILE/+                    → file-root insertion
 *
 * @module @openclaw/oc-path/universal
 */

import type { MdAst } from "./ast.js";
import { setMdOcPath } from "./edit.js";
import type { JsoncAst, JsoncEntry, JsoncValue } from "./jsonc/ast.js";
import { setJsoncOcPath } from "./jsonc/edit.js";
import { emitJsonc } from "./jsonc/emit.js";
import { resolveJsoncOcPath } from "./jsonc/resolve.js";
import type { JsonlAst } from "./jsonl/ast.js";
import { appendJsonlOcPath as appendJsonlLine, setJsonlOcPath } from "./jsonl/edit.js";
import { emitJsonl } from "./jsonl/emit.js";
import { resolveJsonlOcPath } from "./jsonl/resolve.js";
import type { OcPath } from "./oc-path.js";
import {
  formatOcPath,
  hasWildcard,
  isQuotedSeg,
  OcPathError,
  splitRespectingBrackets,
  unquoteSeg,
} from "./oc-path.js";
import { resolveMdOcPath } from "./resolve.js";

// ---------- Public types ---------------------------------------------------

/** Tagged-union of every AST kind the substrate supports. */
export type OcAst = MdAst | JsoncAst | JsonlAst;

/**
 * Universal resolve result — same shape across AST kinds. `leaf` values
 * are string-coerced (numbers/bools stringified deterministically).
 * `line` is 1-based; root/synthetic nodes use `1`.
 */
export type OcMatch =
  | { readonly kind: "root"; readonly ast: OcAst; readonly line: number }
  | {
      readonly kind: "leaf";
      readonly valueText: string;
      readonly leafType: LeafType;
      readonly line: number;
    }
  | { readonly kind: "node"; readonly descriptor: NodeDescriptor; readonly line: number }
  | { readonly kind: "insertion-point"; readonly container: ContainerKind; readonly line: number };

export type LeafType = "string" | "number" | "boolean" | "null";

export type NodeDescriptor =
  | "md-block"
  | "md-item"
  | "jsonc-object"
  | "jsonc-array"
  | "jsonl-line";

export type ContainerKind =
  | "md-section" // append item to a section
  | "md-file" // append a section to the file
  | "md-frontmatter" // add a frontmatter key
  | "jsonc-object"
  | "jsonc-array"
  | "jsonl-file"; // append a line

export type SetResult =
  | { readonly ok: true; readonly ast: OcAst }
  | {
      readonly ok: false;
      readonly reason:
        | "unresolved"
        | "no-root"
        | "not-writable"
        | "no-item-kv"
        | "not-a-value-line"
        | "parse-error"
        | "type-mismatch"
        | "wildcard-not-allowed";
      readonly detail?: string;
    };

/**
 * Insertion marker on the deepest path segment: `+`, `+<key>`, or
 * `+<index>`. Returns parent path + marker; null for plain paths.
 */
export interface InsertionInfo {
  readonly parentPath: OcPath;
  readonly marker: "+" | { kind: "keyed"; key: string } | { kind: "indexed"; index: number };
}

export function detectInsertion(path: OcPath): InsertionInfo | null {
  const segments: Array<{ slot: "section" | "item" | "field"; value: string }> = [];
  if (path.section !== undefined) {segments.push({ slot: "section", value: path.section });}
  if (path.item !== undefined) {segments.push({ slot: "item", value: path.item });}
  if (path.field !== undefined) {segments.push({ slot: "field", value: path.field });}
  if (segments.length === 0) {return null;}

  const last = segments[segments.length - 1];
  if (!last.value.startsWith("+")) {return null;}

  const rest = last.value.slice(1);
  const marker: InsertionInfo["marker"] =
    rest.length === 0
      ? "+"
      : /^\d+$/.test(rest)
        ? { kind: "indexed", index: Number(rest) }
        : { kind: "keyed", key: rest };

  const parentPath: OcPath = {
    file: path.file,
    ...(last.slot !== "section" && path.section !== undefined ? { section: path.section } : {}),
    ...(last.slot !== "item" && path.item !== undefined ? { item: path.item } : {}),
    ...(last.slot !== "field" && path.field !== undefined ? { field: path.field } : {}),
    ...(path.session !== undefined ? { session: path.session } : {}),
  };
  return { parentPath, marker };
}

/** Resolve an `OcPath` against any AST. Throws on wildcard patterns. */
export function resolveOcPath(ast: OcAst, path: OcPath): OcMatch | null {
  // Single-match verb: wildcards belong to findOcPaths. Throw with a
  // structured code so consumers can route to the right verb.
  if (hasWildcard(path)) {
    throw new OcPathError(
      `resolveOcPath received a wildcard pattern; use findOcPaths instead: ${formatOcPath(path)}`,
      formatOcPath(path),
      "OC_PATH_WILDCARD_IN_RESOLVE",
    );
  }
  const insertion = detectInsertion(path);
  if (insertion !== null) {return resolveInsertion(ast, insertion);}

  switch (ast.kind) {
    case "md":
      return resolveMdToUniversal(ast, path);
    case "jsonc":
      return resolveJsoncToUniversal(ast, path);
    case "jsonl":
      return resolveJsonlToUniversal(ast, path);
  }
  return null;
}

function resolveMdToUniversal(ast: MdAst, path: OcPath): OcMatch | null {
  const m = resolveMdOcPath(ast, path);
  if (m === null) {return null;}
  switch (m.kind) {
    case "root":
      return { kind: "root", ast, line: 1 };
    case "frontmatter":
      return { kind: "leaf", valueText: m.node.value, leafType: "string", line: m.node.line };
    case "block":
      return { kind: "node", descriptor: "md-block", line: m.node.line };
    case "item":
      return { kind: "node", descriptor: "md-item", line: m.node.line };
    case "item-field":
      return { kind: "leaf", valueText: m.value, leafType: "string", line: m.node.line };
  }
  return null;
}

function resolveJsoncToUniversal(ast: JsoncAst, path: OcPath): OcMatch | null {
  const m = resolveJsoncOcPath(ast, path);
  if (m === null) {return null;}
  if (m.kind === "root") {return { kind: "root", ast, line: 1 };}
  if (m.kind === "object-entry") {return jsoncValueToMatch(m.node.value, m.node.line);}
  return jsoncValueToMatch(m.node, m.node.line ?? 1);
}

function jsoncValueToMatch(value: JsoncValue, line: number): OcMatch {
  switch (value.kind) {
    case "object":
      return { kind: "node", descriptor: "jsonc-object", line };
    case "array":
      return { kind: "node", descriptor: "jsonc-array", line };
    case "string":
      return { kind: "leaf", valueText: value.value, leafType: "string", line };
    case "number":
      return { kind: "leaf", valueText: String(value.value), leafType: "number", line };
    case "boolean":
      return { kind: "leaf", valueText: String(value.value), leafType: "boolean", line };
    case "null":
      return { kind: "leaf", valueText: "null", leafType: "null", line };
  }
  return { kind: "leaf", valueText: "null", leafType: "null", line };
}

function resolveJsonlToUniversal(ast: JsonlAst, path: OcPath): OcMatch | null {
  const m = resolveJsonlOcPath(ast, path);
  if (m === null) {return null;}
  if (m.kind === "root") {return { kind: "root", ast, line: 1 };}
  if (m.kind === "line") {return { kind: "node", descriptor: "jsonl-line", line: m.node.line };}
  // Inside-line jsonc nodes always have line=1; use the JsonlLine's
  // file-level line instead since every inside-line node sits there.
  if (m.kind === "object-entry") {return jsoncValueToMatch(m.node.value, m.line);}
  return jsoncValueToMatch(m.node, m.line);
}

function resolveInsertion(ast: OcAst, info: InsertionInfo): OcMatch | null {
  switch (ast.kind) {
    case "md":
      return resolveMdInsertion(ast, info);
    case "jsonc":
      return resolveJsoncInsertion(ast, info);
    case "jsonl":
      return resolveJsonlInsertion(ast, info);
  }
  return null;
}

function resolveMdInsertion(ast: MdAst, info: InsertionInfo): OcMatch | null {
  const p = info.parentPath;
  if (p.section === undefined) {return { kind: "insertion-point", container: "md-file", line: 1 };}
  if (p.section === "[frontmatter]") {
    return { kind: "insertion-point", container: "md-frontmatter", line: 1 };
  }
  if (p.item === undefined && p.field === undefined) {
    const m = resolveMdOcPath(ast, p);
    if (m === null || m.kind !== "block") {return null;}
    return { kind: "insertion-point", container: "md-section", line: m.node.line };
  }
  return null;
}

function resolveJsoncInsertion(ast: JsoncAst, info: InsertionInfo): OcMatch | null {
  const m = resolveJsoncOcPath(ast, info.parentPath);
  if (m === null) {
    return null;
  }
  let containerNode: JsoncValue;
  if (m.kind === "root") {
    if (ast.root === null) {
      return null;
    }
    containerNode = ast.root;
  } else if (m.kind === "object-entry") {
    containerNode = m.node.value;
  } else {
    containerNode = m.node;
  }
  const line = containerNode.line ?? 1;
  if (containerNode.kind === "object") {
    return { kind: "insertion-point", container: "jsonc-object", line };
  }
  if (containerNode.kind === "array") {
    return { kind: "insertion-point", container: "jsonc-array", line };
  }
  return null;
}

function resolveJsonlInsertion(ast: JsonlAst, info: InsertionInfo): OcMatch | null {
  // jsonl insertion only makes sense at file level (`oc://FILE/+`).
  // Surfaced line is lastLine+1 so consumers render correctly.
  if (info.parentPath.section !== undefined) {return null;}
  const lastLine = ast.lines.length > 0 ? ast.lines[ast.lines.length - 1].line : 0;
  return { kind: "insertion-point", container: "jsonl-file", line: lastLine + 1 };
}

/**
 * Replace or insert at `path`. Coerces value at leaves based on the
 * existing AST shape; for insertion paths value is parsed as
 * kind-appropriate content (JSON for jsonc/jsonl; raw text for md).
 * Sentinel-guard violations throw `OcEmitSentinelError`.
 */
export function setOcPath(ast: OcAst, path: OcPath, value: string): SetResult {
  if (hasWildcard(path)) {
    return {
      ok: false,
      reason: "wildcard-not-allowed",
      detail: "setOcPath requires a concrete path; use findOcPaths to enumerate matches first",
    };
  }
  const insertion = detectInsertion(path);
  if (insertion !== null) {
    switch (ast.kind) {
      case "md":
        return setMdInsertion(ast, insertion, value);
      case "jsonc":
        return setJsoncInsertion(ast, insertion, value);
      case "jsonl":
        return setJsonlInsertion(ast, insertion, value);
    }
  }
  switch (ast.kind) {
    case "md": {
      const r = setMdOcPath(ast, path, value);
      return r.ok ? { ok: true, ast: r.ast } : { ok: false, reason: r.reason };
    }
    case "jsonc":
      return setStructuredLeaf(ast, path, value, resolveJsoncOcPath, setJsoncOcPath);
    case "jsonl":
      return setStructuredLeaf(ast, path, value, resolveJsonlOcPath, setJsonlOcPath, () => {
        // jsonl line replacement: value must be JSON for the whole line.
        const parsed = tryParseJson(value);
        if (parsed === undefined) {
          return { ok: false, reason: "parse-error", detail: "line replacement requires JSON value" };
        }
        const r = setJsonlOcPath(ast, path, jsonToJsoncValue(parsed));
        return r.ok ? { ok: true, ast: r.ast } : { ok: false, reason: r.reason };
      });
  }
  return { ok: false, reason: "not-writable" };
}

// Resolve → reject root/line → coerce by existing leaf type → set →
// wrap. The optional `onLine` handles jsonl's whole-line replacement.
function setStructuredLeaf<A extends OcAst>(
  ast: A,
  path: OcPath,
  value: string,
  resolve: (a: A, p: OcPath) => StructuredLeafMatch | null,
  set: (a: A, p: OcPath, c: JsoncValue) => SetOpResult<A>,
  onLine?: () => SetResult,
): SetResult {
  const existing = resolve(ast, path);
  if (existing === null) {return { ok: false, reason: "unresolved" };}
  if (existing.kind === "root") {
    return { ok: false, reason: "not-writable", detail: "root replacement is not supported via setOcPath" };
  }
  if (existing.kind === "line") {
    return onLine !== undefined ? onLine() : { ok: false, reason: "not-writable" };
  }
  const leafValue = existing.kind === "object-entry" ? existing.node.value : existing.node;
  const coerced = coerceJsoncLeaf(value, leafValue);
  if (coerced === null) {
    return { ok: false, reason: "parse-error", detail: `cannot coerce "${value}" to ${leafValue.kind}` };
  }
  const r = set(ast, path, coerced);
  return r.ok ? { ok: true, ast: r.ast } : { ok: false, reason: r.reason };
}

type StructuredLeafMatch =
  | { readonly kind: "root" }
  | { readonly kind: "line" }
  | { readonly kind: "object-entry"; readonly node: { readonly value: JsoncValue } }
  | { readonly kind: "value"; readonly node: JsoncValue };

type SetFailureReason = Extract<SetResult, { ok: false }>["reason"];
type SetOpResult<A> =
  | { readonly ok: true; readonly ast: A }
  | { readonly ok: false; readonly reason: Exclude<SetFailureReason, "wildcard-not-allowed"> };

function setMdInsertion(ast: MdAst, info: InsertionInfo, value: string): SetResult {
  const p = info.parentPath;
  // file-level: append a section. Value is the heading text; body empty.
  if (p.section === undefined) {
    if (info.marker !== "+") {
      return { ok: false, reason: "not-writable", detail: "md file-level insertion uses bare `+`" };
    }
    const newAst: MdAst = {
      ...ast,
      blocks: [
        ...ast.blocks,
        {
          heading: value,
          slug: slugifyHeading(value),
          line: 0,
          bodyText: "",
          items: [],
        },
      ],
    };
    return { ok: true, ast: rebuildMdRaw(newAst) };
  }

  // [frontmatter] — keyed insertion only
  if (p.section === "[frontmatter]") {
    if (typeof info.marker !== "object" || info.marker.kind !== "keyed") {
      return {
        ok: false,
        reason: "not-writable",
        detail: "md frontmatter insertion requires +key",
      };
    }
    const key = info.marker.key;
    if (ast.frontmatter.some((e) => e.key === key)) {
      return {
        ok: false,
        reason: "type-mismatch",
        detail: `frontmatter key '${key}' already exists; use set, not insert`,
      };
    }
    const newAst: MdAst = {
      ...ast,
      frontmatter: [...ast.frontmatter, { key, value, line: 0 }],
    };
    return { ok: true, ast: rebuildMdRaw(newAst) };
  }

  // section-level: append item. Value can be `key: value` (kv) or plain text.
  if (p.item === undefined && p.field === undefined) {
    if (info.marker !== "+") {
      return { ok: false, reason: "not-writable", detail: "md section insertion uses bare `+`" };
    }
    const blockIdx = ast.blocks.findIndex((b) => b.slug === p.section!.toLowerCase());
    if (blockIdx === -1) {
      return { ok: false, reason: "unresolved" };
    }
    const block = ast.blocks[blockIdx];
    const kvMatch = /^([^:]+?)\s*:\s*(.+)$/.exec(value);
    const itemLine = `- ${value}`;
    const newItem = {
      text: value,
      slug: slugifyHeading(kvMatch ? kvMatch[1] : value),
      line: 0,
      ...(kvMatch !== null ? { kv: { key: kvMatch[1].trim(), value: kvMatch[2].trim() } } : {}),
    };
    const newBodyText =
      block.bodyText.length === 0 ? itemLine : block.bodyText.replace(/\n*$/, "\n") + itemLine;
    const newBlocks = ast.blocks.slice();
    newBlocks[blockIdx] = {
      ...block,
      items: [...block.items, newItem],
      bodyText: newBodyText,
    };
    return { ok: true, ast: rebuildMdRaw({ ...ast, blocks: newBlocks }) };
  }

  return { ok: false, reason: "not-writable" };
}

function setJsoncInsertion(ast: JsoncAst, info: InsertionInfo, value: string): SetResult {
  const containerMatch = resolveJsoncInsertion(ast, info);
  if (containerMatch === null) {
    return { ok: false, reason: "unresolved" };
  }

  const parsed = tryParseJson(value);
  if (parsed === undefined) {
    return { ok: false, reason: "parse-error", detail: "jsonc insertion requires JSON value" };
  }
  const newJsoncValue = jsonToJsoncValue(parsed);

  if (containerMatch.kind !== "insertion-point") {
    return { ok: false, reason: "unresolved" };
  }

  if (containerMatch.container === "jsonc-array") {
    // `+0` indexed; bare `+` appends; `+key` rejected for arrays.
    if (typeof info.marker === "object" && info.marker.kind === "keyed") {
      return { ok: false, reason: "type-mismatch", detail: "cannot insert by key into array" };
    }
    return mutateJsoncContainer(ast, info.parentPath, (container) => {
      if (container.kind !== "array") {return null;}
      const items = container.items.slice();
      if (info.marker === "+") {items.push(newJsoncValue);}
      else if (typeof info.marker === "object" && info.marker.kind === "indexed") {
        const idx = Math.min(info.marker.index, items.length);
        items.splice(idx, 0, newJsoncValue);
      }
      return {
        kind: "array",
        items,
        ...(container.line !== undefined ? { line: container.line } : {}),
      };
    });
  }

  if (typeof info.marker !== "object" || info.marker.kind !== "keyed") {
    return { ok: false, reason: "type-mismatch", detail: "jsonc object insertion requires +key" };
  }
  const key = info.marker.key;
  return mutateJsoncContainer(ast, info.parentPath, (container) => {
    if (container.kind !== "object") {return null;}
    if (container.entries.some((e) => e.key === key)) {return null;} // duplicate
    const newEntry: JsoncEntry = { key, value: newJsoncValue, line: 0 };
    return {
      kind: "object",
      entries: [...container.entries, newEntry],
      ...(container.line !== undefined ? { line: container.line } : {}),
    };
  });
}

function setJsonlInsertion(ast: JsonlAst, info: InsertionInfo, value: string): SetResult {
  if (info.parentPath.section !== undefined || info.marker !== "+") {
    return {
      ok: false,
      reason: "not-writable",
      detail: "jsonl insertion only supports oc://FILE/+ append",
    };
  }
  const parsed = tryParseJson(value);
  if (parsed === undefined) {
    return { ok: false, reason: "parse-error", detail: "jsonl line append requires JSON value" };
  }
  return { ok: true, ast: appendJsonlLine(ast, jsonToJsoncValue(parsed)) };
}

// Preserve the existing source line on coerced replacements — same
// semantic node, only the bytes change.
function coerceJsoncLeaf(valueText: string, existing: JsoncValue): JsoncValue | null {
  const lineExt = existing.line !== undefined ? { line: existing.line } : {};
  if (existing.kind === "string") {return { kind: "string", value: valueText, ...lineExt };}
  if (existing.kind === "number") {
    const n = Number(valueText);
    return Number.isFinite(n) ? { kind: "number", value: n, ...lineExt } : null;
  }
  if (existing.kind === "boolean") {
    if (valueText === "true") {return { kind: "boolean", value: true, ...lineExt };}
    if (valueText === "false") {return { kind: "boolean", value: false, ...lineExt };}
    return null;
  }
  if (existing.kind === "null") {
    return valueText === "null" ? { kind: "null", ...lineExt } : null;
  }
  // Object/array — caller should use insertion or full-replace.
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
  // Synthetic values omit `line` — only the parser sets line metadata.
  if (v === null) {return { kind: "null" };}
  if (typeof v === "string") {return { kind: "string", value: v };}
  if (typeof v === "number") {return { kind: "number", value: v };}
  if (typeof v === "boolean") {return { kind: "boolean", value: v };}
  if (Array.isArray(v)) {
    return { kind: "array", items: v.map(jsonToJsoncValue) };
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return {
      kind: "object",
      entries: Object.entries(obj).map(([key, value]) => ({
        key,
        value: jsonToJsoncValue(value),
        line: 0,
      })),
    };
  }
  // JSON.parse never produces undefined / function / symbol.
  throw new Error(`unsupported JSON value type: ${typeof v}`);
}

function mutateJsoncContainer(
  ast: JsoncAst,
  parentPath: OcPath,
  mutate: (container: JsoncValue) => JsoncValue | null,
): SetResult {
  if (ast.root === null) {return { ok: false, reason: "no-root" };}

  // Quote-aware split so insertion under a key with `/`/`.`/etc. works.
  const segments: string[] = [];
  if (parentPath.section !== undefined) {
    segments.push(...splitRespectingBrackets(parentPath.section, "."));
  }
  if (parentPath.item !== undefined) {
    segments.push(...splitRespectingBrackets(parentPath.item, "."));
  }
  if (parentPath.field !== undefined) {
    segments.push(...splitRespectingBrackets(parentPath.field, "."));
  }

  const newRoot =
    segments.length === 0 ? mutate(ast.root) : mutateAt(ast.root, segments, 0, mutate);
  if (newRoot === null) {return { ok: false, reason: "unresolved" };}

  const next: JsoncAst = { kind: "jsonc", raw: "", root: newRoot };
  return { ok: true, ast: { ...next, raw: emitJsonc(next, { mode: "render" }) } };
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

  if (current.kind === "object") {
    // AST keys are unquoted; strip quotes from the path segment.
    const lookupKey = isQuotedSeg(seg) ? unquoteSeg(seg) : seg;
    const idx = current.entries.findIndex((e) => e.key === lookupKey);
    if (idx === -1) {return null;}
    const child = current.entries[idx];
    const replaced = mutateAt(child.value, segments, i + 1, mutate);
    if (replaced === null) {return null;}
    const newEntries = current.entries.slice();
    newEntries[idx] = { ...child, value: replaced };
    return {
      kind: "object",
      entries: newEntries,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }
  if (current.kind === "array") {
    const idx = Number(seg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) {return null;}
    const child = current.items[idx];
    const replaced = mutateAt(child, segments, i + 1, mutate);
    if (replaced === null) {return null;}
    const newItems = current.items.slice();
    newItems[idx] = replaced;
    return {
      kind: "array",
      items: newItems,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }
  return null;
}

function rebuildMdRaw(ast: MdAst): MdAst {
  const parts: string[] = [];
  if (ast.frontmatter.length > 0) {
    parts.push("---");
    for (const fm of ast.frontmatter) {
      parts.push(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
    }
    parts.push("---");
  }
  if (ast.preamble.length > 0) {
    if (parts.length > 0) {parts.push("");}
    parts.push(ast.preamble);
  }
  for (const block of ast.blocks) {
    if (parts.length > 0) {parts.push("");}
    parts.push(`## ${block.heading}`);
    if (block.bodyText.length > 0) {parts.push(block.bodyText);}
  }
  void emitJsonl;
  return { ...ast, raw: parts.join("\n") };
}

function formatFrontmatterValue(value: string): string {
  if (value.length === 0) {return '""';}
  if (/[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)) {return JSON.stringify(value);}
  return value;
}

function slugifyHeading(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
