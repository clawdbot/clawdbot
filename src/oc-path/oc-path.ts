/**
 * `oc://` path syntax — universal addressing for the OpenClaw workspace.
 *
 * Canonical form:
 *
 *     oc://{file}[/{section}[/{item}[/{field}]]][?session={id}]
 *
 * Used in PatchError messages, audit events, governance warnings, lint
 * findings, doctor fixers, API error responses, SSE events, and editor
 * deep-links. No ad-hoc string paths anywhere — every path through the
 * serve layer flows through `parseOcPath` / `formatOcPath`.
 *
 * **Round-trip contract**: `formatOcPath(parseOcPath(s)) === s` for every
 * valid `s` produced by `formatOcPath`.
 *
 * @module @openclaw/oc-path/oc-path
 */

import { OcEmitSentinelError, REDACTED_SENTINEL } from './sentinel.js';

const OC_SCHEME = 'oc://';

/**
 * Hard caps to prevent pathological input from exhausting resources.
 *
 * `MAX_PATH_LENGTH` — input string length. 4 KiB is enough for any
 * realistic addressing use (deep nested workflows max out around 200
 * bytes). Anything larger is either user error or hostile input.
 *
 * `MAX_SUB_SEGMENTS_PER_SLOT` — dotted sub-segment count inside a
 * single slot. Real workspace addressing maxes around 10 levels.
 *
 * `MAX_TRAVERSAL_DEPTH` — used by find walkers to bound `**`
 * recursion. Real ASTs don't nest beyond ~50; 256 is a safe ceiling.
 */
export const MAX_PATH_LENGTH = 4096;
export const MAX_SUB_SEGMENTS_PER_SLOT = 64;
export const MAX_TRAVERSAL_DEPTH = 256;

/** UTF-8 BOM. Stripped from path strings before scheme check. */
const BOM = '﻿';

/**
 * True if the string contains any C0 control char (U+0000 — U+001F)
 * or DEL (U+007F). Walks by char code so we never embed literal
 * control bytes in source — the equivalent regex would put NUL/DEL
 * into this file, which lint and binary-detection tools flag.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Reserved characters that can't appear unencoded in path segments. */
const RESERVED_CHARS_RE = /[?&%]/;

/**
 * Render a string for inclusion in error messages — replaces control
 * chars with `\xNN` escapes so error output is readable even when the
 * offending input contains invisible characters.
 */
