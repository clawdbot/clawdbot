/**
 * Incremental Markdown-protection fast path for the streaming normalizer.
 *
 * The stream normalizer must know whether a candidate tool call sits inside a code
 * region before it may scrub it. Resolving that with a full Markdown parse of the
 * whole accumulated response on every candidate-shaped delta is quadratic, so this
 * tracker carries block state forward as text is appended.
 *
 * Safety contract: this is a *conservative* fast path. It answers only when it can
 * prove the verdict from fence state alone, and reports `undefined` for every shape
 * it does not model (inline code spans, indented code, block quotes, lists). Callers
 * must fall back to the authoritative full parse whenever the answer is `undefined`,
 * so protection semantics stay identical to a full parse.
 */

/** Carried block state at a position in the accumulated response. */
export type ProtectionScanState = {
  /** Fence delimiter of the currently open fenced block, when inside one. */
  fenceChar: "`" | "~" | undefined;
  /** Delimiter run length that opened the current fenced block. */
  fenceLength: number;
  /**
   * Set when the current paragraph contains a construct this tracker does not model.
   * Cleared on a blank line, because none of those constructs span a blank line.
   */
  paragraphAmbiguous: boolean;
  /**
   * Set when a fence delimiter was seen that could not be classified as a clean open or
   * close. Fence parity is then permanently unknown — a later delimiter this tracker
   * would read as an open may really be the close of a fence it skipped — so unlike
   * paragraph ambiguity this never clears.
   */
  structuralUnknown: boolean;
  /** Trailing partial line; block structure is only decidable on whole lines. */
  partialLine: string;
};

export function createProtectionScanState(): ProtectionScanState {
  return {
    fenceChar: undefined,
    fenceLength: 0,
    paragraphAmbiguous: false,
    structuralUnknown: false,
    partialLine: "",
  };
}

export function cloneProtectionScanState(state: ProtectionScanState): ProtectionScanState {
  return { ...state };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** Blank means spaces and tabs only; Unicode spaces do not end a Markdown block. */
const BLANK_LINE = /^[ \t]*$/;
/**
 * A CR that does not begin a CRLF pair. `findPotentialCallStart` treats a bare CR as a
 * line start and the CommonMark resolver ends a line there, but this tracker splits on LF
 * only, so it must decline rather than miss a fence boundary. A chunk that merely ends
 * mid-CRLF also declines, which costs a parse but never correctness.
 */
const BARE_CARRIAGE_RETURN = /\r(?!\n)/;
/** A fence-length delimiter run outside a fence that did not open one at column 0. */
const UNCLASSIFIED_FENCE_DELIMITER = /`{3,}|~{3,}/;
/**
 * Line starts that make indentation or delimiters structural, which this tracker does not
 * model. Indentation counts in columns, so any leading tab qualifies (CommonMark expands
 * one to four columns) and so does any run of four spaces, whatever follows it — including
 * a further tab. Blank lines never reach here; they are handled before this test.
 */
const UNMODELED_BLOCK_START = /^(?: {0,3}(?:>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$))| {4,}| *\t)/;

/** Applies one whole line (newline excluded) to the carried state. */
function applyLine(state: ProtectionScanState, line: string): void {
  if (state.structuralUnknown) {
    return;
  }
  if (state.fenceChar) {
    // Inside a fence only a matching closing delimiter run is structural.
    // Only spaces and tabs may follow a closing fence. `\s` would also match Unicode
    // spaces such as U+00A0, which do NOT close a fence, and wrongly reading the block
    // as closed would scrub literal fenced text.
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    const run = close?.[1];
    if (run && run[0] === state.fenceChar && run.length >= state.fenceLength) {
      state.fenceChar = undefined;
      state.fenceLength = 0;
    }
    return;
  }
  if (BLANK_LINE.test(line)) {
    // A blank line ends every construct that could have made this paragraph ambiguous.
    state.paragraphAmbiguous = false;
    return;
  }
  const open = FENCE_OPEN.exec(line);
  const marker = open?.[1];
  if (marker) {
    // Only track fences that open at column 0 in unambiguous context. A fence indented
    // under a list or quoted in a block quote belongs to that container and ends with it
    // (CommonMark), which this tracker does not model.
    // A backtick fence whose info string contains a backtick is not a fence at all
    // (CommonMark); the line stays paragraph text. Tilde fences allow backticks.
    const infoString = line.slice(open[0].length);
    if (
      state.paragraphAmbiguous ||
      open[0].length !== marker.length ||
      (marker[0] === "`" && infoString.includes("`"))
    ) {
      state.structuralUnknown = true;
      return;
    }
    state.fenceChar = marker[0] === "~" ? "~" : "`";
    state.fenceLength = marker.length;
    return;
  }
  if (UNCLASSIFIED_FENCE_DELIMITER.test(line)) {
    // A delimiter run somewhere this tracker cannot classify leaves parity unknown.
    state.structuralUnknown = true;
    return;
  }
  if (line.includes("`") || UNMODELED_BLOCK_START.test(line)) {
    state.paragraphAmbiguous = true;
  }
}

