// JSON parse helpers recover structured values from partial model output.
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const JSON_CONTROL_ESCAPES = new Set(["b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
  let repaired = "";
  let inString = false;
  let stringValuePrefix = "";

  for (let index = 0; index < json.length; index++) {
    const char = json.charAt(index);

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
        stringValuePrefix = "";
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      stringValuePrefix = "";
      continue;
    }

    if (char === "\\") {
      const nextChar = json.charAt(index + 1);
      if (!nextChar) {
        repaired += "\\\\";
        continue;
      }

      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          stringValuePrefix += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
        // A \u not followed by four hex digits is an invalid escape: double the
        // backslash like the other invalid escapes below. Falling through would
        // hit the valid-escape branch (VALID_JSON_ESCAPES contains "u") and
        // re-emit the broken \u, leaving the JSON unparseable.
        repaired += "\\\\";
        stringValuePrefix += "\\";
        continue;
      }

      if (JSON_CONTROL_ESCAPES.has(nextChar) && looksLikeWindowsPathPrefix(stringValuePrefix)) {
        repaired += "\\\\";
        stringValuePrefix += "\\";
        continue;
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        stringValuePrefix += nextChar === "\\" ? "\\" : `\\${nextChar}`;
        index += 1;
        continue;
      }

      repaired += "\\\\";
      stringValuePrefix += "\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
    stringValuePrefix += char;
  }

  return repaired;
}

export function parseJsonWithRepair(json: string): unknown {
  return JSON.parse(repairJson(json)) as unknown;
}

