export type BlockReplyChunking = {
  minChars: number;
  maxChars: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
};

type FenceSpan = {
  start: number;
  end: number;
  openLine: string;
  marker: string;
  indent: string;
};

type FenceSplit = {
  closeFenceLine: string;
  reopenFenceLine: string;
};

type BreakResult = {
  index: number;
  fenceSplit?: FenceSplit;
};

export class EmbeddedBlockChunker {
  #buffer = "";
  readonly #chunking: BlockReplyChunking;

  constructor(chunking: BlockReplyChunking) {
    this.#chunking = chunking;
  }

  append(text: string) {
    if (!text) return;
    this.#buffer += text;
  }

  reset() {
    this.#buffer = "";
  }

  get bufferedText() {
    return this.#buffer;
  }

  hasBuffered(): boolean {
    return this.#buffer.length > 0;
  }

  drain(params: { force: boolean; emit: (chunk: string) => void }) {
    // KNOWN: We cannot split inside fenced code blocks (Markdown breaks + UI glitches).
    // When forced (maxChars), we close + reopen the fence to keep Markdown valid.
    const { force, emit } = params;
    const minChars = Math.max(1, Math.floor(this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));
    if (this.#buffer.length < minChars && !force) return;

    while (
      this.#buffer.length >= minChars ||
      (force && this.#buffer.length > 0)
    ) {
      const breakResult =
        force && this.#buffer.length <= maxChars
          ? this.#pickSoftBreakIndex(this.#buffer, 1)
          : this.#pickBreakIndex(this.#buffer);
      if (breakResult.index <= 0) {
        if (force) {
          emit(this.#buffer);
          this.#buffer = "";
        }
        return;
      }

      const breakIdx = breakResult.index;
      let rawChunk = this.#buffer.slice(0, breakIdx);
      if (rawChunk.trim().length === 0) {
        this.#buffer = stripLeadingNewlines(
          this.#buffer.slice(breakIdx),
        ).trimStart();
        continue;
      }

      let nextBuffer = this.#buffer.slice(breakIdx);
      const fenceSplit = breakResult.fenceSplit;
      if (fenceSplit) {
        const closeFence = rawChunk.endsWith("\n")
          ? `${fenceSplit.closeFenceLine}\n`
          : `\n${fenceSplit.closeFenceLine}\n`;
        rawChunk = `${rawChunk}${closeFence}`;

        const reopenFence = fenceSplit.reopenFenceLine.endsWith("\n")
          ? fenceSplit.reopenFenceLine
          : `${fenceSplit.reopenFenceLine}\n`;
        nextBuffer = `${reopenFence}${nextBuffer}`;
      }

      emit(rawChunk);

      if (fenceSplit) {
        this.#buffer = nextBuffer;
      } else {
        const nextStart =
          breakIdx < this.#buffer.length && /\s/.test(this.#buffer[breakIdx])
            ? breakIdx + 1
            : breakIdx;
        this.#buffer = stripLeadingNewlines(this.#buffer.slice(nextStart));
      }

      if (this.#buffer.length < minChars && !force) return;
      if (this.#buffer.length < maxChars && !force) return;
    }
  }

  #pickSoftBreakIndex(buffer: string, minCharsOverride?: number): BreakResult {
    const minChars = Math.max(
      1,
      Math.floor(minCharsOverride ?? this.#chunking.minChars),
    );
    if (buffer.length < minChars) return { index: -1 };
    const fenceSpans = parseFenceSpans(buffer);
    const preference = this.#chunking.breakPreference ?? "paragraph";

    if (preference === "paragraph") {
      let paragraphIdx = buffer.indexOf("\n\n");
      while (paragraphIdx !== -1) {
        if (paragraphIdx >= minChars && isSafeBreak(fenceSpans, paragraphIdx)) {
          return { index: paragraphIdx };
        }
        paragraphIdx = buffer.indexOf("\n\n", paragraphIdx + 2);
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        if (newlineIdx >= minChars && isSafeBreak(fenceSpans, newlineIdx)) {
          return { index: newlineIdx };
        }
        newlineIdx = buffer.indexOf("\n", newlineIdx + 1);
      }
    }

    if (preference !== "newline") {
      const matches = buffer.matchAll(/[.!?](?=\s|$)/g);
      let sentenceIdx = -1;
      for (const match of matches) {
        const at = match.index ?? -1;
        if (at < minChars) continue;
        const candidate = at + 1;
        if (isSafeBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) return { index: sentenceIdx };
    }

    return { index: -1 };
  }

  #pickBreakIndex(buffer: string): BreakResult {
    const minChars = Math.max(1, Math.floor(this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));
    if (buffer.length < minChars) return { index: -1 };
    const window = buffer.slice(0, Math.min(maxChars, buffer.length));
    const fenceSpans = parseFenceSpans(buffer);

    const preference = this.#chunking.breakPreference ?? "paragraph";
    if (preference === "paragraph") {
      let paragraphIdx = window.lastIndexOf("\n\n");
      while (paragraphIdx >= minChars) {
        if (isSafeBreak(fenceSpans, paragraphIdx)) {
          return { index: paragraphIdx };
        }
        paragraphIdx = window.lastIndexOf("\n\n", paragraphIdx - 1);
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      let newlineIdx = window.lastIndexOf("\n");
      while (newlineIdx >= minChars) {
        if (isSafeBreak(fenceSpans, newlineIdx)) {
          return { index: newlineIdx };
        }
        newlineIdx = window.lastIndexOf("\n", newlineIdx - 1);
      }
    }

    if (preference !== "newline") {
      const matches = window.matchAll(/[.!?](?=\s|$)/g);
      let sentenceIdx = -1;
      for (const match of matches) {
        const at = match.index ?? -1;
        if (at < minChars) continue;
        const candidate = at + 1;
        if (isSafeBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) return { index: sentenceIdx };
    }

    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window[i]) && isSafeBreak(fenceSpans, i)) {
        return { index: i };
      }
    }

    if (buffer.length >= maxChars) {
      if (isSafeBreak(fenceSpans, maxChars)) return { index: maxChars };
      const fence = findFenceSpanAt(fenceSpans, maxChars);
      if (fence) {
        return {
          index: maxChars,
          fenceSplit: {
            closeFenceLine: `${fence.indent}${fence.marker}`,
            reopenFenceLine: fence.openLine,
          },
        };
      }
      return { index: maxChars };
    }

    return { index: -1 };
  }
}

function stripLeadingNewlines(value: string): string {
  let i = 0;
  while (i < value.length && value[i] === "\n") i++;
  return i > 0 ? value.slice(i) : value;
}

function parseFenceSpans(buffer: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let open:
    | {
        start: number;
        markerChar: string;
        markerLen: number;
        openLine: string;
        marker: string;
        indent: string;
      }
    | undefined;
  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    const line = buffer.slice(offset, lineEnd);
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      const indent = match[1];
      const marker = match[2];
      const markerChar = marker[0];
      const markerLen = marker.length;
      if (!open) {
        open = {
          start: offset,
          markerChar,
          markerLen,
          openLine: line,
          marker,
          indent,
        };
      } else if (
        open.markerChar === markerChar &&
        markerLen >= open.markerLen
      ) {
        const end = nextNewline === -1 ? buffer.length : nextNewline + 1;
        spans.push({
          start: open.start,
          end,
          openLine: open.openLine,
          marker: open.marker,
          indent: open.indent,
        });
        open = undefined;
      }
    }
    if (nextNewline === -1) break;
    offset = nextNewline + 1;
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
  return spans;
}

function findFenceSpanAt(
  spans: FenceSpan[],
  index: number,
): FenceSpan | undefined {
  return spans.find((span) => index > span.start && index < span.end);
}

function isSafeBreak(spans: FenceSpan[], index: number): boolean {
  return !findFenceSpanAt(spans, index);
}