function printable(s: string): string {
  // Walk the string explicitly rather than using a control-char regex
  // — the no-control-regex lint rule rejects character classes that
  // contain bytes in U+0000–U+001F + U+007F, but that's exactly the
  // range we WANT to escape so error messages stay readable when
  // input contains invisible bytes. Manual loop sidesteps the rule.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) {
      out += `\\x${cc.toString(16).padStart(2, '0')}`;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Parsed `oc://` path. Components nest strictly: `item` implies
 * `section`, `field` implies `item`. Structural violations are rejected
 * by `formatOcPath`.
 *
 * Per the upstream pre-RFC, `field` addresses either a frontmatter key
 * (when used directly under a file with no section) OR the value of a
 * key/value bullet (`- key: value`) inside an item. The substrate
 * resolver dispatches based on what the path resolves to.
 */
export interface OcPath {
  /** Target file or virtual root (e.g. `SOUL.md`, `skills/email-drafter`). Always present. */
  readonly file: string;
  /** Optional H2 section within the file (e.g. `Boundaries`). */
  readonly section?: string;
  /** Optional item within a section (e.g. `deny-rule-1`). Requires `section`. */
  readonly item?: string;
  /** Optional field on an item or frontmatter (e.g. `risk`). Requires `item` for item-fields. */
  readonly field?: string;
  /** Optional session scope (e.g. `cron:daily`). Orthogonal to nesting. */
  readonly session?: string;
}

/**
 * Error thrown when an `oc://` path cannot be parsed or formatted.
 *
 * `code` is a stable, machine-readable tag; downstream consumers
 * (PatchError, audit events, error handlers) match on `code`, not on
 * `message`.
 */
export class OcPathError extends Error {
  readonly code: string;
  readonly input: string;

  constructor(message: string, input: string, code: string) {
    super(message);
    this.name = 'OcPathError';
    this.input = input;
    this.code = code;
  }
}

/**
 * Parse an `oc://` path string into a structured `OcPath`.
 *
 * Accepts the full syntax: file, optional section/item/field, optional
 * `?session=` query parameter. Unknown query parameters are silently
 * ignored.
 *
 * Throws `OcPathError` for missing scheme, empty file, or empty path
 * segments.
 */
export function parseOcPath(input: string): OcPath {
  if (typeof input !== 'string') {
    throw new OcPathError('oc:// path must be a string', String(input), 'OC_PATH_NOT_STRING');
  }

  // P-032 — hard cap on input length. Pathological inputs are rejected
  // before any further string ops so quadratic scans can't be triggered.
  // The pre-normalize check fails fast on absurd input (a 10 MB string
  // shouldn't even reach .normalize); the post-normalize check below
  // catches the corner case where NFC composition grows the string
  // past the cap (a few decomposed Hangul or combining-mark sequences
  // can exceed pre-normalize length).
  if (input.length > MAX_PATH_LENGTH) {
    throw new OcPathError(
      `oc:// path exceeds ${MAX_PATH_LENGTH} bytes (length: ${input.length})`,
      input.slice(0, 80) + '…',
      'OC_PATH_TOO_LONG',
    );
  }

  // P-001 — strip a leading UTF-8 BOM if present. The BOM is invisible
  // and confuses scheme detection; rejecting silently would surface as
  // a misleading "missing scheme" error.
  let normalized = input.startsWith(BOM) ? input.slice(BOM.length) : input;

  // P-002 — normalize to NFC. Different filesystems produce different
  // forms (macOS HFS+ historically NFD; web / Unix / Windows NFC). NFC
  // is the canonical form for cross-platform string equality.
  normalized = normalized.normalize('NFC');

  // Re-check the cap after NFC. NFC can grow a string (some Hangul
  // and combining-mark sequences); without this re-check the
  // documented invariant — "downstream loops iterate at most
  // MAX_PATH_LENGTH chars" — doesn't hold.
  if (normalized.length > MAX_PATH_LENGTH) {
    throw new OcPathError(
      `oc:// path exceeds ${MAX_PATH_LENGTH} bytes after NFC (length: ${normalized.length})`,
      input.slice(0, 80) + '…',
      'OC_PATH_TOO_LONG',
    );
  }

  if (!normalized.startsWith(OC_SCHEME)) {
    throw new OcPathError(`Missing oc:// scheme: ${printable(input)}`, input, 'OC_PATH_MISSING_SCHEME');
  }

  const afterScheme = normalized.slice(OC_SCHEME.length);
  // Find the query separator at the TOP level (outside brackets,
  // braces, and quotes). Plain `indexOf('?')` would treat a quoted
  // key like `"foo?bar"` as a query boundary, breaking advertised
  // quoted-segment support — closes the parser-quoted-query gap.
  const queryIndex = indexOfTopLevel(afterScheme, '?');
  const pathPart = queryIndex === -1 ? afterScheme : afterScheme.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? '' : afterScheme.slice(queryIndex + 1);

  if (pathPart.length === 0) {
    throw new OcPathError(`Empty oc:// path: ${printable(input)}`, input, 'OC_PATH_EMPTY');
  }

  const segments = splitRespectingBrackets(pathPart, '/', input);
  for (const seg of segments) {
    if (seg.length === 0) {
      throw new OcPathError(`Empty segment in oc:// path: ${printable(input)}`, input, 'OC_PATH_EMPTY_SEGMENT');
    }
  }

  if (segments.length > 4) {
    throw new OcPathError(
      `Too many segments in oc:// path (max 4): ${printable(input)}`,
      input,
      'OC_PATH_TOO_DEEP',
    );
  }

  // Validate every segment: bracket/brace shape, dotted sub-segments,
  // P-003 whitespace, P-004 control chars, P-026 reserved chars.
  for (const seg of segments) {
    validateBrackets(seg, input);
    const subs = splitRespectingBrackets(seg, '.', input);
    if (subs.length > MAX_SUB_SEGMENTS_PER_SLOT) {
      throw new OcPathError(
        `Sub-segment count exceeds ${MAX_SUB_SEGMENTS_PER_SLOT} in segment "${seg}": ${printable(input)}`,
        input,
        'OC_PATH_TOO_DEEP',
      );
    }
    for (const sub of subs) {
      validateSubSegment(sub, input);
    }
  }

  const session = extractSession(queryPart);

  // Unquote the file slot so `path.file` always carries the bare
  // filesystem path. `splitRespectingBrackets` keeps a quoted file
  // segment intact (`"skills/email-drafter"`) so the `/` inside it
  // isn't treated as a slot separator; here we strip the surrounding
  // quotes so consumers (CLI's `resolveFsPath`, find / resolve walkers)
  // see `skills/email-drafter` rather than `"skills/email-drafter"`.
  // Without this, the round-trip emits `oc://"skills/email-drafter"`
  // and the CLI tries to `fs.readFile` a literally-quoted filename.
  const fileSeg = segments[0];
  const file = isQuotedSeg(fileSeg) ? unquoteSeg(fileSeg) : fileSeg;

  // Containment — `oc://` paths address files **relative to the workspace
  // root**. Absolute paths and parent-directory escapes (`..`) would let a
  // hostile workflow / skill manifest persuade `openclaw path resolve|set
  // |emit` into reading or writing arbitrary filesystem locations. Reject
  // both before the path leaks into `resolveFsPath` (which would resolve
  // an absolute slot away from `cwd` per Node `path.resolve` semantics).
  // Quoted-segment unquoting (above) means `oc://".."/x` and
  // `oc://"../foo"/x` are caught by the same check.
  if (file.startsWith('/') || file.startsWith('\\') || /^[a-zA-Z]:/.test(file)) {
    throw new OcPathError(
      `Absolute file slot not allowed (oc:// paths are workspace-relative): ${printable(input)}`,
      input,
      'OC_PATH_ABSOLUTE_FILE',
    );
  }
  if (file.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new OcPathError(
      `Parent-directory segment ('..') not allowed in oc:// file slot: ${printable(input)}`,
      input,
      'OC_PATH_PARENT_TRAVERSAL',
    );
  }

  const result: OcPath = {
    file,
    ...(segments[1] !== undefined ? { section: segments[1] } : {}),
    ...(segments[2] !== undefined ? { item: segments[2] } : {}),
    ...(segments[3] !== undefined ? { field: segments[3] } : {}),
    ...(session !== undefined ? { session } : {}),
  };

  return result;
}

/**
 * Format an `OcPath` struct back into its canonical string form.
 *
 * Throws `OcPathError` if the struct violates structural nesting
 * (item without section, field without item).
 */
export function formatOcPath(path: OcPath): string {
  if (!path.file || path.file.length === 0) {
    throw new OcPathError('oc:// path requires a file', '', 'OC_PATH_FILE_REQUIRED');
  }
  // Symmetric defense with parseOcPath — an `OcPath` struct constructed
  // programmatically with `file: '..'` or `file: '/etc/passwd'` would
  // otherwise emit a path that either round-trips into a traversal or
  // is rejected at parse time, breaking the contract on line 13. Refuse
  // here so the caller sees the violation at the format boundary.
  if (path.file.startsWith('/') || path.file.startsWith('\\') || /^[a-zA-Z]:/.test(path.file)) {
    throw new OcPathError(
      `Absolute file slot not allowed in OcPath struct: ${printable(path.file)}`,
      path.file,
      'OC_PATH_ABSOLUTE_FILE',
    );
  }
  if (path.file.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new OcPathError(
      `Parent-directory segment ('..') not allowed in OcPath.file: ${printable(path.file)}`,
      path.file,
      'OC_PATH_PARENT_TRAVERSAL',
    );
  }
  if (hasControlChar(path.file)) {
    throw new OcPathError(
      `Control character in OcPath.file: ${printable(path.file)}`,
      path.file,
      'OC_PATH_CONTROL_CHAR',
    );
  }
  if (path.item !== undefined && path.section === undefined) {
    throw new OcPathError(
      'Structural nesting violation: item requires section',
      path.file,
      'OC_PATH_NESTING',
    );
  }
  if (path.field !== undefined && path.item === undefined && path.section !== undefined) {
    // section + field without item is allowed for frontmatter-shaped addressing? No —
    // frontmatter is `oc://FILE/[frontmatter]/key`. For now require item-or-no-section
    // with field. Reconsider when frontmatter addressing lands.
    throw new OcPathError(
      'Structural nesting violation: field requires item when section is present',
      path.file,
      'OC_PATH_NESTING',
    );
  }
  if (path.field !== undefined && path.item === undefined && path.section === undefined) {
    // `{ file, field }` with no section / item would emit `oc://FILE/FIELD`
    // and silently re-parse as `{ file, section: FIELD }`. The struct
    // already violates the slot grammar (field implies item) — refuse
    // here so programmatic callers don't ship a path that round-trips
    // to a different shape than they wrote.
    throw new OcPathError(
      'Structural nesting violation: field requires item',
      path.file,
      'OC_PATH_NESTING',
    );
  }

  // Each slot is a dotted sub-segment string. Round-trip requires that
  // raw sub-segments containing the path grammar's special characters
  // get quoted before concatenation, OR pass through if already in a
  // structural form (quoted `"..."`, predicate `[...]`, union `{...}`,
  // literal sentinel `[frontmatter]` etc.). Plain concatenation would
  // silently turn a raw `foo/bar` slot into two segments at parse
  // time. Closes the formatter quoted-segment gap.
  const formatSubSegment = (sub: string): string => {
    if (isQuotedSeg(sub)) {return sub;}                    // already quoted
    if (sub.startsWith('[') && sub.endsWith(']')) {return sub;} // predicate / sentinel
    if (sub.startsWith('{') && sub.endsWith('}')) {return sub;} // union
    return quoteSeg(sub);
  };
  // Reject content the parser would refuse on the way back in. Without
  // these guards a struct like `{section:'foo.'}` would emit
  // `oc://X/foo.""` (an empty quoted sub-segment) and re-parse with
  // `section: 'foo.""'` — silent round-trip mangling. Mirrors
  // validateSubSegment's empty + control-char checks at the format
  // boundary so callers see the violation here, not on the next parse.
  const validateSubForFormat = (sub: string, slotName: string): void => {
    if (sub.length === 0) {
      throw new OcPathError(
        `Empty dotted sub-segment in OcPath.${slotName}`,
        path.file,
        'OC_PATH_EMPTY_SUB_SEGMENT',
      );
    }
    if (hasControlChar(sub)) {
      throw new OcPathError(
        `Control character in OcPath.${slotName} sub-segment "${printable(sub)}"`,
        path.file,
        'OC_PATH_CONTROL_CHAR',
      );
    }
  };
  const formatSlot = (slot: string, slotName: string): string => {
    const subs = splitRespectingBrackets(slot, '.');
    for (const sub of subs) {validateSubForFormat(sub, slotName);}
    return subs.map(formatSubSegment).join('.');
  };

  // The file slot uses simpler quoting than section/item/field: dots
  // are normal in filenames (`AGENTS.md`) and don't need quoting; we
  // only quote when the file contains chars that would otherwise be
  // parsed as structure — primarily `/` which is the segment separator.
  // `quoteSeg` already wraps + escapes when needed; we narrow the
  // trigger so plain `AGENTS.md` round-trips bare.
  const fileNeedsQuote = /[/[\]{}?&%"\s]/.test(path.file);
  const formattedFile = fileNeedsQuote ? quoteSeg(path.file) : path.file;
  let out = OC_SCHEME + formattedFile;
  if (path.section !== undefined) {out += '/' + formatSlot(path.section, 'section');}
  if (path.item !== undefined) {out += '/' + formatSlot(path.item, 'item');}
  if (path.field !== undefined) {out += '/' + formatSlot(path.field, 'field');}
  if (path.session !== undefined) {out += '?session=' + path.session;}
  // Symmetric upper bound with parseOcPath's MAX_PATH_LENGTH cap. Without
  // this, a struct whose formatted form exceeds the cap would emit a
  // string `parseOcPath` immediately rejects — silently breaking the
  // round-trip contract and surprising every consumer that buffers /
  // logs / column-aligns by the cap (audit events, error messages,
  // editor breadcrumbs).
  if (out.length > MAX_PATH_LENGTH) {
    throw new OcPathError(
      `Formatted oc:// exceeds ${MAX_PATH_LENGTH} bytes (length: ${out.length})`,
      out.slice(0, 80) + '…',
      'OC_PATH_TOO_LONG',
    );
  }
  // Sentinel guard at the path-string emit boundary. The substrate's
  // contract: emit boundaries refuse to write the redaction sentinel,
  // and `formatOcPath` IS such a boundary — path strings flow into
  // telemetry, audit events, error messages, find result `path` fields.
  // Without this guard, a struct field carrying the literal
  // `__OPENCLAW_REDACTED__` slips past every consumer except the CLI
  // (which has its own scrubSentinel layer).
  if (out.includes(REDACTED_SENTINEL)) {
    throw new OcEmitSentinelError(out);
  }
  return out;
}

/**
 * Type guard — true iff `input` is a non-empty string that `parseOcPath`
 * would accept. Does not throw; callers can branch on this before
 * parsing.
 */
export function isValidOcPath(input: unknown): input is string {
  if (typeof input !== 'string') {return false;}
  try {
    parseOcPath(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Positional tokens — single-match primitives that resolve to one
 * concrete index/key based on container size at resolve time. Unlike
 * `*` / `**`, these do NOT trigger the wildcard guard on
 * `resolveOcPath` / `setOcPath`: they always pick exactly one element.
 *
 *   `$first` — index 0 (seq/array) or first-declared key (map/object)
 *   `$last`  — last index, or last-declared key
 *   `-N`     — Nth from the end (seq/array only); `-1` = last, `-2` = penultimate
 *
 * Out-of-range tokens (`$first` on an empty container, `-99` on a
 * 3-item array) yield `null` from resolve and an empty match list
 * from find.
 *
 * `$last` was the original jsonl-only sentinel for line addressing
 * (`oc://X/$last/event`); it's now generalized to every kind.
 */
export const POS_FIRST = '$first';
export const POS_LAST = '$last';

/** True iff `seg` is a positional token that resolves at lookup time. */
export function isPositionalSeg(seg: string): boolean {
  return seg === POS_FIRST || seg === POS_LAST || /^-\d+$/.test(seg);
}

/**
 * Ordinal addressing — `#N` (zero-based) targets the Nth item by
 * document order, regardless of how the kind ordinarily addresses
 * children.
 *
 * For seq/array kinds where children are already addressed by integer
 * index, `#N` is a synonym for `N`. Where it earns its keep is in
 * **slug-addressed kinds** (md items, where two items can share a
 * slug like `- foo: a` / `- foo: b`): `#0` and `#1` distinguish them
 * by document order even when slug-addressing collapses.
 */
export function isOrdinalSeg(seg: string): boolean {
  return /^#\d+$/.test(seg);
}

export function parseOrdinalSeg(seg: string): number | null {
  const m = /^#(\d+)$/.exec(seg);
  return m === null || m[1] === undefined ? null : Number(m[1]);
}

/**
 * Container shape passed to `resolvePositionalSeg`. Indexable
 * containers (seq, array) provide `size`. Keyed containers (map,
 * object) provide the ordered `keys` list — `$first` picks the first,
 * `$last` the last; negative indices are NOT valid on keyed
 * containers (use the literal key instead).
 */
export interface PositionalContainer {
  readonly indexable: boolean;
  readonly size: number;
  readonly keys?: readonly string[];
}

/**
 * Resolve a positional token (`$first` / `$last` / `-N`) against a
 * container's shape, returning the concrete segment (numeric index or
 * literal key) or `null` if the token can't apply.
 */
export function resolvePositionalSeg(
  seg: string,
  container: PositionalContainer,
): string | null {
  if (seg === POS_FIRST) {
    if (container.size === 0) {return null;}
    if (!container.indexable) {return container.keys?.[0] ?? null;}
    return '0';
  }
  if (seg === POS_LAST) {
    if (container.size === 0) {return null;}
    if (!container.indexable) {return container.keys?.[container.keys.length - 1] ?? null;}
    return String(container.size - 1);
  }
  if (/^-\d+$/.test(seg)) {
    if (!container.indexable) {return null;}
    // P-040 — guard against integer-overflow in the magnitude. A
    // 13-digit-or-longer string parses to a Number that exceeds 1e9
    // (well below MAX_SAFE_INTEGER but already absurd as an array
    // index). Reject before doing the addition so the caller sees a
    // clean null rather than a coerced-to-zero surprise.
    const raw = Number(seg);
    if (!Number.isInteger(raw) || Math.abs(raw) > 1e9) {return null;}
    const n = container.size + raw;
    return n >= 0 && n < container.size ? String(n) : null;
  }
  return null;
}

/**
 * Wildcard tokens permitted in `findOcPaths` patterns.
 *
 * `*` matches a single sub-segment (e.g. one map key or one array index).
 * `**` matches zero or more sub-segments at any depth (recursive descent).
 *
 * Wildcards are **not** allowed in `resolveOcPath` / `setOcPath` — those
 * verbs require an exact concrete path. `findOcPaths` is the only verb
 * that consumes patterns. Use `hasWildcard` to enforce this at the
 * boundary.
 */
export const WILDCARD_SINGLE = '*';
export const WILDCARD_RECURSIVE = '**';

/**
 * `true` iff any sub-segment of the path is a multi-match pattern —
 * `*`, `**`, a union `{a,b,c}`, or a value predicate `[key=value]`.
 * Single-match verbs (`resolveOcPath` / `setOcPath`) reject these
 * uniformly; only `findOcPaths` consumes them.
 *
 * **Naming**: `isPattern` is the v1 name; `hasWildcard` is retained
 * as a back-compat alias since the literal "wildcard" framing was
 * what shipped first. Prefer `isPattern` in new code.
 */
export function isPattern(path: OcPath): boolean {
  for (const slot of [path.section, path.item, path.field]) {
    if (slot === undefined) {continue;}
    // Quote-aware split — `slot.split('.')` would shred quoted keys
    // containing literal `*` (e.g. `"items.*.glob"`) and falsely
    // detect them as wildcards, causing single-match verbs to reject
    // a concrete path.
    for (const sub of splitRespectingBrackets(slot, '.')) {
      if (sub === WILDCARD_SINGLE || sub === WILDCARD_RECURSIVE) {return true;}
      if (isUnionSeg(sub)) {return true;}
      if (isPredicateSeg(sub)) {return true;}
    }
  }
  return false;
}

/** @deprecated v1 — use {@link isPattern}. Behaviorally identical. */
export const hasWildcard = isPattern;

/**
 * Union segment — `{a,b,c}` matches each comma-separated alternative.
 *
 *   oc://X/steps/* /{command,run}      → each step's command OR run
 *   oc://X/{steps,inputs}/* /id        → id under steps OR inputs
 *
 * Whitespace inside braces is preserved. Empty alternatives reject.
 * Nested braces are not supported in v0.
 */
export function isUnionSeg(seg: string): boolean {
  return seg.length >= 2 && seg.startsWith('{') && seg.endsWith('}');
}

export function parseUnionSeg(seg: string): readonly string[] | null {
  if (!isUnionSeg(seg)) {return null;}
  const inner = seg.slice(1, -1);
  if (inner.length === 0) {return null;}
  const alts = inner.split(',');
  if (alts.some((a) => a.length === 0)) {return null;}
  return alts;
}

/**
 * Value predicate segment — `[key<op>value]` filters a parent
 * enumeration by sibling-field comparison. Used in find patterns:
 *
 *   oc://X/steps/[id=build]                  → step whose `id` equals `build`
 *   oc://X/steps/[id!=test]/command          → command of every non-test step
 *   oc://X/steps/[command*=npm]/id           → id of every step whose command contains `npm`
 *   oc://X/steps/[command^=npm run]/id       → id of every step whose command starts with `npm run`
 *   oc://X/steps/[id$=_test]/command         → command of every step whose id ends with `_test`
 *   oc://X/models/[contextWindow>=1000000]   → models with 1M+ context window
 *   oc://X/models/[maxTokens>128000]/id      → id of every model with maxTokens > 128000
 *
 * Operators:
 *
 *   String (CSS attribute-selector style):
 *     `=`   equality (string-coerced)
 *     `!=`  inequality
 *     `*=`  substring contains
 *     `^=`  starts-with
 *     `$=`  ends-with
 *
 *   Numeric (v1.1 — addresses openclaw#54383, openclaw#76532):
 *     `<`   less than
 *     `<=`  less than or equal
 *     `>`   greater than
 *     `>=`  greater than or equal
 *
 * Numeric ops require both `actual` and `value` to coerce to finite
 * numbers via `Number()`. Non-numeric leaves never match a numeric
 * predicate (consistent with how `*=` doesn't apply to numbers).
 *
 * Operator search is greedy on multi-char operators — `[a!=b]` is
 * `key=a, op=!=, value=b`, not `key=a!, op==, value=b`. Multi-char
 * operators (`!=`, `<=`, `>=`, `*=`, `^=`, `$=`) are tried before
 * single-char (`=`, `<`, `>`).
 */
export type PredicateOp = '=' | '!=' | '*=' | '^=' | '$=' | '<' | '<=' | '>' | '>=';

/** Multi-char first so greedy match wins (`<=` before `<`, etc.). */
const PREDICATE_OPS: readonly PredicateOp[] = ['!=', '*=', '^=', '$=', '<=', '>=', '<', '>', '='];

export function isPredicateSeg(seg: string): boolean {
  if (seg.length < 4 || !seg.startsWith('[') || !seg.endsWith(']')) {return false;}
  const inner = new Set(seg.slice(1, -1));
  return PREDICATE_OPS.some((op) => inner.has(op));
}

export interface PredicateSpec {
  readonly key: string;
  readonly op: PredicateOp;
  readonly value: string;
}

export function parsePredicateSeg(seg: string): PredicateSpec | null {
  if (seg.length < 4 || !seg.startsWith('[') || !seg.endsWith(']')) {return null;}
  const inner = seg.slice(1, -1);
  // Leftmost operator wins, with multi-char tried before single-char
  // at each position. So `[a==b]` parses as `key=a, op==, value==b`
  // (leftmost `=`), and `[a<=b]` parses as `key=a, op=<=, value=b`
  // (multi-char `<=` beats single `<` at the same position).
  for (let i = 1; i < inner.length; i++) {
    for (const op of PREDICATE_OPS) {
      if (!inner.startsWith(op, i)) {continue;}
      if (i + op.length >= inner.length) {continue;} // empty value
      return {
        key: inner.slice(0, i),
        op,
        value: inner.slice(i + op.length),
      };
    }
  }
  return null;
}

/**
 * Evaluate a predicate against a string-coerced leaf value. The
 * walker fetches the sibling's value and passes it to this helper.
 * Returns `false` for non-leaf children (predicate can't compare an
 * object/array sibling, so it never matches).
 *
 * For numeric operators (`<` / `<=` / `>` / `>=`), both `actual` and
 * `pred.value` are coerced via `Number()` and checked with
 * `Number.isFinite`. Non-numeric leaves never match — this is
 * symmetric with how `*=` / `^=` / `$=` don't apply to numbers
 * (a number's "string form" comparison would be confusing).
 */
export function evaluatePredicate(actual: string | null, pred: PredicateSpec): boolean {
  if (actual === null) {return false;}
  switch (pred.op) {
    case '=':
      return actual === pred.value;
    case '!=':
      return actual !== pred.value;
    case '*=':
      return actual.includes(pred.value);
    case '^=':
      return actual.startsWith(pred.value);
    case '$=':
      return actual.endsWith(pred.value);
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const a = Number(actual);
      const b = Number(pred.value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {return false;}
      switch (pred.op) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
      }
      return false;
    }
  }
  return false;
}

/**
 * Flatten the path into the concrete sub-segment list the per-kind
 * resolvers walk against (`[...section.split('.'), ...item.split('.'),
 * ...field.split('.')]`). Returned alongside the slot offsets so a
 * caller can reconstruct an `OcPath` from a concrete walk by re-packing
 * sub-segments back into the original slots.
 */
export interface PathSegmentLayout {
  readonly subs: readonly string[];
  /** Number of sub-segments in `section` (0 if absent). */
  readonly sectionLen: number;
  /** Number of sub-segments in `item` (0 if absent). */
  readonly itemLen: number;
  /** Number of sub-segments in `field` (0 if absent). */
  readonly fieldLen: number;
}

export function getPathLayout(path: OcPath): PathSegmentLayout {
  // Quote-aware split — `slot.split('.')` would shred a quoted segment
  // containing a literal `.` (e.g. `"a.b"`) into two sub-segments and
  // break the find-walker / repackPath layout contract. Mirror the
  // splitter used by `parseOcPath` so downstream walkers see the same
  // sub-segment shape on both directions.
  const sectionSubs = path.section === undefined ? [] : splitRespectingBrackets(path.section, '.');
  const itemSubs = path.item === undefined ? [] : splitRespectingBrackets(path.item, '.');
  const fieldSubs = path.field === undefined ? [] : splitRespectingBrackets(path.field, '.');
  return {
    subs: [...sectionSubs, ...itemSubs, ...fieldSubs],
    sectionLen: sectionSubs.length,
    itemLen: itemSubs.length,
    fieldLen: fieldSubs.length,
  };
}

/**
 * Re-pack a concrete sub-segment list (matching the layout of `pattern`)
 * into an `OcPath`. Wildcard segments in `pattern` are replaced by their
 * concrete counterparts in `subs`; non-wildcard segments are copied
 * verbatim. The slot boundaries (section/item/field) are preserved so
 * the output mirrors the input pattern's shape.
 *
 * Throws if `subs.length !== pattern layout subs length` — the walker
 * must always produce a complete concrete path.
 */
export function repackPath(
  pattern: OcPath,
  subs: readonly string[],
): OcPath {
  const layout = getPathLayout(pattern);
  if (subs.length !== layout.subs.length) {
    throw new OcPathError(
      `repack length mismatch: pattern has ${layout.subs.length} sub-segments, got ${subs.length}`,
      formatOcPath(pattern),
      'OC_PATH_REPACK_LENGTH',
    );
  }
  const sectionSubs = subs.slice(0, layout.sectionLen);
  const itemSubs = subs.slice(layout.sectionLen, layout.sectionLen + layout.itemLen);
  const fieldSubs = subs.slice(layout.sectionLen + layout.itemLen);
  return {
    file: pattern.file,
    ...(sectionSubs.length > 0 ? { section: sectionSubs.join('.') } : {}),
    ...(itemSubs.length > 0 ? { item: itemSubs.join('.') } : {}),
    ...(fieldSubs.length > 0 ? { field: fieldSubs.join('.') } : {}),
    ...(pattern.session !== undefined ? { session: pattern.session } : {}),
  };
}

function extractSession(queryPart: string): string | undefined {
  if (queryPart.length === 0) {return undefined;}
  for (const pair of queryPart.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {continue;}
    const key = pair.slice(0, eqIndex);
    const value = pair.slice(eqIndex + 1);
    if (key === 'session' && value.length > 0) {return value;}
  }
  return undefined;
}

/**
 * Split `s` on `delim`, but treat balanced `[...]`, `{...}`, and
 * `"..."` regions as opaque — delimiters inside brackets/braces or
 * inside double quotes don't trigger splits.
 *
 * Quoted segments (v1.0 — addresses openclaw#69004, openclaw#76532)
 * let path keys contain `/`, `.`, `?`, `&`, `%`, and whitespace
 * verbatim:
 *
 *   oc://X/"foo/bar"/baz                          → key `foo/bar`
 *   oc://X/agents.defaults.models/"anthropic/claude-opus-4-7"/alias
 *
 * Inside a quoted segment, `\\` escapes a backslash and `\"` escapes
 * a quote. Other backslashes are literal.
 *
 * Throws `OcPathError` on unbalanced brackets/braces/quotes — malformed
 * input is rejected at parse time rather than silently tolerated.
 *
 * @internal — exported for use by the find walker; not part of the
 * public OcPath API surface.
 */
/**
 * Find the first occurrence of `ch` at the TOP level of `s` —
 * outside any balanced `[...]`, `{...}`, or `"..."` regions.
 * Used by `parseOcPath` to locate the query separator (`?`) without
 * mistakenly splitting inside a quoted key like `"foo?bar"`.
 *
 * Returns `-1` if the character is not present at the top level.
 */
export function indexOfTopLevel(s: string, ch: string): number {
  let depthBracket = 0;
  let depthBrace = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '\\' && i + 1 < s.length) { i++; continue; }
      if (c === '"') {inQuote = false;}
      continue;
    }
    if (c === '"') { inQuote = true; continue; }
    if (c === '[') {depthBracket++;}
    else if (c === ']') {depthBracket--;}
    else if (c === '{') {depthBrace++;}
    else if (c === '}') {depthBrace--;}
    if (c === ch && depthBracket === 0 && depthBrace === 0) {return i;}
  }
  return -1;
}

export function splitRespectingBrackets(s: string, delim: string, originalInput?: string): string[] {
  const out: string[] = [];
  let depthBracket = 0;
  let depthBrace = 0;
  let inQuote = false;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      // Inside a quoted region: `\\` and `\"` consume the next char;
      // unescaped `"` closes the quote.
      if (c === '\\' && i + 1 < s.length) {
        buf += c + s[i + 1];
        i++;
        continue;
      }
      if (c === '"') {
        inQuote = false;
      }
      buf += c;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      buf += c;
      continue;
    }
    if (c === '[') {depthBracket++;}
    else if (c === ']') {depthBracket--;}
    else if (c === '{') {depthBrace++;}
    else if (c === '}') {depthBrace--;}
    if (depthBracket < 0 || depthBrace < 0) {
      throw new OcPathError(
        `Unbalanced bracket/brace in oc:// path: ${originalInput ?? s}`,
        originalInput ?? s,
        'OC_PATH_UNBALANCED',
      );
    }
    if (c === delim && depthBracket === 0 && depthBrace === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (depthBracket !== 0 || depthBrace !== 0 || inQuote) {
    throw new OcPathError(
      `Unbalanced bracket/brace/quote in oc:// path: ${originalInput ?? s}`,
      originalInput ?? s,
      'OC_PATH_UNBALANCED',
    );
  }
  out.push(buf);
  return out;
}

/**
 * `true` iff `seg` is a fully-quoted segment of the form `"..."`.
 * Used by parsers/walkers to dispatch on quoted vs bare segments.
 */
export function isQuotedSeg(seg: string): boolean {
  return seg.length >= 2 && seg.startsWith('"') && seg.endsWith('"');
}

/**
 * Strip surrounding quotes and unescape `\\` / `\"` from a quoted
 * segment, yielding the literal content. Inverse of `quoteSeg`.
 *
 * No-op on bare (unquoted) segments — returns input unchanged.
 */
export function unquoteSeg(seg: string): string {
  if (!isQuotedSeg(seg)) {return seg;}
  const inner = seg.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '\\' || next === '"') {
        out += next;
        i++;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Quote a literal value for inclusion in a path. If the value contains
 * any character that has grammar meaning unquoted (`/`, `.`, `[`, `{`,
 * `?`, `&`, `%`, whitespace, or `"`), wrap in quotes and escape
 * embedded `\\` / `"`. Otherwise return as-is.
 *
 * Used by `formatOcPath` to round-trip slot values that came from
 * quoted-segment input.
 */
export function quoteSeg(value: string): string {
  if (value.length === 0) {return '""';}
  const needsQuote = /[/.[\]{}?&%"\s]/.test(value);
  if (!needsQuote) {return value;}
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function validateBrackets(seg: string, input: string): void {
  // The splitter already enforced balance — this is a defense-in-depth
  // pass that also catches stray unmatched brackets in segments that
  // didn't trigger a split. Skip characters inside quoted regions
  // (`"..."` with `\` escape) so quoted segments containing literal
  // `[` / `{` round-trip cleanly. Without this skip, `formatOcPath`
  // would emit `"a[b"` (correctly quoted) and `parseOcPath` would
  // reject it here as unbalanced — breaking the round-trip.
  let depthBracket = 0;
  let depthBrace = 0;
  let inQuote = false;
  let escaped = false;
  for (const c of seg) {
    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inQuote = false;
      }
      continue;
    }
    if (c === '"') {
      inQuote = true;
      continue;
    }
    if (c === '[') {depthBracket++;}
    else if (c === ']') {depthBracket--;}
    else if (c === '{') {depthBrace++;}
    else if (c === '}') {depthBrace--;}
    if (depthBracket < 0 || depthBrace < 0) {
      throw new OcPathError(
        `Unbalanced bracket/brace in segment "${seg}": ${printable(input)}`,
        input,
        'OC_PATH_UNBALANCED',
      );
    }
  }
  if (depthBracket !== 0 || depthBrace !== 0) {
    throw new OcPathError(
      `Unbalanced bracket/brace in segment "${seg}": ${printable(input)}`,
      input,
      'OC_PATH_UNBALANCED',
    );
  }
}

function validateSubSegment(sub: string, input: string): void {
  // Empty sub-segment from dotted-form means a stray `.` (e.g. `a..b`).
  if (sub.length === 0) {
    throw new OcPathError(
      `Empty dotted sub-segment in oc:// path: ${printable(input)}`,
      input,
      'OC_PATH_EMPTY_SUB_SEGMENT',
    );
  }

  // P-004 / P-011 — control characters (including null byte) banned
  // in segments. They have no legitimate use in addressing and they
  // break downstream consumers (terminals, C strings, log lines).
  // Applied to both quoted and unquoted forms — quoting lets you put
  // slashes in keys, not control bytes.
  if (hasControlChar(sub)) {
    throw new OcPathError(
      `Control character in oc:// segment "${printable(sub)}": ${printable(input)}`,
      input,
      'OC_PATH_CONTROL_CHAR',
    );
  }

  // Quoted segments (v1.0): content is verbatim and the rest of these
  // checks (whitespace, reserved chars) don't apply — quoting is the
  // explicit opt-out from those identifier-shape rules. Skip ahead.
  if (isQuotedSeg(sub)) {return;}

  // P-026 — reserved characters that the path grammar itself uses
  // (`?` for query, `&` between query pairs, `%` for URL escapes).
  // Allowed inside predicate values where they'll be quoted at the
  // path level by the bracket containment rule (P-012/P-013).
  if (!sub.startsWith('[') && !sub.startsWith('{')) {
    if (RESERVED_CHARS_RE.test(sub)) {
      throw new OcPathError(
        `Reserved character (\`?\` / \`&\` / \`%\`) in oc:// segment "${sub}": ${printable(input)}`,
        input,
        'OC_PATH_RESERVED_CHAR',
      );
    }
  }

  // P-003 — leading or trailing whitespace in identifier-shaped subs.
  // Predicate / union segments don't get this check (their values are
  // content and may legitimately want spaces).
  if (!sub.startsWith('[') && !sub.startsWith('{')) {
    if (sub !== sub.trim() || /\s/.test(sub)) {
      throw new OcPathError(
        `Whitespace in oc:// segment "${sub}": ${printable(input)}`,
        input,
        'OC_PATH_WHITESPACE',
      );
    }
  }
  // Bracket grammar: a sub starting with `[` and ending with `]` is
  // either a literal sentinel (e.g. `[frontmatter]`) — accepted as-is
  // — or a predicate `[key<op>value]`. Mismatched brackets (only one
  // side present) are rejected. A predicate-shaped segment (contains
  // a comparison operator inside) must parse cleanly.
  const startsBracket = sub.startsWith('[');
  const endsBracket = sub.endsWith(']');
  if (startsBracket !== endsBracket) {
    throw new OcPathError(
      `Mismatched bracket in segment "${sub}": ${printable(input)}`,
      input,
      'OC_PATH_MALFORMED_PREDICATE',
    );
  }
  if (startsBracket && endsBracket) {
    const inner = sub.slice(1, -1);
    if (inner.length === 0) {
      throw new OcPathError(
        `Empty bracket segment "${sub}": ${printable(input)}`,
        input,
        'OC_PATH_MALFORMED_PREDICATE',
      );
    }
    // If it looks like a predicate (has an operator), validate fully.
    const hasOp = ['!=', '*=', '^=', '$=', '<=', '>=', '<', '>', '='].some((op) => inner.includes(op));
    if (hasOp) {
      const parsed = parsePredicateSeg(sub);
      if (parsed === null || parsed.key.length === 0 || parsed.value.length === 0) {
        throw new OcPathError(
          `Malformed predicate "${sub}" — must be \`[key<op>value]\` with non-empty key and value: ${printable(input)}`,
          input,
          'OC_PATH_MALFORMED_PREDICATE',
        );
      }
    }
    // No operator → literal sentinel segment (e.g. `[frontmatter]`),
    // accepted as-is for back-compat.
  }
  // Brace grammar: union `{a,b,c}`. Mismatched or empty is rejected.
  const startsBrace = sub.startsWith('{');
  const endsBrace = sub.endsWith('}');
  if (startsBrace !== endsBrace) {
    throw new OcPathError(
      `Mismatched brace in segment "${sub}": ${printable(input)}`,
      input,
      'OC_PATH_MALFORMED_UNION',
    );
  }
  if (startsBrace && endsBrace) {
    const inner = sub.slice(1, -1);
    if (inner.length === 0) {
      throw new OcPathError(
        `Empty union "${sub}" — must contain at least one alternative: ${printable(input)}`,
        input,
        'OC_PATH_MALFORMED_UNION',
      );
    }
    if (inner.split(',').some((a) => a.length === 0)) {
      throw new OcPathError(
        `Empty alternative in union "${sub}": ${printable(input)}`,
        input,
        'OC_PATH_MALFORMED_UNION',
      );
    }
  }
}
