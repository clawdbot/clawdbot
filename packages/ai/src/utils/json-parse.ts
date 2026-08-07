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
export function repairJsonChunk(delta: string, state: RepairJsonState, isFinal = false): string {
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
 * Below this interval, skip re-running the full JSON.parse/partial-json
 * fallback chain and reuse the last computed preview value. Incremental
 * repair (above) already makes the repair step itself O(delta), but
 * JSON.parse/partial-json have no incremental API and must still scan the
 * *entire* buffer on every call, so calling them once per (potentially
 * tiny, sub-millisecond-apart) delta is still O(n^2) in aggregate for very
 * large arguments. 20ms is far below anything a human or a downstream
 * consumer could perceive as "stale" (60fps rendering is ~16ms/frame), so
 * in practice this never visibly freezes the preview the way a size-based
 * cutoff would - it only bounds the worst case for pathologically large or
 * fast-arriving arguments.
 */
export const MIN_STREAMING_JSON_REPARSE_INTERVAL_MS = 20;

export interface StreamingJsonPreviewState {
  raw: string;
  repairedSoFar: string;
  repairState: RepairJsonState;
  lastParseAt: number;
  lastParsedValue: Record<string, unknown>;
}

export function createStreamingJsonPreviewState(): StreamingJsonPreviewState {
  return {
    raw: "",
    repairedSoFar: "",
    repairState: createRepairJsonState(),
    lastParseAt: 0,
    lastParsedValue: {},
  };
}

/**
 * Incremental, always-live replacement for `buffer += delta;
 * parseStreamingJson(buffer)`. Every delta is incorporated into the repaired
 * buffer immediately (cheap - see `repairJsonChunk`); the full
 * JSON.parse/partial-json resolution is refreshed on every call unless one
 * already ran within the last `MIN_STREAMING_JSON_REPARSE_INTERVAL_MS`, in
 * which case the previous value is reused. Pass `force: true` (e.g. once
 * streaming for this value has ended) to bypass the interval and guarantee a
 * fresh parse.
 */
export function pushStreamingJsonPreview(
  state: StreamingJsonPreviewState,
  delta: string,
  options?: { force?: boolean; now?: number },
): Record<string, unknown> {
  state.raw += delta;
  state.repairedSoFar += repairJsonChunk(delta, state.repairState, false);

  const now = options?.now ?? Date.now();
  const force = options?.force ?? false;
  if (
    !force &&
    state.lastParseAt !== 0 &&
    now - state.lastParseAt < MIN_STREAMING_JSON_REPARSE_INTERVAL_MS
  ) {
    return state.lastParsedValue;
  }

  state.lastParseAt = now;
  const previewRepaired = state.repairedSoFar + peekPendingRepairedTail(state.repairState);
  state.lastParsedValue = parseStreamingJsonFromParts(state.raw, previewRepaired);
  return state.lastParsedValue;
}

/**
 * Forces a final, unthrottled resolution from the complete buffer,
 * definitively resolving any still-pending escape sequence. Call this once
 * streaming for the value has ended (e.g. at content-block-stop /
 * toolcall_end) to guarantee correctness regardless of the reparse-interval
 * cap in `pushStreamingJsonPreview`.
 */
export function finalizeStreamingJsonPreview(
  state: StreamingJsonPreviewState,
): Record<string, unknown> {
  state.repairedSoFar += repairJsonChunk("", state.repairState, true);
  state.lastParseAt = Date.now();
  state.lastParsedValue = parseStreamingJsonFromParts(state.raw, state.repairedSoFar);
  return state.lastParsedValue;
}
