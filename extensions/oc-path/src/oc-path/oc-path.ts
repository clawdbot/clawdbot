/**
 * `oc://` path syntax — universal addressing for the OpenClaw workspace.
 *
 *     oc://{file}[/{section}[/{item}[/{field}]]][?session={id}]
 *
 * Canonical round-trip contract: `formatOcPath(parseOcPath(s)) === s`
 * for canonical paths. Extra query parameters are ignored except for
 * the first non-empty `session=` value.
 *
 * @module @openclaw/oc-path/oc-path
 */

import { OcEmitSentinelError, REDACTED_SENTINEL } from "./sentinel.js";

const OC_SCHEME = "oc://";

// Hard caps bound resource use under pathological / hostile input.
export const MAX_PATH_LENGTH = 4096;
export const MAX_SUB_SEGMENTS_PER_SLOT = 64;
export const MAX_TRAVERSAL_DEPTH = 256;

const BOM = "﻿";

// Walk by char code rather than regex — the no-control-regex lint rule
// rejects character classes covering U+0000–U+001F + U+007F.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) {
      return true;
    }
  }
  return false;
}

const RESERVED_CHARS_RE = /[?&%]/;

/** Render with `\xNN` escapes so error output is readable for invisible chars. */
function printable(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) {
      out += `\\x${cc.toString(16).padStart(2, "0")}`;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Parsed `oc://` path. Components nest strictly: `item` implies
 * `section`, `field` implies `item`. `field` directly under file
 * addresses a frontmatter key; under item it addresses the value of a
 * `- key: value` bullet. `session` is an opaque raw scope string; it is
 * not percent-decoded and cannot contain control characters or reserved
 * query delimiters (`?`, `&`, `%`).
 */
export interface OcPath {
  readonly file: string;
  readonly section?: string;
  readonly item?: string;
  readonly field?: string;
  readonly session?: string;
}

/** `code` is the stable machine-readable tag; consumers match on `code`, not `message`. */
export class OcPathError extends Error {
  readonly code: string;
  readonly input: string;

  constructor(message: string, input: string, code: string) {
    super(message);
    this.name = "OcPathError";
    this.input = input;
    this.code = code;
  }
}

function fail(message: string, input: string, code: string): never {
  throw new OcPathError(message, input, code);
}

// Reject absolute paths, parent-dir escapes, and control chars at every
// entry point so a hostile struct can't smuggle a filesystem traversal.
function validateFileSlot(file: string, contextInput: string): void {
  if (file.startsWith("/") || file.startsWith("\\") || /^[a-zA-Z]:/.test(file)) {
    fail(
      `Absolute file slot not allowed (oc:// paths are workspace-relative): ${printable(contextInput)}`,
      contextInput,
      "OC_PATH_ABSOLUTE_FILE",
    );
  }
  if (file.split(/[\\/]/).some((seg) => seg === "..")) {
    fail(
      `Parent-directory segment ('..') not allowed in oc:// file slot: ${printable(contextInput)}`,
      contextInput,
      "OC_PATH_PARENT_TRAVERSAL",
    );
  }
  if (hasControlChar(file)) {
    fail(
      `Control character in oc:// file slot: ${printable(contextInput)}`,
      contextInput,
      "OC_PATH_CONTROL_CHAR",
    );
  }
}

function validateSessionSlot(session: string, contextInput: string): void {
  if (hasControlChar(session)) {
    fail(
      `Control character in oc:// session query: ${printable(contextInput)}`,
      contextInput,
      "OC_PATH_CONTROL_CHAR",
    );
  }
  if (RESERVED_CHARS_RE.test(session)) {
    fail(
      `Reserved character (\`?\` / \`&\` / \`%\`) in oc:// session query: ${printable(contextInput)}`,
      contextInput,
      "OC_PATH_RESERVED_CHAR",
    );
  }
}

/** Parse an `oc://` path string into a structured `OcPath`. */
export function parseOcPath(input: string): OcPath {
  if (typeof input !== "string") {
    fail("oc:// path must be a string", String(input), "OC_PATH_NOT_STRING");
  }

  if (input.length > MAX_PATH_LENGTH) {
    fail(
      `oc:// path exceeds ${MAX_PATH_LENGTH} bytes (length: ${input.length})`,
      input.slice(0, 80) + "…",
      "OC_PATH_TOO_LONG",
    );
  }

  // NFC normalization keeps cross-platform equality (macOS HFS+ NFD vs
  // Unix/Windows NFC). NFC can grow the string, so re-check the cap.
  let normalized = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  normalized = normalized.normalize("NFC");

  if (normalized.length > MAX_PATH_LENGTH) {
    fail(
      `oc:// path exceeds ${MAX_PATH_LENGTH} bytes after NFC (length: ${normalized.length})`,
      input.slice(0, 80) + "…",
      "OC_PATH_TOO_LONG",
    );
  }
  if (!normalized.startsWith(OC_SCHEME)) {
    fail(`Missing oc:// scheme: ${printable(input)}`, input, "OC_PATH_MISSING_SCHEME");
  }
  if (hasControlChar(normalized)) {
    fail(`Control character in oc:// path: ${printable(input)}`, input, "OC_PATH_CONTROL_CHAR");
  }

  const afterScheme = normalized.slice(OC_SCHEME.length);
  // Top-level split skips quoted keys so `"foo?bar"` isn't broken.
  const queryIndex = indexOfTopLevel(afterScheme, "?");
  const pathPart = queryIndex === -1 ? afterScheme : afterScheme.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? "" : afterScheme.slice(queryIndex + 1);

  if (pathPart.length === 0) {
    fail(`Empty oc:// path: ${printable(input)}`, input, "OC_PATH_EMPTY");
  }

  const segments = splitRespectingBrackets(pathPart, "/", input);
  for (const seg of segments) {
    if (seg.length === 0) {
      fail(`Empty segment in oc:// path: ${printable(input)}`, input, "OC_PATH_EMPTY_SEGMENT");
    }
  }
  if (segments.length > 4) {
    fail(`Too many segments in oc:// path (max 4): ${printable(input)}`, input, "OC_PATH_TOO_DEEP");
  }

  for (const seg of segments) {
    validateBrackets(seg, input);
    const subs = splitRespectingBrackets(seg, ".", input);
    if (subs.length > MAX_SUB_SEGMENTS_PER_SLOT) {
      fail(
        `Sub-segment count exceeds ${MAX_SUB_SEGMENTS_PER_SLOT} in segment "${seg}": ${printable(input)}`,
        input,
        "OC_PATH_TOO_DEEP",
      );
    }
    for (const sub of subs) {
      validateSubSegment(sub, input);
    }
  }

  // Unquote the file slot — splitRespectingBrackets keeps a quoted file
  // segment intact so its `/` isn't a slot separator; strip the quotes
  // so consumers see the literal filename.
  const fileSeg = segments[0];
  const file = isQuotedSeg(fileSeg) ? unquoteSeg(fileSeg) : fileSeg;
  validateFileSlot(file, input);

  const session = extractSession(queryPart, input);
  return {
    file,
    ...(segments[1] !== undefined ? { section: segments[1] } : {}),
    ...(segments[2] !== undefined ? { item: segments[2] } : {}),
    ...(segments[3] !== undefined ? { field: segments[3] } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}

/** Format an `OcPath` struct into its canonical string form. */
export function formatOcPath(path: OcPath): string {
  if (!path.file || path.file.length === 0) {
    fail("oc:// path requires a file", "", "OC_PATH_FILE_REQUIRED");
  }
  validateFileSlot(path.file, path.file);
  if (path.item !== undefined && path.section === undefined) {
    fail("Structural nesting violation: item requires section", path.file, "OC_PATH_NESTING");
  }
  if (path.field !== undefined && path.item === undefined) {
    fail("Structural nesting violation: field requires item", path.file, "OC_PATH_NESTING");
  }

  // Round-trip requires raw sub-segments to be quoted before
  // concatenation, OR passed through if already in structural form
  // (quoted, predicate, union, sentinel). Plain concatenation would
  // silently split a raw `foo/bar` slot into two segments at parse.
  const formatSubSegment = (sub: string): string => {
    if (isQuotedSeg(sub)) {
      return sub;
    }
    if (sub.startsWith("[") && sub.endsWith("]")) {
      return sub;
    }
    if (sub.startsWith("{") && sub.endsWith("}")) {
      return sub;
    }
    return quoteSeg(sub);
  };
  const validateSubForFormat = (sub: string, slotName: string): void => {
    if (sub.length === 0) {
      fail(
        `Empty dotted sub-segment in OcPath.${slotName}`,
        path.file,
        "OC_PATH_EMPTY_SUB_SEGMENT",
      );
    }
    if (hasControlChar(sub)) {
      fail(
        `Control character in OcPath.${slotName} sub-segment "${printable(sub)}"`,
        path.file,
        "OC_PATH_CONTROL_CHAR",
      );
    }
  };
  const formatSlot = (slot: string, slotName: string): string => {
    const subs = splitRespectingBrackets(slot, ".");
    for (const sub of subs) {
      validateSubForFormat(sub, slotName);
    }
    return subs.map(formatSubSegment).join(".");
  };

  // File slot uses lighter quoting than section/item/field: dots are
  // normal in filenames (`AGENTS.md`); only quote when the file
  // contains chars that would parse as structure (primarily `/`).
  const fileNeedsQuote = /[/[\]{}?&%"\s]/.test(path.file);
  const formattedFile = fileNeedsQuote ? quoteSeg(path.file) : path.file;
  let out = OC_SCHEME + formattedFile;
  if (path.section !== undefined) {
    out += "/" + formatSlot(path.section, "section");
  }
  if (path.item !== undefined) {
    out += "/" + formatSlot(path.item, "item");
  }
  if (path.field !== undefined) {
    out += "/" + formatSlot(path.field, "field");
  }
  if (path.session !== undefined) {
    validateSessionSlot(path.session, path.file);
    out += "?session=" + path.session;
  }

  if (out.length > MAX_PATH_LENGTH) {
    fail(
      `Formatted oc:// exceeds ${MAX_PATH_LENGTH} bytes (length: ${out.length})`,
      out.slice(0, 80) + "…",
      "OC_PATH_TOO_LONG",
    );
  }
  // Path strings flow into telemetry / audit / error messages — refuse
  // the redaction sentinel here so it can't slip past consumers.
  if (out.includes(REDACTED_SENTINEL)) {
    throw new OcEmitSentinelError(out);
  }
  return out;
}

/** True iff `input` is a string `parseOcPath` would accept. */
export function isValidOcPath(input: unknown): input is string {
  if (typeof input !== "string") {
    return false;
  }
  try {
    parseOcPath(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Positional tokens: `$first` / `$last` resolve to the first / last
 * index or declared key. They pick exactly one element, so they don't
 * trigger wildcard guards.
 */
export const POS_FIRST = "$first";
export const POS_LAST = "$last";

export function isPositionalSeg(seg: string): boolean {
  return seg === POS_FIRST || seg === POS_LAST;
}

/**
 * Ordinal addressing — `#N` targets the Nth item by document order.
 * Earns its keep on slug-addressed kinds (md items can share a slug
 * via `- foo: a` / `- foo: b`); `#0`/`#1` distinguish them.
 */
export function isOrdinalSeg(seg: string): boolean {
  return /^#\d+$/.test(seg);
}

export function parseOrdinalSeg(seg: string): number | null {
  const m = /^#(\d+)$/.exec(seg);
  return m === null || m[1] === undefined ? null : Number(m[1]);
}

/** Indexable containers provide `size`; keyed containers provide ordered `keys`. */
export interface PositionalContainer {
  readonly indexable: boolean;
  readonly size: number;
  readonly keys?: readonly string[];
}

// Resolve `$first` / `$last` against a container; null when empty.
export function resolvePositionalSeg(seg: string, container: PositionalContainer): string | null {
  if (container.size === 0) {
    return null;
  }
  if (seg === POS_FIRST) {
    if (!container.indexable) {
      return container.keys?.[0] ?? null;
    }
    return "0";
  }
  if (seg === POS_LAST) {
    if (!container.indexable) {
      return container.keys?.[container.keys.length - 1] ?? null;
    }
    return String(container.size - 1);
  }
  return null;
}

/**
 * Wildcard tokens permitted in `findOcPaths` patterns.
 * `*` matches one sub-segment; `**` matches zero or more (recursive).
 * Reject in resolve/set via `hasWildcard`.
 */
export const WILDCARD_SINGLE = "*";
export const WILDCARD_RECURSIVE = "**";

/**
 * True iff any sub-segment is a multi-match pattern (`*`, `**`,
 * union `{a,b,c}`, or predicate `[k=v]`). Single-match verbs reject
 * these; only `findOcPaths` consumes them.
 */
export function isPattern(path: OcPath): boolean {
  for (const slot of [path.section, path.item, path.field]) {
    if (slot === undefined) {
      continue;
    }
    // Quote-aware split — `slot.split('.')` would shred quoted keys
    // containing literal `*` and falsely flag them as wildcards.
    for (const sub of splitRespectingBrackets(slot, ".")) {
      if (sub === WILDCARD_SINGLE || sub === WILDCARD_RECURSIVE) {
        return true;
      }
      if (isUnionSeg(sub)) {
        return true;
      }
      if (isPredicateSeg(sub)) {
        return true;
      }
    }
  }
  return false;
}

/** @deprecated v1 — use {@link isPattern}. Behaviorally identical. */
export const hasWildcard = isPattern;

/** Union segment `{a,b,c}` matches each comma-separated alternative. */
export function isUnionSeg(seg: string): boolean {
  return seg.length >= 2 && seg.startsWith("{") && seg.endsWith("}");
}

export function parseUnionSeg(seg: string): readonly string[] | null {
  if (!isUnionSeg(seg)) {
    return null;
  }
  const inner = seg.slice(1, -1);
  if (inner.length === 0) {
    return null;
  }
  const alts = inner.split(",");
  if (alts.some((a) => a.length === 0)) {
    return null;
  }
  return alts;
}

/**
 * Value predicate `[key<op>value]`. Operators: `=` `!=` (string),
 * `<` `<=` `>` `>=` (numeric). Multi-char tried before single-char.
 */
export type PredicateOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

const PREDICATE_OPS: readonly PredicateOp[] = ["!=", "<=", ">=", "<", ">", "="];

export function isPredicateSeg(seg: string): boolean {
  if (seg.length < 4 || !seg.startsWith("[") || !seg.endsWith("]")) {
    return false;
  }
  const inner = new Set(seg.slice(1, -1));
  return PREDICATE_OPS.some((op) => inner.has(op));
}

export interface PredicateSpec {
  readonly key: string;
  readonly op: PredicateOp;
  readonly value: string;
}

export function parsePredicateSeg(seg: string): PredicateSpec | null {
  if (seg.length < 4 || !seg.startsWith("[") || !seg.endsWith("]")) {
    return null;
  }
  const inner = seg.slice(1, -1);
  // Leftmost operator wins; at each position, multi-char beats single
  // (so `[a<=b]` parses as op=`<=`, not op=`<`).
  for (let i = 1; i < inner.length; i++) {
    for (const op of PREDICATE_OPS) {
      if (!inner.startsWith(op, i)) {
        continue;
      }
      if (i + op.length >= inner.length) {
        continue;
      } // empty value
      return { key: inner.slice(0, i), op, value: inner.slice(i + op.length) };
    }
  }
  return null;
}

// Numeric ops require both sides to coerce to finite numbers.
export function evaluatePredicate(actual: string | null, pred: PredicateSpec): boolean {
  if (actual === null) {
    return false;
  }
  switch (pred.op) {
    case "=":
      return actual === pred.value;
    case "!=":
      return actual !== pred.value;
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const a = Number(actual);
      const b = Number(pred.value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return false;
      }
      if (pred.op === "<") {
        return a < b;
      }
      if (pred.op === "<=") {
        return a <= b;
      }
      if (pred.op === ">") {
        return a > b;
      }
      return a >= b;
    }
  }
  return false;
}

/**
 * Flatten the path into a concrete sub-segment list plus slot offsets,
 * so a caller can reconstruct an `OcPath` from a concrete walk by
 * re-packing sub-segments back into their original slots.
 */
export interface PathSegmentLayout {
  readonly subs: readonly string[];
  readonly sectionLen: number;
  readonly itemLen: number;
  readonly fieldLen: number;
}

export function getPathLayout(path: OcPath): PathSegmentLayout {
  // Quote-aware split — `.split('.')` would shred a quoted segment
  // containing a literal `.` (e.g. `"a.b"`) and break repackPath.
  const sectionSubs = path.section === undefined ? [] : splitRespectingBrackets(path.section, ".");
  const itemSubs = path.item === undefined ? [] : splitRespectingBrackets(path.item, ".");
  const fieldSubs = path.field === undefined ? [] : splitRespectingBrackets(path.field, ".");
  return {
    subs: [...sectionSubs, ...itemSubs, ...fieldSubs],
    sectionLen: sectionSubs.length,
    itemLen: itemSubs.length,
    fieldLen: fieldSubs.length,
  };
}

/**
 * Re-pack a concrete sub-segment list into an `OcPath` preserving the
 * pattern's slot boundaries. Throws on length mismatch.
 */
export function repackPath(pattern: OcPath, subs: readonly string[]): OcPath {
  const layout = getPathLayout(pattern);
  if (subs.length !== layout.subs.length) {
    fail(
      `repack length mismatch: pattern has ${layout.subs.length} sub-segments, got ${subs.length}`,
      formatOcPath(pattern),
      "OC_PATH_REPACK_LENGTH",
    );
  }
  const sectionSubs = subs.slice(0, layout.sectionLen);
  const itemSubs = subs.slice(layout.sectionLen, layout.sectionLen + layout.itemLen);
  const fieldSubs = subs.slice(layout.sectionLen + layout.itemLen);
  return {
    file: pattern.file,
    ...(sectionSubs.length > 0 ? { section: sectionSubs.join(".") } : {}),
    ...(itemSubs.length > 0 ? { item: itemSubs.join(".") } : {}),
    ...(fieldSubs.length > 0 ? { field: fieldSubs.join(".") } : {}),
    ...(pattern.session !== undefined ? { session: pattern.session } : {}),
  };
}

function extractSession(queryPart: string, input: string): string | undefined {
  if (queryPart.length === 0) {
    return undefined;
  }
  for (const pair of queryPart.split("&")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = pair.slice(0, eqIndex);
    const value = pair.slice(eqIndex + 1);
    if (key === "session" && value.length > 0) {
      validateSessionSlot(value, input);
      return value;
    }
  }
  return undefined;
}

// Walk `s` respecting `[...]`/`{...}`/`"..."` regions. Quoted regions
// are byte-literal. `onChar` returns "stop" to short-circuit;
// `onUnbalanced` (must throw) fires on bracket/brace/quote imbalance.
type ScanCallback = (c: string, i: number, atTop: boolean) => "stop" | void;
function scanBracketAware(s: string, onChar: ScanCallback, onUnbalanced: () => never): void {
  let depthBracket = 0;
  let depthBrace = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '"') {
        inQuote = false;
      }
      if (onChar(c, i, false) === "stop") {
        return;
      }
      continue;
    }
    if (c === '"') {
      inQuote = true;
      if (onChar(c, i, false) === "stop") {
        return;
      }
      continue;
    }
    if (c === "[") {
      depthBracket++;
    } else if (c === "]") {
      depthBracket--;
    } else if (c === "{") {
      depthBrace++;
    } else if (c === "}") {
      depthBrace--;
    }
    if (depthBracket < 0 || depthBrace < 0) {
      onUnbalanced();
    }
    if (onChar(c, i, depthBracket === 0 && depthBrace === 0) === "stop") {
      return;
    }
  }
  if (depthBracket !== 0 || depthBrace !== 0 || inQuote) {
    onUnbalanced();
  }
}

/** First top-level occurrence of `ch` in `s`; -1 when absent. */
export function indexOfTopLevel(s: string, ch: string): number {
  let result = -1;
  const fail = (): never => {
    throw new OcPathError(`Unbalanced bracket/brace in oc:// path: ${s}`, s, "OC_PATH_UNBALANCED");
  };
  scanBracketAware(
    s,
    (c, i, atTop) => {
      if (atTop && c === ch) {
        result = i;
        return "stop";
      }
      return undefined;
    },
    fail,
  );
  return result;
}

export function splitRespectingBrackets(
  s: string,
  delim: string,
  originalInput?: string,
): string[] {
  const out: string[] = [];
  let buf = "";
  const ctx = originalInput ?? s;
  const onUnbalanced = (): never => {
    fail(`Unbalanced bracket/brace in oc:// path: ${ctx}`, ctx, "OC_PATH_UNBALANCED");
  };
  scanBracketAware(
    s,
    (c, _i, atTop) => {
      if (atTop && c === delim) {
        out.push(buf);
        buf = "";
        return;
      }
      buf += c;
    },
    onUnbalanced,
  );
  out.push(buf);
  return out;
}

/** True iff `seg` is `"..."`. */
export function isQuotedSeg(seg: string): boolean {
  return seg.length >= 2 && seg.startsWith('"') && seg.endsWith('"');
}

/** Strip surrounding quotes. Content is byte-literal. */
export function unquoteSeg(seg: string): string {
  return isQuotedSeg(seg) ? seg.slice(1, -1) : seg;
}

// Refuses values with `"` or `\` — no escape mechanism.
export function quoteSeg(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (value.includes('"') || value.includes("\\")) {
    fail(
      `Cannot quote value containing '"' or '\\\\': ${printable(value)}`,
      value,
      "OC_PATH_UNQUOTABLE",
    );
  }
  return /[/.[\]{}?&%\s]/.test(value) ? `"${value}"` : value;
}

// Defense-in-depth — the splitter validates segments it splits; this
// catches stray unmatched brackets in unsplit ones.
function validateBrackets(seg: string, input: string): void {
  scanBracketAware(
    seg,
    () => undefined,
    () => {
      fail(
        `Unbalanced bracket/brace in segment "${seg}": ${printable(input)}`,
        input,
        "OC_PATH_UNBALANCED",
      );
    },
  );
}

function validateSubSegment(sub: string, input: string): void {
  if (sub.length === 0) {
    fail(
      `Empty dotted sub-segment in oc:// path: ${printable(input)}`,
      input,
      "OC_PATH_EMPTY_SUB_SEGMENT",
    );
  }
  if (hasControlChar(sub)) {
    fail(
      `Control character in oc:// segment "${printable(sub)}": ${printable(input)}`,
      input,
      "OC_PATH_CONTROL_CHAR",
    );
  }
  // Quoted content is byte-literal but can't contain `"` or `\`.
  if (isQuotedSeg(sub)) {
    const inner = new Set(sub.slice(1, -1));
    if (inner.has('"') || inner.has("\\")) {
      fail(
        `Quoted segment cannot contain '"' or '\\\\': ${printable(sub)}`,
        input,
        "OC_PATH_UNQUOTABLE",
      );
    }
    return;
  }

  // Reserved characters used by the path grammar itself (`?`/`&`/`%`).
  // Allowed inside predicate / union segments — those are content.
  if (!sub.startsWith("[") && !sub.startsWith("{")) {
    if (RESERVED_CHARS_RE.test(sub)) {
      fail(
        `Reserved character (\`?\` / \`&\` / \`%\`) in oc:// segment "${sub}": ${printable(input)}`,
        input,
        "OC_PATH_RESERVED_CHAR",
      );
    }
    if (sub !== sub.trim() || /\s/.test(sub)) {
      fail(
        `Whitespace in oc:// segment "${sub}": ${printable(input)}`,
        input,
        "OC_PATH_WHITESPACE",
      );
    }
  }
  // `[...]` is either a predicate `[k<op>v]` or a literal sentinel
  // (e.g. `[frontmatter]`). Mismatched brackets are rejected.
  const startsBracket = sub.startsWith("[");
  const endsBracket = sub.endsWith("]");
  if (startsBracket !== endsBracket) {
    fail(
      `Mismatched bracket in segment "${sub}": ${printable(input)}`,
      input,
      "OC_PATH_MALFORMED_PREDICATE",
    );
  }
  if (startsBracket && endsBracket) {
    const inner = sub.slice(1, -1);
    if (inner.length === 0) {
      fail(
        `Empty bracket segment "${sub}": ${printable(input)}`,
        input,
        "OC_PATH_MALFORMED_PREDICATE",
      );
    }
    const hasOp = ["!=", "<=", ">=", "<", ">", "="].some((op) => inner.includes(op));
    if (hasOp) {
      const parsed = parsePredicateSeg(sub);
      if (parsed === null || parsed.key.length === 0 || parsed.value.length === 0) {
        fail(
          `Malformed predicate "${sub}" — must be \`[key<op>value]\` with non-empty key and value: ${printable(input)}`,
          input,
          "OC_PATH_MALFORMED_PREDICATE",
        );
      }
    }
    // Op-less brackets are literal sentinel segments (back-compat).
  }
  const startsBrace = sub.startsWith("{");
  const endsBrace = sub.endsWith("}");
  if (startsBrace !== endsBrace) {
    fail(
      `Mismatched brace in segment "${sub}": ${printable(input)}`,
      input,
      "OC_PATH_MALFORMED_UNION",
    );
  }
  if (startsBrace && endsBrace) {
    const inner = sub.slice(1, -1);
    if (inner.length === 0) {
      fail(
        `Empty union "${sub}" — must contain at least one alternative: ${printable(input)}`,
        input,
        "OC_PATH_MALFORMED_UNION",
      );
    }
    if (inner.split(",").some((a) => a.length === 0)) {
      fail(
        `Empty alternative in union "${sub}": ${printable(input)}`,
        input,
        "OC_PATH_MALFORMED_UNION",
      );
    }
  }
}
