import {
  copyMarkdownLinkSpan,
  isAutoLinkedMarkdownLink,
  type MarkdownAnnotationSpan,
} from "./ir-spans.js";
// Markdown Core module implements render behavior.
import type { MarkdownIR, MarkdownLinkSpan, MarkdownStyle, MarkdownStyleSpan } from "./ir.js";

/** Marker pair used to wrap a styled Markdown span in the target renderer. */
export type RenderStyleMarker = {
  open: string | ((span: MarkdownStyleSpan) => string);
  close: string;
};

/** Optional marker map; omitted styles are emitted as plain escaped text. */
export type RenderStyleMap = Partial<Record<MarkdownStyle, RenderStyleMarker>>;

/** Marker pair used to render a semantic Markdown annotation. */
type RenderAnnotationMarker = {
  open: string | ((span: MarkdownAnnotationSpan) => string);
  close: string;
  /** Drop links and ordinary styles that overlap this annotation. */
  suppressNestedFormatting?: boolean;
};

type RenderAnnotationMap = Partial<Record<MarkdownAnnotationSpan["type"], RenderAnnotationMarker>>;

/** Link wrapper boundaries after a renderer has accepted or rewritten a link span. */
export type RenderLink = {
  start: number;
  end: number;
  open: string;
  close: string;
};

type MarkdownLinkOrigin = "authored" | "linkify";

function getMarkdownLinkOrigin(link: MarkdownLinkSpan): MarkdownLinkOrigin {
  return isAutoLinkedMarkdownLink(link) ? "linkify" : "authored";
}

/** Renderer hooks for converting Markdown IR into a marker-based target format. */
export type RenderOptions = {
  styleMarkers: RenderStyleMap;
  annotationMarkers?: RenderAnnotationMap;
  escapeText: (text: string) => string;
  buildLink?: (
    link: MarkdownLinkSpan,
    text: string,
    context: { origin: MarkdownLinkOrigin },
  ) => RenderLink | null;
};

const STYLE_ORDER: MarkdownStyle[] = [
  "blockquote",
  "code_block",
  "code",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "heading_5",
  "heading_6",
  "bold",
  "italic",
  "strikethrough",
  "spoiler",
];

const STYLE_RANK = new Map<MarkdownStyle, number>(
  STYLE_ORDER.map((style, index) => [style, index]),
);

const STRUCTURAL_STYLES = new Set<MarkdownStyle>([
  "blockquote",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "heading_5",
  "heading_6",
]);

function sortStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  return [...spans].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.end !== b.end) {
      return b.end - a.end;
    }
    return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
  });
}

type TextRange = { start: number; end: number };

