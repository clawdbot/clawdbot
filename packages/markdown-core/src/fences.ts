/** Markdown fenced-code block span with the opener data needed to reopen it. */
export type FenceSpan = {
  start: number;
  end: number;
  openLine: string;
  marker: string;
  indent: string;
};

/** Streaming fence scanner state carried across partial markdown chunks. */
export type FenceScanState = {
  atLineStart?: boolean;
  open?: {
    markerChar: string;
    markerLen: number;
    openLine: string;
    marker: string;
    indent: string;
  };
};

// LF alone defines scanner lines; consume CRLF's CR for raw offsets, not opener text.
const FENCE_LINE_RE = /(?:^|\n)( {0,3})(`{3,}|~{3,})([^\r\n\u2028\u2029]*)\r?(?=\n|$)/g;
const SINGLE_LINE_FENCE_RE = new RegExp(FENCE_LINE_RE, "gy");

/** Scans fenced-code spans incrementally so chunking can carry an open fence forward. */
export function scanFenceSpans(
  buffer: string,
  state?: FenceScanState,
): { spans: FenceSpan[]; state: FenceScanState } {
  const spans: FenceSpan[] = [];
  const startsAtLineStart = state?.atLineStart ?? true;
  let open:
    | {
        start: number;
        markerChar: string;
        markerLen: number;
        openLine: string;
        marker: string;
        indent: string;
      }
    | undefined = state?.open ? { ...state.open, start: 0 } : undefined;

  // Without LF, only offset zero can be a fence. Sticky matching skips long prose,
  // including inline marker literals; matchAll leaves both shared patterns untouched.
  const pattern = buffer.includes("\n") ? FENCE_LINE_RE : SINGLE_LINE_FENCE_RE;
  for (const match of buffer.matchAll(pattern)) {
    const [, indent, marker, trailing] = match;
    if (indent === undefined || marker === undefined || trailing === undefined) {
      continue;
    }
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    if (start === 0 && !startsAtLineStart) {
      continue;
    }
    const markerChar = marker.charAt(0);
    const markerLen = marker.length;
    if (!open) {
      open = {
        start,
        markerChar,
        markerLen,
        openLine: `${indent}${marker}${trailing}`,
        marker,
        indent,
      };
    } else if (
      open.markerChar === markerChar &&
      markerLen >= open.markerLen &&
      /^[ \t]*$/.test(trailing)
    ) {
      // CommonMark permits only spaces or tabs after a closing fence. A marker line carrying
      // other trailing text is code content, not a close, so it must not end the block.
      spans.push({
        start: open.start,
        end: match.index + match[0].length,
        openLine: open.openLine,
        marker: open.marker,
        indent: open.indent,
      });
      open = undefined;
    }
  }

  if (open) {
    spans.push({
      start: open.start,
      end: buffer.length,
      openLine: open.openLine,
      marker: open.marker,
      indent: open.indent,
    });
  }

  const atLineStart = buffer.length === 0 ? startsAtLineStart : buffer.endsWith("\n");
  const nextState: FenceScanState = {
    atLineStart,
    ...(open
      ? {
          open: {
            markerChar: open.markerChar,
            markerLen: open.markerLen,
            openLine: open.openLine,
            marker: open.marker,
            indent: open.indent,
          },
        }
      : {}),
  };
  return { spans, state: nextState };
}

/** Parses all fenced-code spans in a complete markdown buffer. */
export function parseFenceSpans(buffer: string): FenceSpan[] {
  return scanFenceSpans(buffer).spans;
}

/** Looks up the fence containing an offset; spans must be sorted by start offset. */
export function findFenceSpanAt(spans: FenceSpan[], index: number): FenceSpan | undefined {
  let low = 0;
  let high = spans.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const span = spans[mid];
    if (!span) {
      break;
    }
    if (index <= span.start) {
      high = mid - 1;
      continue;
    }
    if (index >= span.end) {
      low = mid + 1;
      continue;
    }
    return span;
  }

  return undefined;
}

/** True when a chunk boundary would not split a fenced-code block. */
export function isSafeFenceBreak(spans: FenceSpan[], index: number): boolean {
  return !findFenceSpanAt(spans, index);
}