function looksLikeWindowsPathPrefix(prefix: string): boolean {
  const tail = prefix.slice(-160);
  return /(?:^|[^A-Za-z0-9])[A-Za-z]:(?:[\\/][^"\\/:*?<>|\r\n]*)*$/.test(tail);
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson(partialJson: string | undefined): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") {
    return {};
  }

  try {
    return asNonArrayRecord(parseJsonWithRepair(partialJson));
  } catch {
    try {
      return asNonArrayRecord(partialParse(partialJson));
    } catch {
      try {
        return asNonArrayRecord(partialParse(repairJson(partialJson)));
      } catch {
        return {};
      }
    }
  }
}

function parseStreamingJsonFromParts(raw: string, repaired: string): Record<string, unknown> {
  if (!raw || raw.trim() === "") {
    return {};
  }
  try {
    return asStreamingJsonRecord(JSON.parse(repaired) as unknown);
  } catch {
    try {
      return asStreamingJsonRecord(partialParse(raw));
    } catch {
      try {
        return asStreamingJsonRecord(partialParse(repaired));
      } catch {
        return {};
      }
    }
  }
}

/**
 * Resumable counterpart to `repairJson`'s character-level state machine.
 * `repairJson(json)` only ever needs two pieces of context to decide how to
 * treat the *next* character: whether it is currently inside a string
 * (`inString`), and the trailing slice of that string's content so far
 * (`stringValuePrefix`, used by the Windows-path heuristic below). Neither
 * depends on anything earlier than that, so the whole scan can be resumed
 * from a saved `RepairJsonState` instead of restarted from index 0 - see
 * `repairJsonChunk`.
 */
export interface RepairJsonState {
  inString: boolean;
  stringValuePrefix: string;
  /**
   * Raw characters whose repair can't be decided yet because it depends on
   * characters that haven't arrived in the stream (a lone trailing `\`, or a
   * `\uXXXX` escape with fewer than 4 hex digits seen so far). Bounded to a
   * handful of characters (worst case: `\` + `u` + 3 hex digits) regardless
   * of how large the surrounding buffer grows.
   */
  pendingRaw: string;
}

export function createRepairJsonState(): RepairJsonState {
  return { inString: false, stringValuePrefix: "", pendingRaw: "" };
}

// looksLikeWindowsPathPrefix only ever inspects the trailing 160 characters,
// so there is no correctness reason to let stringValuePrefix grow past that
// even though the current JSON string value may be much longer.
const STRING_VALUE_PREFIX_CAP = 160;

function appendStringValuePrefix(prefix: string, addition: string): string {
  const next = prefix + addition;
  return next.length > STRING_VALUE_PREFIX_CAP ? next.slice(-STRING_VALUE_PREFIX_CAP) : next;
}

/**
 * Repairs only the newly-arrived `delta`, resuming from `state` (mutated in
 * place) instead of re-scanning everything seen so far. Feeding successive
 * deltas of a growing buffer through this function and concatenating the
 * results is equivalent to calling `repairJson` once on the full
 * accumulated string - see json-parse.test.ts for the differential test
 * that pins this invariant across randomized chunk boundaries, including
 * boundaries that land mid-escape-sequence.
 *
 * This is what makes streaming tool-call argument previews O(n) total
 * instead of O(n^2): every caller used to do `buffer += delta;
 * repairJson(buffer)`, which re-scans the whole buffer on every single
 * delta. This function only ever scans `delta` (plus at most a handful of
 * held-back characters from the previous call).
 *
 * `isFinal` must be true for the last delta of a value (e.g. once streaming
 * for that value has ended) so any still-pending escape sequence is
 * resolved using the same "no more characters are coming" semantics
 * `repairJson` uses for a complete string, instead of being held back
 * forever waiting for input that will never arrive.
 */
export interface RepairJsonChunkResult {
  repaired: string;
  /**
   * True if an (unescaped) `"` was processed during this call - i.e. a
   * string value/key either opened or closed (or both) somewhere within
   * this delta. Used by `pushStreamingJsonPreview` to detect when a
   * previously-tracked "currently open string" location may no longer be
   * valid and a structural re-check is needed, versus a delta that is pure
   * interior string content and safe to append incrementally. Does not
   * count escaped quotes (`\"`), since those never toggle `state.inString`.
   */
  stringBoundaryCrossed: boolean;
}

function repairJsonChunkCore(
  delta: string,
  state: RepairJsonState,
  isFinal: boolean,
): RepairJsonChunkResult {
  const input = state.pendingRaw + delta;
  state.pendingRaw = "";
  let repaired = "";
  let stringBoundaryCrossed = false;
  let index = 0;

  while (index < input.length) {
    const char = input.charAt(index);

    if (!state.inString) {
      repaired += char;
      if (char === '"') {
        state.inString = true;
        state.stringValuePrefix = "";
        stringBoundaryCrossed = true;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      repaired += char;
      state.inString = false;
      state.stringValuePrefix = "";
      stringBoundaryCrossed = true;
      index += 1;
      continue;
    }

    if (char === "\\") {
      const nextChar = input.charAt(index + 1);
      if (!nextChar) {
        if (!isFinal) {
          state.pendingRaw = input.slice(index);
          return { repaired, stringBoundaryCrossed };
        }
        repaired += "\\\\";
        index += 1;
        continue;
      }

      if (nextChar === "u") {
        const available = input.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(available)) {
          repaired += `\\u${available}`;
          state.stringValuePrefix = appendStringValuePrefix(
            state.stringValuePrefix,
            `\\u${available}`,
          );
          index += 6;
          continue;
        }
        const seenSoFar = input.length - (index + 2);
        if (!isFinal && seenSoFar < 4 && /^[0-9a-fA-F]*$/.test(available)) {
          state.pendingRaw = input.slice(index);
          return { repaired, stringBoundaryCrossed };
        }
        // A \u not followed by four hex digits is an invalid escape: double the
        // backslash like the other invalid escapes below. Falling through would
        // hit the valid-escape branch (VALID_JSON_ESCAPES contains "u") and
        // re-emit the broken \u, leaving the JSON unparseable.
        repaired += "\\\\";
        state.stringValuePrefix = appendStringValuePrefix(state.stringValuePrefix, "\\");
        index += 1;
        continue;
      }

      if (
        JSON_CONTROL_ESCAPES.has(nextChar) &&
        looksLikeWindowsPathPrefix(state.stringValuePrefix)
      ) {
        repaired += "\\\\";
        state.stringValuePrefix = appendStringValuePrefix(state.stringValuePrefix, "\\");
        index += 1;
        continue;
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        state.stringValuePrefix = appendStringValuePrefix(
          state.stringValuePrefix,
          nextChar === "\\" ? "\\" : `\\${nextChar}`,
        );
        index += 2;
        continue;
      }

      repaired += "\\\\";
      state.stringValuePrefix = appendStringValuePrefix(state.stringValuePrefix, "\\");
      index += 1;
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
    state.stringValuePrefix = appendStringValuePrefix(state.stringValuePrefix, char);
    index += 1;
  }

  return { repaired, stringBoundaryCrossed };
}

export function repairJsonChunk(delta: string, state: RepairJsonState, isFinal = false): string {
  return repairJsonChunkCore(delta, state, isFinal).repaired;
}

/**
 * Decodes a fragment of *already-repaired* JSON string content (a `repaired`
 * value returned by `repairJsonChunkCore`, not raw unrepaired input) into the
 * actual runtime characters it represents - the inverse of the escaping
 * `repairJson` performs. Safe to call on a fragment in isolation with no
 * carried-over state, because `repairJsonChunkCore` never returns a fragment
 * ending in a dangling `\` or a partial `\uXXXX`: anything it can't fully
 * resolve yet is held back in `state.pendingRaw` and excluded from the
 * returned text until a later call resolves it. Used by the streaming-preview
 * hot path (see `pushStreamingJsonPreview`) to append newly-arrived string
 * content directly onto the in-progress value instead of a full re-parse.
 */
function decodeRepairedStringFragment(fragment: string): string {
  let decoded = "";
  let index = 0;
  while (index < fragment.length) {
    const char = fragment.charAt(index);
    if (char !== "\\") {
      decoded += char;
      index += 1;
      continue;
    }
    const next = fragment.charAt(index + 1);
    if (next === "u") {
      const hex = fragment.slice(index + 2, index + 6);
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    switch (next) {
      case '"':
        decoded += '"';
        break;
      case "\\":
        decoded += "\\";
        break;
      case "/":
        decoded += "/";
        break;
      case "b":
        decoded += "\b";
        break;
      case "f":
        decoded += "\f";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      default:
        // Should not happen given repairJsonChunkCore's output guarantees
        // (every escape it emits is one of the above), but fail safe rather
        // than silently dropping a character if it ever does.
        decoded += next;
    }
    index += 2;
  }
  return decoded;
}

const JSON_WHITESPACE = /[ \t\n\r]/;

function scanJsonStringSpan(text: string, start: number): number | null {
  let index = start + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') {
      return index + 1;
    }
    index += 1;
  }
  return null;
}

/**
 * The top-level object key whose string *value* is currently open
 * (streaming, not yet closed), together with that value's *authoritative*
 * content decoded directly from the repaired buffer - not from
 * `partial-json`, which deliberately trims trailing whitespace off an
 * unterminated string (it can't tell whether that whitespace is meaningful
 * content or an artifact of the cut ending mid-stream). Recomputing the
 * value this way after every full reparse is what makes the hot path in
 * `pushStreamingJsonPreview` safe to build on: its baseline is always the
 * true accumulated content, so appending further decoded deltas can never
 * silently drop whitespace `partial-json` chose to withhold.
 */
interface OpenTopLevelStringValue {
  key: string;
  value: string;
}

/**
 * Finds the top-level object key/value described above, restricted to the
 * common flat-object shape this fast path targets: a single top-level
 * `{ ... }` whose members are strings/numbers/booleans/null (the shape of
 * essentially every real tool-call-arguments schema, including the
 * large-single-string-field case #53408 and this module exist to fix).
 *
 * Returns `null` whenever that doesn't confidently hold: not an object, a
 * *key* string is still open (only value strings are appendable), a nested
 * object/array member is encountered (out of scope for this fast path - the
 * growth-gated fallback in `pushStreamingJsonPreview` still handles it
 * safely, just without the same zero-staleness guarantee for that nested
 * value), the buffer is between tokens, complete, or malformed.
 *
 * `text` must already be repaired JSON text (see `repairJson`), so any
 * escape sequences within it are well-formed pairs.
 */
function computeOpenTopLevelStringValue(text: string): OpenTopLevelStringValue | null {
  let index = 0;
  const skipWhitespace = () => {
    while (index < text.length && JSON_WHITESPACE.test(text.charAt(index))) {
      index += 1;
    }
  };

  skipWhitespace();
  if (text.charAt(index) !== "{") {
    return null;
  }
  index += 1;

  for (;;) {
    skipWhitespace();
    if (index >= text.length || text.charAt(index) === "}") {
      return null;
    }

    if (text.charAt(index) !== '"') {
      return null;
    }
    const keyEnd = scanJsonStringSpan(text, index);
    if (keyEnd === null) {
      return null; // the key itself is truncated, not a value
    }
    let key: string;
    try {
      key = JSON.parse(text.slice(index, keyEnd)) as string;
    } catch {
      return null;
    }
    index = keyEnd;

    skipWhitespace();
    if (text.charAt(index) !== ":") {
      return null;
    }
    index += 1;
    skipWhitespace();
    if (index >= text.length) {
      return null;
    }

    if (text.charAt(index) === '"') {
      const valueStart = index + 1;
      const valueEnd = scanJsonStringSpan(text, index);
      if (valueEnd === null) {
        // The open, truncated string value: everything after the opening
        // quote to the end of the (repaired) buffer is its raw content so
        // far, since it hasn't closed yet.
        return { key, value: decodeRepairedStringFragment(text.slice(valueStart)) };
      }
      index = valueEnd;
    } else if (text.charAt(index) === "{" || text.charAt(index) === "[") {
      return null; // nested container - out of scope for this fast path
    } else {
      const literalStart = index;
      while (
        index < text.length &&
        text.charAt(index) !== "," &&
        text.charAt(index) !== "}" &&
        !JSON_WHITESPACE.test(text.charAt(index))
      ) {
        index += 1;
      }
      if (index >= text.length || index === literalStart) {
        return null; // literal itself truncated
      }
    }

    skipWhitespace();
    if (index >= text.length) {
      return null;
    }
    if (text.charAt(index) === ",") {
      index += 1;
      continue;
    }
    return null; // "}" (object already fully closed - nothing open) or malformed
  }
}

/**
 * Resolves `state.pendingRaw` (if any) using end-of-stream semantics without
 * committing that resolution to `state` - used to compute "what would
 * `repairJson` produce for the buffer as it stands right now" for a live
 * preview, while leaving the persisted state free to keep waiting for more
 * characters if the stream does in fact continue.
 */
function peekPendingRepairedTail(state: RepairJsonState): string {
  if (!state.pendingRaw) {
    return "";
  }
  const scratch: RepairJsonState = {
    inString: state.inString,
    stringValuePrefix: state.stringValuePrefix,
    pendingRaw: state.pendingRaw,
  };
  return repairJsonChunk("", scratch, true);
}

/**
 * Gates the full JSON.parse/partial-json fallback chain by how much the
 * repaired buffer has *grown* since the last full parse, not by elapsed
 * wall-clock time. Incremental repair (above) already makes the repair step
 * itself O(delta), but JSON.parse/partial-json have no incremental API and
 * must still scan the *entire* buffer on every call.
 *
 * An earlier revision of this gate used a wall-clock interval instead (skip
 * re-parsing if fewer than N ms have passed since the last parse). That only
 * bounds cost for deltas arriving *faster* than the interval: a delta
 * arriving N ms or later after the last parse - an entirely ordinary
 * cadence for network-delivered streams, not a pathological edge case -
 * would still trigger a full reparse of the *entire* accumulated buffer on
 * every single such delta, leaving the O(n^2) behavior this module exists
 * to remove fully intact for that (very realistic) cadence.
 *
 * Requiring the buffer to grow by at least `STREAMING_JSON_REPARSE_GROWTH_FACTOR`
 * (a fraction of the size already parsed) before the *next* full reparse
 * removes cadence from the cost bound entirely: it doesn't matter whether
 * that growth arrives in one delta or ten thousand, or over a millisecond or
 * a minute. Reparses then happen at sizes L, L*(1+f), L*(1+f)^2, ... up to
 * n - the classic amortized-doubling series, whose *sum* is O(n) regardless
 * of delta timing (same trade-off dynamic arrays make when growing by a
 * multiple rather than a fixed increment). `STREAMING_JSON_REPARSE_MIN_GROWTH_BYTES`
 * is just a floor so tiny buffers (where a full reparse is already
 * effectively free) keep refreshing on every delta instead of waiting for a
 * proportionally tiny amount of growth.
 */
export const STREAMING_JSON_REPARSE_GROWTH_FACTOR = 0.5;
export const STREAMING_JSON_REPARSE_MIN_GROWTH_BYTES = 256;

export interface StreamingJsonPreviewState {
  raw: string;
  repairedSoFar: string;
  repairState: RepairJsonState;
  lastParsedLength: number;
  lastParsedValue: Record<string, unknown>;
  /**
   * Top-level object key whose string value is presently open (streaming)
   * and known to be exactly `lastParsedValue[openStringKey]` so far, or
   * `null` when there is no such confidently-known appendable value right
   * now (see `computeOpenTopLevelStringValueKey`). Drives the hot path in
   * `pushStreamingJsonPreview`.
   */
  openStringKey: string | null;
  /**
   * Counts calls to the full JSON.parse/partial-json fallback (i.e. actual
   * `parseStreamingJsonFromParts` invocations), as opposed to hot-path
   * appends or cached-value reuse. Exists so callers/tests can observe the
   * O(n)-total cost guarantee directly instead of inferring it from object
   * identity (the hot path below also returns a fresh object on every call,
   * so identity alone no longer distinguishes "cheap update" from "full
   * reparse" the way it did before this field existed).
   */
  fullReparseCount: number;
}

export function createStreamingJsonPreviewState(): StreamingJsonPreviewState {
  return {
    raw: "",
    repairedSoFar: "",
    repairState: createRepairJsonState(),
    lastParsedLength: 0,
    lastParsedValue: {},
    openStringKey: null,
    fullReparseCount: 0,
  };
}

function runFullReparse(state: StreamingJsonPreviewState, previewRepaired: string): void {
  state.lastParsedLength = previewRepaired.length;
  state.lastParsedValue = parseStreamingJsonFromParts(state.raw, previewRepaired);
  state.fullReparseCount += 1;

  // Deliberately read from `state.repairedSoFar` (only ever committed,
  // fully-resolved characters - see `repairJsonChunkCore`'s contract) and
  // never from `previewRepaired`, which may additionally include a
  // *speculative* "as if the stream ended right now" resolution of a still
  // -pending, ambiguous escape sequence held in `state.repairState.pendingRaw`
  // (e.g. a lone trailing `\` that might become `\n`, `\uXXXX`, etc. once
  // the next character(s) arrive). Baking that speculative guess into
  // `lastParsedValue` would make it the hot path's baseline; when the
  // pending escape later resolves for real via `repairJsonChunkCore`'s own
  // carryover, the hot path would append the correctly-decoded character on
  // top of the earlier speculative one instead of replacing it, duplicating
  // content. Using only the committed buffer avoids this class of bug
  // entirely, since it can never contain an unresolved escape by construction.
  const open = state.repairState.inString
    ? computeOpenTopLevelStringValue(state.repairedSoFar)
    : null;
  if (open === null) {
    state.openStringKey = null;
    return;
  }
  state.openStringKey = open.key;
  // `parseStreamingJsonFromParts` above may have gone through `partial-json`
  // (needed for the rest of the object - fields other than the open string
  // aren't handled by this fast path), which deliberately trims trailing
  // whitespace off an unterminated string. Overwrite that with the
  // authoritative value derived directly from the repaired buffer we own,
  // so both the value returned right now and the hot path's baseline for
  // subsequent deltas are always the true accumulated content - never
  // silently missing whitespace/content partial-json's incomplete-string
  // heuristics withheld.
  state.lastParsedValue = { ...state.lastParsedValue, [open.key]: open.value };
}

/**
 * Incremental, always-live replacement for `buffer += delta;
 * parseStreamingJson(buffer)`.
 *
 * Every delta is incorporated into the repaired buffer immediately (cheap -
 * see `repairJsonChunk`). From there, two mechanisms keep the returned value
 * both current on every delta *and* bounded in total cost:
 *
 * 1. **Hot path** - when this delta is pure interior content for an
 *    already-located, still-open top-level string value (no quote opened or
 *    closed during this delta), the newly-decoded characters are appended
 *    directly onto that field in a shallow-cloned copy of the last
 *    materialized object: O(delta) per call, and the returned value's
 *    content genuinely changes on *every* such delta (no staleness window at
 *    all). This is the dominant case for the shape this module exists to
 *    fix - one large string tool-call argument (e.g. a document body) - and
 *    is why a naive read of "the preview goes stale between full reparses"
 *    no longer applies to it.
 * 2. **Growth-gated full reparse** - for everything the hot path doesn't
 *    cover (a string/key boundary was just crossed, or there is no known
 *    open top-level string value at all - e.g. numbers, nested
 *    objects/arrays, or before the first field starts), a full
 *    JSON.parse/partial-json resolution runs immediately if a string
 *    boundary was crossed (rare relative to payload size for the shapes
 *    this fix targets, so cheap in aggregate) or once the repaired buffer
 *    has grown enough since the last full parse (see the growth-gate
 *    comment above); the previous value is reused otherwise. This keeps the
 *    non-hot-path cases (e.g. a large flat array of many small scalars)
 *    safe from the O(n^2) behavior this module exists to remove, at the
 *    cost of a small, bounded staleness window for *those* cases only.
 *
 * Pass `force: true` (e.g. once streaming for this value has ended) to
 * bypass both and guarantee a fresh full parse.
 */
export function pushStreamingJsonPreview(
  state: StreamingJsonPreviewState,
  delta: string,
  options?: { force?: boolean },
): Record<string, unknown> {
  const force = options?.force ?? false;
  const hotPathKey = !force && state.repairState.inString ? state.openStringKey : null;

  state.raw += delta;
  const { repaired: repairedThisCall, stringBoundaryCrossed } = repairJsonChunkCore(
    delta,
    state.repairState,
    false,
  );
  state.repairedSoFar += repairedThisCall;

  if (hotPathKey !== null && !stringBoundaryCrossed) {
    const addition = decodeRepairedStringFragment(repairedThisCall);
    const existing = state.lastParsedValue[hotPathKey];
    state.lastParsedValue = {
      ...state.lastParsedValue,
      [hotPathKey]: (typeof existing === "string" ? existing : "") + addition,
    };
    // Approximate, growth-gate-only bookkeeping (not relied on for
    // correctness): keeps the gate's math sane for whatever field(s) it
    // ends up covering once this hot streak ends and the slow path resumes.
    state.lastParsedLength += repairedThisCall.length;
    return state.lastParsedValue;
  }

  const previewRepaired = state.repairedSoFar + peekPendingRepairedTail(state.repairState);
  const growthNeeded = Math.max(
    STREAMING_JSON_REPARSE_MIN_GROWTH_BYTES,
    Math.floor(state.lastParsedLength * STREAMING_JSON_REPARSE_GROWTH_FACTOR),
  );
  const growthGateSatisfied =
    state.lastParsedLength === 0 || previewRepaired.length - state.lastParsedLength >= growthNeeded;

  if (!force && !stringBoundaryCrossed && !growthGateSatisfied) {
    return state.lastParsedValue;
  }

  runFullReparse(state, previewRepaired);
  return state.lastParsedValue;
}

/**
 * Forces a final, unthrottled resolution from the complete buffer,
 * definitively resolving any still-pending escape sequence. Call this once
 * streaming for the value has ended (e.g. at content-block-stop /
 * toolcall_end) to guarantee correctness regardless of the hot path or
 * growth gate in `pushStreamingJsonPreview`.
 */
export function finalizeStreamingJsonPreview(
  state: StreamingJsonPreviewState,
): Record<string, unknown> {
  state.repairedSoFar += repairJsonChunk("", state.repairState, true);
  runFullReparse(state, state.repairedSoFar);
  return state.lastParsedValue;
}