function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of [...ranges].toSorted((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function firstOverlappingRangeIndex(ranges: readonly TextRange[], start: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const range = ranges[middle];
    if (range && range.end <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function subtractRanges<T extends { start: number; end: number }>(
  span: T,
  ranges: readonly TextRange[],
): T[] {
  const firstOverlap = firstOverlappingRangeIndex(ranges, span.start);
  const firstRange = ranges[firstOverlap];
  if (!firstRange || firstRange.start >= span.end) {
    return [span];
  }
  const pieces: T[] = [];
  let cursor = span.start;
  for (let index = firstOverlap; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (!range || range.start >= span.end) {
      break;
    }
    const rangeStart = Math.max(span.start, range.start);
    const rangeEnd = Math.min(span.end, range.end);
    if (rangeStart > cursor) {
      pieces.push({ ...span, start: cursor, end: rangeStart });
    }
    cursor = Math.max(cursor, rangeEnd);
  }
  if (cursor < span.end) {
    pieces.push({ ...span, start: cursor, end: span.end });
  }
  return pieces;
}

function splitAtBoundaries<T extends { start: number; end: number }>(
  span: T,
  boundaries: readonly number[],
): T[] {
  let low = 0;
  let high = boundaries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((boundaries[middle] ?? Number.POSITIVE_INFINITY) <= span.start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if ((boundaries[low] ?? Number.POSITIVE_INFINITY) >= span.end) {
    return [span];
  }

  // Marker targets require proper nesting. Split formatting that crosses a
  // semantic boundary so it can close before the annotation and reopen after.
  const pieces: T[] = [];
  let cursor = span.start;
  for (let index = low; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (boundary === undefined || boundary >= span.end) {
      break;
    }
    pieces.push({ ...span, start: cursor, end: boundary });
    cursor = boundary;
  }
  pieces.push({ ...span, start: cursor, end: span.end });
  return pieces;
}

function sortAnnotationSpans(spans: MarkdownAnnotationSpan[]): MarkdownAnnotationSpan[] {
  return [...spans].toSorted((a, b) => a.start - b.start || b.end - a.end);
}

/** Renders Markdown IR by nesting configured style markers and optional link markers. */
export function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string {
  const text = ir.text ?? "";
  if (!text) {
    return "";
  }

  const styleMarkers = options.styleMarkers;
  const annotationMarkers = options.annotationMarkers ?? {};
  const annotated = sortAnnotationSpans(
    (ir.annotations ?? []).filter((span) => Boolean(annotationMarkers[span.type])),
  );
  const dominantAnnotations = annotated.filter(
    (span) => annotationMarkers[span.type]?.suppressNestedFormatting === true,
  );
  const dominantAnnotationRanges = mergeRanges(dominantAnnotations);
  const annotationBoundaries = [
    ...new Set(annotated.flatMap((span) => [span.start, span.end])),
  ].toSorted((a, b) => a - b);
  const styled = sortStyleSpans(
    ir.styles
      .filter((span) => Boolean(styleMarkers[span.style]))
      .flatMap((span) => {
        if (STRUCTURAL_STYLES.has(span.style)) {
          return [span];
        }
        return subtractRanges(span, dominantAnnotationRanges).flatMap((piece) =>
          splitAtBoundaries(piece, annotationBoundaries),
        );
      }),
  );

  const boundaries = new Set<number>();
  boundaries.add(0);
  boundaries.add(text.length);

  const startsAt = new Map<number, MarkdownStyleSpan[]>();
  for (const span of styled) {
    if (span.start === span.end) {
      continue;
    }
    boundaries.add(span.start);
    boundaries.add(span.end);
    const bucket = startsAt.get(span.start);
    if (bucket) {
      bucket.push(span);
    } else {
      startsAt.set(span.start, [span]);
    }
  }
  for (const spans of startsAt.values()) {
    spans.sort((a, b) => {
      if (a.end !== b.end) {
        return b.end - a.end;
      }
      return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
    });
  }

  const annotationStarts = new Map<number, MarkdownAnnotationSpan[]>();
  for (const span of annotated) {
    if (span.start === span.end) {
      continue;
    }
    boundaries.add(span.start);
    boundaries.add(span.end);
    const bucket = annotationStarts.get(span.start);
    if (bucket) {
      bucket.push(span);
    } else {
      annotationStarts.set(span.start, [span]);
    }
  }

  const linkStarts = new Map<number, RenderLink[]>();
  if (options.buildLink) {
    const links = ir.links.flatMap((span) =>
      subtractRanges(span, dominantAnnotationRanges)
        .flatMap((piece) => splitAtBoundaries(piece, annotationBoundaries))
        .map((piece) =>
          copyMarkdownLinkSpan(span, {
            start: piece.start,
            end: piece.end,
            href: piece.href,
          }),
        ),
    );
    for (const link of links) {
      if (link.start === link.end) {
        continue;
      }
      const rendered = options.buildLink(link, text, { origin: getMarkdownLinkOrigin(link) });
      if (!rendered) {
        continue;
      }
      boundaries.add(rendered.start);
      boundaries.add(rendered.end);
      const openBucket = linkStarts.get(rendered.start);
      if (openBucket) {
        openBucket.push(rendered);
      } else {
        linkStarts.set(rendered.start, [rendered]);
      }
    }
  }

  const points = [...boundaries].toSorted((a, b) => a - b);
  // Links and styles share one stack so equal-end spans close in exact reverse open order.
  const stack: { close: string; end: number }[] = [];
  type OpeningItem =
    | { end: number; open: string; close: string; kind: "annotation"; index: number }
    | { end: number; open: string; close: string; kind: "link"; index: number }
    | {
        end: number;
        open: string;
        close: string;
        kind: "style";
        style: MarkdownStyle;
        index: number;
      };
  let out = "";

  for (const [i, pos] of points.entries()) {
    // Close all elements at this boundary before opening replacements at the same offset.
    while (stack.length && stack[stack.length - 1]?.end === pos) {
      const item = stack.pop();
      if (item) {
        out += item.close;
      }
    }

    const openingItems: OpeningItem[] = [];

    const openingAnnotations = annotationStarts.get(pos);
    if (openingAnnotations) {
      for (const [index, span] of openingAnnotations.entries()) {
        const marker = annotationMarkers[span.type];
        if (!marker) {
          continue;
        }
        openingItems.push({
          end: span.end,
          open: typeof marker.open === "function" ? marker.open(span) : marker.open,
          close: marker.close,
          kind: "annotation",
          index,
        });
      }
    }

    const openingLinks = linkStarts.get(pos);
    if (openingLinks && openingLinks.length > 0) {
      for (const [index, link] of openingLinks.entries()) {
        openingItems.push({
          end: link.end,
          open: link.open,
          close: link.close,
          kind: "link",
          index,
        });
      }
    }

    const openingStyles = startsAt.get(pos);
    if (openingStyles) {
      for (const [index, span] of openingStyles.entries()) {
        const marker = styleMarkers[span.style];
        if (!marker) {
          continue;
        }
        openingItems.push({
          end: span.end,
          open: typeof marker.open === "function" ? marker.open(span) : marker.open,
          close: marker.close,
          kind: "style",
          style: span.style,
          index,
        });
      }
    }

    if (openingItems.length > 0) {
      openingItems.sort((a, b) => {
        if (a.end !== b.end) {
          return b.end - a.end;
        }
        const aStructural = a.kind === "style" && STRUCTURAL_STYLES.has(a.style);
        const bStructural = b.kind === "style" && STRUCTURAL_STYLES.has(b.style);
        if (aStructural !== bStructural || a.kind !== b.kind) {
          const kindRank = { annotation: 0, link: 1, style: 2 } as const;
          const aRank = aStructural ? -1 : kindRank[a.kind];
          const bRank = bStructural ? -1 : kindRank[b.kind];
          return aRank - bRank;
        }
        if (a.kind === "style" && b.kind === "style") {
          return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
        }
        return a.index - b.index;
      });

      // Open outer spans first (larger end) so LIFO closes stay valid for same-start overlaps.
      for (const item of openingItems) {
        out += item.open;
        stack.push({ close: item.close, end: item.end });
      }
    }

    const next = points.at(i + 1);
    if (next === undefined) {
      break;
    }
    if (next > pos) {
      out += options.escapeText(text.slice(pos, next));
    }
  }

  return out;
}