/** Feeds appended visible text into the carried state. */
export function advanceProtectionScanState(state: ProtectionScanState, text: string): void {
  if (!text) {
    return;
  }
  if (BARE_CARRIAGE_RETURN.test(text)) {
    state.structuralUnknown = true;
    return;
  }
  // `partialLine` never contains a newline (it is always the fragment after the last
  // completed line), so a line can only complete here if `text` itself contains one.
  // Searching `text` alone -- instead of the concatenated `partialLine + text` -- keeps
  // a long newline-free stream (e.g. one long unbroken output line, fed in small
  // provider-sized deltas) linear: otherwise both the concatenation and the indexOf
  // scan below would re-copy and re-scan the ever-growing carried prefix on every call.
  let newline = text.indexOf("\n");
  if (newline === -1) {
    state.partialLine += text;
    return;
  }
  let line = (state.partialLine + text.slice(0, newline)).replace(/\r$/, "");
  applyLine(state, line);
  let cursor = newline + 1;
  newline = text.indexOf("\n", cursor);
  while (newline !== -1) {
    line = text.slice(cursor, newline).replace(/\r$/, "");
    applyLine(state, line);
    cursor = newline + 1;
    newline = text.indexOf("\n", cursor);
  }
  state.partialLine = text.slice(cursor);
}

/**
 * Decides protection for candidate offsets inside `incoming`, given the state carried
 * from the text before it. Returns `undefined` when the answer is not provable from
 * fence state alone, which means the caller must run the authoritative full parse.
 */
export function resolveProtectionFastPath(
  carried: ProtectionScanState,
  incoming: string,
): ((offset: number) => boolean) | undefined {
  if (carried.paragraphAmbiguous || carried.structuralUnknown) {
    return undefined;
  }
  if (BARE_CARRIAGE_RETURN.test(incoming)) {
    return undefined;
  }
  // Walk `incoming` once on a copy, recording the verdict at each line start it exposes.
  // The caller advances the real state separately, so this must not mutate it.
  const state = cloneProtectionScanState(carried);
  const lineStarts: Array<[start: number, isProtected: boolean]> = [];
  let index = 0;
  let lineStart = 0;
  for (;;) {
    if (index >= incoming.length && !state.partialLine) {
      // Nothing follows the final newline, so no offset can be queried past it. Stop
      // instead of treating the empty tail as an unfinished line and forcing a parse.
      break;
    }
    const newline = incoming.indexOf("\n", index);
    const complete = newline !== -1;
    const line =
      `${state.partialLine}${incoming.slice(index, complete ? newline : undefined)}`.replace(
        /\r$/,
        "",
      );
    // Offsets are reported relative to `incoming`; a carried partial line began before it.
    const lineStartAbsolute = lineStart - state.partialLine.length;
    if (state.fenceChar) {
      // Fenced content and its delimiter lines all sit inside the code region, so the
      // verdict holds without needing to see the rest of the line.
      lineStarts.push([lineStartAbsolute, true]);
    } else if (!complete) {
      // Outside a fence an unfinished line could still open one or turn out to be
      // indented or inline code. Yield to the authoritative parse.
      return undefined;
    } else {
      const probe = cloneProtectionScanState(state);
      applyLine(probe, line);
      if (probe.paragraphAmbiguous || probe.structuralUnknown) {
        return undefined;
      }
      const opened = probe.fenceChar ? FENCE_OPEN.exec(line) : null;
      if (opened?.[1]) {
        // The region starts at the delimiter run, so an indented fence leaves its own
        // leading whitespace outside the region.
        lineStarts.push([lineStartAbsolute, false]);
        lineStarts.push([lineStartAbsolute + (opened[0].length - opened[1].length), true]);
      } else {
        lineStarts.push([lineStartAbsolute, false]);
      }
    }
    if (!complete) {
      break;
    }
    applyLine(state, line);
    if (state.paragraphAmbiguous || state.structuralUnknown) {
      return undefined;
    }
    state.partialLine = "";
    index = newline + 1;
    lineStart = index;
    if (index > incoming.length) {
      break;
    }
  }
  // Callers only ever query at successive candidate offsets from a single left-to-right
  // scan (findPotentialCallStart), so offsets seen here are non-decreasing. A cursor that
  // only advances keeps total lookup work linear in lineStarts across the whole scan; a
  // fresh scan from the start on every call would make a large authoritative snapshot with
  // many candidates quadratic (lines x candidates) instead.
  let cursor = -1;
  let isProtected = false;
  return (offset: number) => {
    // Candidate offsets sit at a line start; the nearest preceding start owns the verdict.
    while (cursor + 1 < lineStarts.length) {
      const next = lineStarts[cursor + 1];
      if (next === undefined || next[0] > offset) {
        break;
      }
      cursor += 1;
      isProtected = next[1];
    }
    return isProtected;
  };
}
