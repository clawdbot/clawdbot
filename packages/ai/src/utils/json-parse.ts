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
function repairJsonChunkCore(delta: string, state: RepairJsonState, isFinal: boolean): string {
  const input = state.pendingRaw + delta;
  state.pendingRaw = "";
  let repaired = "";
  let index = 0;

  while (index < input.length) {
    const char = input.charAt(index);

    if (!state.inString) {
      repaired += char;
      if (char === '"') {
        state.inString = true;
        state.stringValuePrefix = "";
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      repaired += char;
      state.inString = false;
      state.stringValuePrefix = "";
      index += 1;
      continue;
    }

    if (char === "\\") {
      const nextChar = input.charAt(index + 1);
      if (!nextChar) {
        if (!isFinal) {
          state.pendingRaw = input.slice(index);
          return repaired;
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
          return repaired;
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

  return repaired;
}

export function repairJsonChunk(delta: string, state: RepairJsonState, isFinal = false): string {
  return repairJsonChunkCore(delta, state, isFinal);
}

/**
 * Decodes a fragment of *already-repaired* JSON string content (a `repaired`
 * value returned by `repairJsonChunkCore`, not raw unrepaired input) into the
 * actual runtime characters it represents - the inverse of the escaping
 * `repairJson` performs. Safe to call on a fragment in isolation with no
 * carried-over state, because `repairJsonChunkCore` never returns a fragment
 * ending in a dangling `\` or a partial `\uXXXX`: anything it can't fully
 * resolve yet is held back in `state.pendingRaw` and excluded from the
 * returned text until a later call resolves it. Used by the streaming
 * preview's structural tracker (see `advanceTopLevelObjectTracker`) to build
 * keys and values from the deltas themselves instead of re-parsing.
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

/**
 * Reads a run of *already-repaired* JSON string content starting at `start`
 * (which must be inside a string), stopping at the closing quote or the end
 * of the fragment - whichever comes first. Escape pairs are skipped whole so
 * an escaped quote never looks like a terminator.
 *
 * No carried-over state is needed across calls because
 * `repairJsonChunkCore` never returns a fragment ending mid-escape: a lone
 * trailing `\` or a partial `\uXXXX` is held back in `state.pendingRaw`
 * until later input resolves it.
 */
function readRepairedStringRun(
  text: string,
  start: number,
): { text: string; next: number; closed: boolean } {
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += text.charAt(index + 1) === "u" ? 6 : 2;
      continue;
    }
    if (char === '"') {
      return { text: text.slice(start, index), next: index + 1, closed: true };
    }
    index += 1;
  }
  return { text: text.slice(start), next: text.length, closed: false };
}

type TopLevelObjectPhase =
  | "beforeRoot"
  | "beforeKey"
  | "inKey"
  | "afterKey"
  | "beforeValue"
  | "inStringValue"
  | "inLiteralValue"
  | "afterValue"
  | "afterRoot"
  | "unsupported";

/**
 * Resumable structural scan of the top-level object, advanced by the same
 * repaired characters `repairJsonChunkCore` has just committed and never by
 * re-reading the buffer. It exists so that *nothing* about a streaming
 * preview needs a whole-buffer pass in the common case.
 *
 * `JSON.parse`/`partial-json` have no incremental API, so calling them per
 * delta is inherently O(buffer) each time - the quadratic behavior this
 * module exists to remove. A previous iteration of this file avoided that
 * only for the interior of one large string value, and still fell back to a
 * full re-parse every time a quote opened or closed a field. That is fine
 * for one huge argument, but it silently restores the quadratic cost for an
 * equally ordinary shape - a wide object of many short string fields
 * (`{"a":"1","b":"2",...}`), where a boundary is crossed every few
 * characters.
 *
 * Tracking the structure incrementally removes that asymmetry: string keys
 * and string values are materialized directly from the decoded deltas, so a
 * flat object of string fields - the shape of essentially every real
 * tool-call argument schema - is handled end to end in O(delta) per call
 * with no whole-buffer pass at all, and no staleness at any point.
 *
 * Shapes it deliberately does not model are handed back to the (bounded)
 * full re-parse fallback rather than guessed at:
 * - `unsupported` (a non-object root, a nested object/array, or malformed
 *   input): `fields` is abandoned entirely and the fallback owns the value.
 * - `sawUntrackedValue` (a number/boolean/null member): those members are
 *   skipped structurally so string members keep streaming live, but the
 *   fallback still has to supply their parsed values.
 */
interface TopLevelObjectTracker {
  phase: TopLevelObjectPhase;
  /** Repaired (still-escaped) text of the key currently being read. */
  keyRepaired: string;
  /** Decoded key whose string value is open right now, else `null`. */
  openKey: string | null;
  /** Decoded values of every top-level string member seen so far. */
  fields: Map<string, string>;
  /** A non-string member was skipped, so `fields` alone is incomplete. */
  sawUntrackedValue: boolean;
}

function createTopLevelObjectTracker(): TopLevelObjectTracker {
  return {
    phase: "beforeRoot",
    keyRepaired: "",
    openKey: null,
    fields: new Map(),
    sawUntrackedValue: false,
  };
}

/**
 * Advances the tracker over one freshly-repaired fragment. Only ever scans
 * `repaired`, never the accumulated buffer.
 */
function advanceTopLevelObjectTracker(tracker: TopLevelObjectTracker, repaired: string): void {
  let index = 0;
  while (index < repaired.length) {
    const char = repaired.charAt(index);
    switch (tracker.phase) {
      case "beforeRoot": {
        if (JSON_WHITESPACE.test(char)) {
          index += 1;
        } else if (char === "{") {
          tracker.phase = "beforeKey";
          index += 1;
        } else {
          tracker.phase = "unsupported";
          return;
        }
        break;
      }
      case "beforeKey": {
        if (JSON_WHITESPACE.test(char)) {
          index += 1;
        } else if (char === "}") {
          tracker.phase = "afterRoot";
          index += 1;
        } else if (char === '"') {
          tracker.phase = "inKey";
          tracker.keyRepaired = "";
          index += 1;
        } else {
          tracker.phase = "unsupported";
          return;
        }
        break;
      }
      case "inKey": {
        const run = readRepairedStringRun(repaired, index);
        tracker.keyRepaired += run.text;
        index = run.next;
        if (run.closed) {
          tracker.phase = "afterKey";
        }
        break;
      }
      case "afterKey": {
        if (JSON_WHITESPACE.test(char)) {
          index += 1;
        } else if (char === ":") {
          tracker.phase = "beforeValue";
          index += 1;
        } else {
          tracker.phase = "unsupported";
          return;
        }
        break;
      }
      case "beforeValue": {
        if (JSON_WHITESPACE.test(char)) {
          index += 1;
          break;
        }
        if (char === '"') {
          const key = decodeRepairedStringFragment(tracker.keyRepaired);
          tracker.openKey = key;
          tracker.fields.set(key, "");
          tracker.phase = "inStringValue";
          index += 1;
          break;
        }
        if (char === "{" || char === "[") {
          tracker.phase = "unsupported";
          return;
        }
        // A number/boolean/null: skipped structurally below, without
        // consuming this character.
        tracker.sawUntrackedValue = true;
        tracker.phase = "inLiteralValue";
        break;
      }
      case "inStringValue": {
        const run = readRepairedStringRun(repaired, index);
        const key = tracker.openKey;
        if (key !== null && run.text !== "") {
          tracker.fields.set(
            key,
            (tracker.fields.get(key) ?? "") + decodeRepairedStringFragment(run.text),
          );
        }
        index = run.next;
        if (run.closed) {
          tracker.openKey = null;
          tracker.phase = "afterValue";
        }
        break;
      }
      case "inLiteralValue": {
        if (char === "," || char === "}" || JSON_WHITESPACE.test(char)) {
          tracker.phase = "afterValue"; // re-read this character as a separator
        } else {
          index += 1;
        }
        break;
      }
      case "afterValue": {
        if (JSON_WHITESPACE.test(char)) {
          index += 1;
        } else if (char === ",") {
          tracker.phase = "beforeKey";
          index += 1;
        } else if (char === "}") {
          tracker.phase = "afterRoot";
          index += 1;
        } else {
          tracker.phase = "unsupported";
          return;
        }
        break;
      }
      case "afterRoot": {
        if (JSON_WHITESPACE.test(char)) {
          index += 1;
          break;
        }
        tracker.phase = "unsupported";
        return;
      }
      default:
        return;
    }
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

/**
 * Second, independent bound on the same full-reparse fallback, expressed as
 * total work rather than spacing: the sum of all bytes ever re-scanned by the
 * fallback is kept at or below this multiple of the buffer's current size.
 *
 * The growth gate above bounds cost by making reparses *rare* as the buffer
 * grows, but it can only do that by refusing to refresh, which costs
 * liveness. That trade is wrong while the buffer is still small (a reparse of
 * 40 bytes is free, yet the gate would withhold it for the next 256 bytes)
 * and it is wrong again after a long stretch carried entirely by the
 * incremental tracker, since no reparse budget was actually spent during
 * that stretch.
 *
 * So a reparse also runs whenever this budget still has room, regardless of
 * spacing. The bound holds by construction: a reparse is only admitted while
 * `reparsedCharsTotal <= (FACTOR - 1) * length`, and it then adds exactly
 * `length`, so `reparsedCharsTotal` can never exceed `FACTOR * n` for a
 * final buffer of size `n`. Total fallback work is therefore O(n) for every
 * input shape - there is no delta, and no structural event, that can opt out
 * of both bounds.
 */
export const STREAMING_JSON_REPARSE_WORK_BUDGET_FACTOR = 8;

export interface StreamingJsonPreviewState {
  raw: string;
  repairedSoFar: string;
  repairState: RepairJsonState;
  lastParsedLength: number;
  lastParsedValue: Record<string, unknown>;
  /**
   * Incremental structural view of the buffer, and the authoritative source
   * for every top-level string member (see `TopLevelObjectTracker`).
   */
  tracker: TopLevelObjectTracker;
  /**
   * Counts calls to the full JSON.parse/partial-json fallback (i.e. actual
   * `parseStreamingJsonFromParts` invocations), as opposed to deltas served
   * entirely from the incremental tracker. Exists so callers/tests can
   * observe the cost guarantee directly instead of inferring it from object
   * identity (a fresh object is returned on every call that changes the
   * value, so identity alone says nothing about which path ran).
   */
  fullReparseCount: number;
  /**
   * Total characters re-scanned by the full fallback so far, i.e. the sum of
   * the buffer sizes it has been handed. Drives the work budget described on
   * `STREAMING_JSON_REPARSE_WORK_BUDGET_FACTOR`, and lets tests assert the
   * O(n) total-work guarantee directly rather than inferring it from a
   * reparse count (which says nothing about how large each reparse was).
   */
  reparsedCharsTotal: number;
}

export function createStreamingJsonPreviewState(): StreamingJsonPreviewState {
  return {
    raw: "",
    repairedSoFar: "",
    repairState: createRepairJsonState(),
    lastParsedLength: 0,
    lastParsedValue: {},
    tracker: createTopLevelObjectTracker(),
    fullReparseCount: 0,
    reparsedCharsTotal: 0,
  };
}

/**
 * The value to expose right now: the tracker's live string members layered
 * over whatever the last full reparse produced.
 *
 * The tracker wins on conflicts, and deliberately so. `partial-json` trims
 * trailing whitespace off a string it can see is unterminated, because it
 * cannot tell meaningful content from formatting before the close; the
 * tracker knows the literal characters that actually arrived, so `"hi "`
 * stays `"hi "` instead of collapsing to `"hi"` mid-stream. The reparse
 * still supplies everything the tracker does not model (numbers, booleans,
 * null, nested containers).
 */
function materializeStreamingJsonPreview(
  state: StreamingJsonPreviewState,
): Record<string, unknown> {
  if (state.tracker.phase === "unsupported") {
    return state.lastParsedValue;
  }
  const value: Record<string, unknown> = { ...state.lastParsedValue };
  for (const [key, text] of state.tracker.fields) {
    value[key] = text;
  }
  return value;
}

/**
 * True when the tracker alone cannot account for the whole buffer, so the
 * exposed value depends on a `JSON.parse`/`partial-json` pass being
 * reasonably fresh.
 */
function needsFullReparse(state: StreamingJsonPreviewState): boolean {
  return state.tracker.phase === "unsupported" || state.tracker.sawUntrackedValue;
}

function runFullReparse(state: StreamingJsonPreviewState, previewRepaired: string): void {
  // Note this is handed `previewRepaired` rather than `state.repairedSoFar`:
  // it may include a *speculative* "as if the stream ended right now"
  // resolution of an ambiguous escape still held in
  // `state.repairState.pendingRaw` (a lone trailing `\` that may yet become
  // `\n`, `\uXXXX`, ...). That is safe here precisely because nothing
  // incremental is seeded from the result - the tracker advances only on
  // committed characters and overwrites every string member it owns in
  // `materializeStreamingJsonPreview`, so a speculative resolution can never
  // become the baseline for a later append and be counted twice.
  state.lastParsedLength = previewRepaired.length;
  state.lastParsedValue = parseStreamingJsonFromParts(state.raw, previewRepaired);
  state.fullReparseCount += 1;
  state.reparsedCharsTotal += previewRepaired.length;
  if (state.tracker.phase !== "inLiteralValue") {
    // Every non-string member seen so far is now materialized in
    // `lastParsedValue`, so the tracker's gap is closed until the next one.
    state.tracker.sawUntrackedValue = false;
  }
}

/**
 * Incremental, always-live replacement for `buffer += delta;
 * parseStreamingJson(buffer)`, whose total cost is quadratic in the
 * argument size because every delta re-scans the entire buffer.
 *
 * Two layers replace that:
 *
 * 1. **Incremental tracking** - the delta is repaired resuming from the
 *    saved repair state (`repairJsonChunk`), then fed to the structural
 *    tracker (`advanceTopLevelObjectTracker`). Both are O(delta). For a flat
 *    top-level object of string members - the shape of essentially every
 *    real tool-call argument schema, whether that is one huge document body
 *    or fifty short fields - this alone produces the complete, exact value,
 *    so no whole-buffer pass runs at all and there is no staleness window
 *    anywhere in the stream.
 * 2. **Bounded full reparse** - only for what the tracker deliberately does
 *    not model (numbers/booleans/null, nested objects or arrays, non-object
 *    or malformed roots). Those still need `JSON.parse`/`partial-json`,
 *    which has no incremental API, so the pass is admitted only when the
 *    cumulative-growth gate or the linear work budget allows it (see the two
 *    constants above); otherwise the previous value is reused. No delta and
 *    no structural event can opt out of both bounds, so total fallback work
 *    is O(n) for every input shape - the price being a bounded staleness
 *    window for those unmodelled members only.
 *
 * Pass `force: true` to bypass the bounds and guarantee a fresh full parse.
 */
export function pushStreamingJsonPreview(
  state: StreamingJsonPreviewState,
  delta: string,
  options?: { force?: boolean },
): Record<string, unknown> {
  state.raw += delta;
  const repairedThisCall = repairJsonChunkCore(delta, state.repairState, false);
  state.repairedSoFar += repairedThisCall;
  advanceTopLevelObjectTracker(state.tracker, repairedThisCall);

  const force = options?.force ?? false;
  if (!force && !needsFullReparse(state)) {
    return materializeStreamingJsonPreview(state);
  }

  const previewRepaired = state.repairedSoFar + peekPendingRepairedTail(state.repairState);
  const growthNeeded = Math.max(
    STREAMING_JSON_REPARSE_MIN_GROWTH_BYTES,
    Math.floor(state.lastParsedLength * STREAMING_JSON_REPARSE_GROWTH_FACTOR),
  );
  const growthGateSatisfied =
    state.lastParsedLength === 0 || previewRepaired.length - state.lastParsedLength >= growthNeeded;
  const workBudgetAvailable =
    state.reparsedCharsTotal <=
    (STREAMING_JSON_REPARSE_WORK_BUDGET_FACTOR - 1) * previewRepaired.length;

  if (force || growthGateSatisfied || workBudgetAvailable) {
    runFullReparse(state, previewRepaired);
  }
  return materializeStreamingJsonPreview(state);
}

/**
 * Forces a final, unthrottled resolution from the complete buffer,
 * definitively resolving any still-pending escape sequence. Call this once
 * streaming for the value has ended (e.g. at content-block-stop /
 * toolcall_end) to guarantee correctness regardless of the reparse bounds
 * applied while streaming.
 */
export function finalizeStreamingJsonPreview(
  state: StreamingJsonPreviewState,
): Record<string, unknown> {
  const finalRepaired = repairJsonChunk("", state.repairState, true);
  state.repairedSoFar += finalRepaired;
  advanceTopLevelObjectTracker(state.tracker, finalRepaired);
  runFullReparse(state, state.repairedSoFar);
  return materializeStreamingJsonPreview(state);
}

/**
 * The supported, provider-plugin-facing form of the streaming preview: one
 * opaque object per streamed tool call, with no mutable state struct crossing
 * the boundary. This is what `openclaw/plugin-sdk/llm` re-exports; the
 * `*StreamingJsonPreviewState` functions above stay host-internal so their
 * fields remain free to change without breaking installed plugins.
 */
export interface StreamingJsonPreview {
  /**
   * Accumulates one streamed fragment of a tool call's JSON arguments and
   * returns the arguments as they stand now. Replaces the
   * `buffer += delta; parseStreamingJson(buffer)` pattern, whose total cost
   * is quadratic in the argument size; the returned object is a fresh value
   * each call and must not be mutated.
   */
  push(delta: string): Record<string, unknown>;
  /**
   * Resolves the complete buffer once streaming for this tool call has ended
   * (e.g. at content-block-stop). Always performs a full, unthrottled parse,
   * so the final arguments never depend on the bounds applied while
   * streaming. Call exactly once, after the last `push`.
   */
  finalize(): Record<string, unknown>;
}

export function createStreamingJsonPreview(): StreamingJsonPreview {
  const state = createStreamingJsonPreviewState();
  return {
    push: (delta) => pushStreamingJsonPreview(state, delta),
    finalize: () => finalizeStreamingJsonPreview(state),
  };
}
