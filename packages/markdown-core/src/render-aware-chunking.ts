import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { avoidTrailingHighSurrogateBreak } from "./chunk-text.js";
// Markdown Core module implements render aware chunking behavior.
import { annotateAssistantTranscriptRoleMessageBoundary } from "./ir-annotations.js";
import { mergeAnnotationSpans, mergeStyleSpans } from "./ir-spans.js";
import { appendMarkdownIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";

/** A rendered chunk paired with the Markdown IR slice that produced it. */
export type RenderedMarkdownChunk<TRendered> = {
  /** Rendered payload for this chunk after caller-specific escaping/link rewriting. */
  rendered: TRendered;
  /** Source IR slice used to produce the rendered payload. */
  source: MarkdownIR;
};

/** Inputs for chunking Markdown IR against the final rendered payload size. */
export type RenderMarkdownIRChunksWithinLimitOptions<TRendered> = {
  /** Parsed Markdown IR to split. */
  ir: MarkdownIR;
  /** Maximum measured size for each rendered chunk. */
  limit: number;
  /** Returns the size unit enforced by the target transport. */
  measureRendered: (rendered: TRendered) => number;
  /** Renders a candidate IR slice for measuring and final output. */
  renderChunk: (ir: MarkdownIR) => TRendered;
  /** Re-annotate transcript-role headers promoted by a new message boundary. */
  assistantTranscriptRoleMessageBoundaries?: boolean;
};

type RenderedCandidate<TRendered> = {
  rawSource: MarkdownIR;
  output: RenderedMarkdownChunk<TRendered>;
};

type RenderResolver<TRendered> = Pick<
  RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
  "measureRendered" | "renderChunk"
>;

function prepareChunkForMessageBoundary<TRendered>(
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
  chunk: MarkdownIR,
): MarkdownIR {
  return options.assistantTranscriptRoleMessageBoundaries === true
    ? annotateAssistantTranscriptRoleMessageBoundary(chunk)
    : chunk;
}

function renderCandidate<TRendered>(
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
  rawSource: MarkdownIR,
): RenderedCandidate<TRendered> {
  const source = prepareChunkForMessageBoundary(options, rawSource);
  return { rawSource, output: { source, rendered: options.renderChunk(source) } };
}

/** Chunks Markdown IR by rendered size while preserving styles, links, and whitespace. */
export function renderMarkdownIRChunksWithinLimit<TRendered>(
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
): RenderedMarkdownChunk<TRendered>[] {
  if (!options.ir.text) {
    return [];
  }

  // Callers pass Infinity to mean "no size cap" (e.g. a media caption that must not be
  // split). resolveIntegerOption rejects non-finite values and would fall back to 1,
  // shattering the text into one chunk per character; emit the whole IR as one chunk.
  if (options.limit === Number.POSITIVE_INFINITY) {
    const source = prepareChunkForMessageBoundary(options, options.ir);
    return [{ source, rendered: options.renderChunk(source) }];
  }

  const normalizedLimit = resolveIntegerOption(options.limit, 1, { min: 1 });
  const renderResolver: RenderResolver<TRendered> = {
    measureRendered: options.measureRendered,
    renderChunk: (chunk) => options.renderChunk(prepareChunkForMessageBoundary(options, chunk)),
  };
  // Treat the pending worklist as a stack so each dequeue/enqueue stays O(1).
  // The initial reverse keeps the final order stable while avoiding shift/unshift
  // moving every remaining chunk for long messages.
  const pending = splitMarkdownIRPreserveWhitespace(options.ir, normalizedLimit).toReversed();
  const finalized: RenderedCandidate<TRendered>[] = [];

  while (pending.length > 0) {
    const chunk = pending.pop();
    if (!chunk) {
      continue;
    }

    const candidate = renderCandidate(options, chunk);
    if (
      options.measureRendered(candidate.output.rendered) <= normalizedLimit ||
      chunk.text.length <= 1
    ) {
      finalized.push(candidate);
      continue;
    }

    const split = splitMarkdownIRByRenderedLimit(chunk, normalizedLimit, renderResolver);
    if (split.length <= 1) {
      // Worst-case safety: avoid retry loops and keep the original chunk.
      finalized.push(candidate);
      continue;
    }
    for (let index = split.length - 1; index >= 0; index -= 1) {
      const next = split[index];
      if (next) {
        pending.push(next);
      }
    }
  }

  return coalesceWhitespaceOnlyMarkdownIRChunks(finalized, normalizedLimit, options).map(
    (chunk) => chunk.output,
  );
}

function splitMarkdownIRByRenderedLimit<TRendered>(
  chunk: MarkdownIR,
  renderedLimit: number,
  options: RenderResolver<TRendered>,
): MarkdownIR[] {
  const currentTextLength = chunk.text.length;
  if (currentTextLength <= 1) {
    return [chunk];
  }

  const splitLimit = findLargestChunkTextLengthWithinRenderedLimit(chunk, renderedLimit, options);
  if (splitLimit <= 0) {
    return [chunk];
  }

  const split = splitMarkdownIRPreserveWhitespace(chunk, splitLimit);
  const firstChunk = split[0];
  if (firstChunk && options.measureRendered(options.renderChunk(firstChunk)) <= renderedLimit) {
    return split;
  }

  return [
    sliceMarkdownIR(chunk, 0, splitLimit),
    sliceMarkdownIR(chunk, splitLimit, currentTextLength),
  ];
}

function findLargestChunkTextLengthWithinRenderedLimit<TRendered>(
  chunk: MarkdownIR,
  renderedLimit: number,
  options: RenderResolver<TRendered>,
): number {
  const currentTextLength = chunk.text.length;
  if (currentTextLength <= 1) {
    return currentTextLength;
  }

  // Rendered length is not guaranteed to be monotonic after escaping/link or
  // file-reference rewriting, so test exact candidates from longest to shortest.
  for (let candidateLength = currentTextLength - 1; candidateLength >= 1; candidateLength -= 1) {
    const safeCandidateLength = avoidTrailingHighSurrogateBreak(chunk.text, 0, candidateLength);
    const candidate = sliceMarkdownIR(chunk, 0, safeCandidateLength);
    const rendered = options.renderChunk(candidate);
    if (options.measureRendered(rendered) <= renderedLimit) {
      return safeCandidateLength;
    }
  }
  return 0;
}

function findMarkdownIRPreservedSplitIndex(text: string, start: number, limit: number): number {
  const maxEnd = Math.min(text.length, start + limit);
  if (maxEnd >= text.length) {
    return text.length;
  }

  let lastOutsideParenNewlineBreak = -1;
  let lastOutsideParenWhitespaceBreak = -1;
  let lastOutsideParenWhitespaceRunStart = -1;
  let lastAnyNewlineBreak = -1;
  let lastAnyWhitespaceBreak = -1;
  let lastAnyWhitespaceRunStart = -1;
  let parenDepth = 0;
  let sawNonWhitespace = false;

  for (let index = start; index < maxEnd; index += 1) {
    const char = text.charAt(index);
    // Parenthesized text often carries rewritten file/link references; prefer
    // keeping it intact unless no outside break exists in the current window.
    if (char === "(") {
      sawNonWhitespace = true;
      parenDepth += 1;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      sawNonWhitespace = true;
      parenDepth -= 1;
      continue;
    }
    if (!/\s/.test(char)) {
      sawNonWhitespace = true;
      continue;
    }
    if (!sawNonWhitespace) {
      continue;
    }
    if (char === "\n") {
      // Newlines preserve markdown block structure better than other spaces.
      lastAnyNewlineBreak = index + 1;
      if (parenDepth === 0) {
        lastOutsideParenNewlineBreak = index + 1;
      }
      continue;
    }
    const whitespaceRunStart =
      index === start || !/\s/.test(text[index - 1] ?? "") ? index : lastAnyWhitespaceRunStart;
    lastAnyWhitespaceBreak = index + 1;
    lastAnyWhitespaceRunStart = whitespaceRunStart;
    if (parenDepth === 0) {
      lastOutsideParenWhitespaceBreak = index + 1;
      lastOutsideParenWhitespaceRunStart = whitespaceRunStart;
    }
  }

  const resolveWhitespaceBreak = (breakIndex: number, runStart: number): number => {
    if (breakIndex <= start) {
      return breakIndex;
    }
    if (runStart <= start) {
      return breakIndex;
    }
    return /\s/.test(text[breakIndex] ?? "") ? runStart : breakIndex;
  };

  if (lastOutsideParenNewlineBreak > start) {
    return lastOutsideParenNewlineBreak;
  }
  if (lastOutsideParenWhitespaceBreak > start) {
    return resolveWhitespaceBreak(
      lastOutsideParenWhitespaceBreak,
      lastOutsideParenWhitespaceRunStart,
    );
  }
  if (lastAnyNewlineBreak > start) {
    return lastAnyNewlineBreak;
  }
  if (lastAnyWhitespaceBreak > start) {
    return resolveWhitespaceBreak(lastAnyWhitespaceBreak, lastAnyWhitespaceRunStart);
  }
  return avoidTrailingHighSurrogateBreak(text, start, maxEnd);
}

function splitMarkdownIRPreserveWhitespace(ir: MarkdownIR, limit: number): MarkdownIR[] {
  if (!ir.text) {
    return [];
  }

  const normalizedLimit = resolveIntegerOption(limit, 1, { min: 1 });
  if (normalizedLimit <= 0 || ir.text.length <= normalizedLimit) {
    return [ir];
  }

  const chunks: MarkdownIR[] = [];
  let cursor = 0;
  while (cursor < ir.text.length) {
    const end = findMarkdownIRPreservedSplitIndex(ir.text, cursor, normalizedLimit);
    chunks.push(sliceMarkdownIR(ir, cursor, end));
    cursor = end;
  }
  return chunks;
}

type SourceRange = { start: number; end: number };

function coalesceWhitespaceOnlyMarkdownIRChunks<TRendered>(
  chunks: RenderedCandidate<TRendered>[],
  renderedLimit: number,
  options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>,
): RenderedCandidate<TRendered>[] {
  // Finalized slices partition the source; only coalescing can discard separators.
  let offset = 0;
  const pending = chunks.map((chunk) => {
    const start = offset;
    offset += chunk.rawSource.text.length;
    return { ...chunk, start, end: offset };
  });
  const coalesced: Array<RenderedCandidate<TRendered> & { ranges: SourceRange[] }> = [];

  pending.forEach((chunk, index) => {
    const currentRange = { start: chunk.start, end: chunk.end };
    const current = { ...chunk, ranges: [currentRange] };
    if (chunk.rawSource.text.trim().length > 0) {
      coalesced.push(current);
      return;
    }

    const prev = coalesced.at(-1);
    const next = pending[index + 1];
    const chunkLength = chunk.rawSource.text.length;

    const renderIfFits = (ranges: SourceRange[]) => {
      const retained: SourceRange[] = [];
      for (const range of ranges) {
        const last = retained.at(-1);
        if (last?.end === range.start) {
          last.end = range.end;
        } else {
          retained.push({ ...range });
        }
      }
      // Slice contiguous source once, but never restore a discarded separator gap.
      // Raw source also excludes annotations introduced only by a message boundary.
      const source: MarkdownIR = { text: "", styles: [], links: [] };
      for (const range of retained) {
        appendMarkdownIR(source, sliceMarkdownIR(options.ir, range.start, range.end));
      }
      source.styles = mergeStyleSpans(source.styles);
      if (source.annotations) {
        source.annotations = mergeAnnotationSpans(source.annotations);
      }
      const candidate = renderCandidate(options, source);
      return options.measureRendered(candidate.output.rendered) <= renderedLimit
        ? { ...candidate, ranges: retained }
        : undefined;
    };

    if (prev) {
      const mergedPrev = renderIfFits([...prev.ranges, currentRange]);
      if (mergedPrev) {
        coalesced[coalesced.length - 1] = mergedPrev;
        return;
      }
    }

    if (next) {
      const mergedNext = renderIfFits([{ start: chunk.start, end: next.end }]);
      if (mergedNext) {
        pending[index + 1] = { ...mergedNext, start: chunk.start, end: next.end };
        return;
      }
    }

    if (prev && next) {
      // Split whitespace between neighbors when neither can retain the whole range.
      for (let prefixLength = chunkLength - 1; prefixLength >= 1; prefixLength -= 1) {
        const boundary = chunk.start + prefixLength;
        const mergedPrev = renderIfFits([...prev.ranges, { start: chunk.start, end: boundary }]);
        const mergedNext = mergedPrev && renderIfFits([{ start: boundary, end: next.end }]);
        if (mergedPrev && mergedNext) {
          coalesced[coalesced.length - 1] = mergedPrev;
          pending[index + 1] = { ...mergedNext, start: boundary, end: next.end };
          return;
        }
      }
    }

    // Preserve zero chunks when a renderer trims semantic whitespace away.
    if (
      options.measureRendered(chunk.output.rendered) > 0 &&
      (chunk.rawSource.styles.length > 0 ||
        chunk.rawSource.links.length > 0 ||
        chunk.rawSource.annotations?.length ||
        chunk.rawSource.listItems?.length)
    ) {
      coalesced.push(current);
    }
  });

  return coalesced;
}
