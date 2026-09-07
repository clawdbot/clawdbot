import { scanFenceSpans, type FenceScanState, type FenceSpan } from "./fences.js";

/** Incremental inline-code scanner state carried across chunk boundaries. */
export type InlineCodeState = {
  /** Whether the current scan is inside an unterminated inline code span. */
  open: boolean;
  /** Backtick run length required to close the current inline code span. */
  ticks: number;
};

/** Creates the carry-forward state used when scanning inline code across chunks. */
export function createInlineCodeState(): InlineCodeState {
  return { open: false, ticks: 0 };
}

type CodeSpan = Pick<FenceSpan, "start" | "end">;

type InlineCodeSpansResult = {
  spans: CodeSpan[];
  state: InlineCodeState;
};

type CodeSpanIndex = {
  /** Inline-code state to carry into the next streamed chunk. */
  inlineState: InlineCodeState;
  /** Fenced-code state to carry into the next streamed chunk. */
  fenceState: FenceScanState;
  /** True when an offset is inside fenced code or inline code. */
  isInside: (index: number) => boolean;
};

/** Builds a lookup for fenced and inline code spans while preserving scanner state. */
export function buildCodeSpanIndex(
  text: string,
  inlineState?: InlineCodeState,
  fenceState?: FenceScanState,
): CodeSpanIndex {
  const { spans: fenceSpans, state: nextFenceState } = scanFenceSpans(text, fenceState);
  const startState = inlineState
    ? { open: inlineState.open, ticks: inlineState.ticks }
    : createInlineCodeState();
  const { spans: inlineSpans, state: nextInlineState } = parseInlineCodeSpans(
    text,
    fenceSpans,
    startState,
  );

  return {
    inlineState: nextInlineState,
    fenceState: nextFenceState,
    // Each scanner emits ordered, disjoint spans; inline spans can enclose fences.
    // Search separately so overlap between the lists cannot hide a containing span.
    isInside: (index: number) =>
      isInsideSpan(index, fenceSpans) || isInsideSpan(index, inlineSpans),
  };
}

function parseInlineCodeSpans(
  text: string,
  fenceSpans: FenceSpan[],
  initialState: InlineCodeState,
): InlineCodeSpansResult {
  const spans: CodeSpan[] = [];
  let open = initialState.open;
  let ticks = initialState.ticks;
  let openStart = open ? 0 : -1;

  let i = 0;
  // The scanner emits ordered, disjoint fences and the input cursor only advances.
  // Retire each fence once instead of searching all prior fences at every character.
  let fenceIndex = 0;
  while (i < text.length) {
    const fence = fenceSpans[fenceIndex];
    if (fence && i >= fence.start) {
      i = fence.end;
      fenceIndex += 1;
      continue;
    }

    if (text[i] !== "`") {
      i += 1;
      continue;
    }

    const runStart = i;
    let runLength = 0;
    while (i < text.length && text[i] === "`") {
      runLength += 1;
      i += 1;
    }

    if (!open) {
      open = true;
      ticks = runLength;
      openStart = runStart;
      continue;
    }

    if (runLength === ticks) {
      spans.push({ start: openStart, end: i });
      open = false;
      ticks = 0;
      openStart = -1;
    }
  }

  if (open) {
    spans.push({ start: openStart, end: text.length });
  }

  return {
    spans,
    state: { open, ticks },
  };
}

function isInsideSpan(index: number, spans: CodeSpan[]): boolean {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const span = spans[middle];
    if (!span) {
      return false;
    }
    if (index >= span.end) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const span = spans[low];
  return span !== undefined && index >= span.start && index < span.end;
}
