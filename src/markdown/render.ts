import type { MarkdownIR, MarkdownLinkSpan, MarkdownStyle, MarkdownStyleSpan } from "./ir.js";

export type RenderStyleMarker = {
  open: string;
  close: string;
};

export type RenderStyleMap = Partial<Record<MarkdownStyle, RenderStyleMarker>>;

export type RenderLink = {
  start: number;
  end: number;
  open: string;
  close: string;
};

export type RenderOptions = {
  styleMarkers: RenderStyleMap;
  escapeText: (text: string) => string;
  buildLink?: (link: MarkdownLinkSpan, text: string) => RenderLink | null;
};

const STYLE_ORDER: MarkdownStyle[] = [
  "code_block",
  "code",
  "bold",
  "italic",
  "strikethrough",
  "spoiler",
];

const STYLE_RANK = new Map<MarkdownStyle, number>(
  STYLE_ORDER.map((style, index) => [style, index]),
);

function sortStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  return [...spans].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return b.end - a.end;
    return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
  });
}

export function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string {
  const text = ir.text ?? "";
  if (!text) return "";

  const styleMarkers = options.styleMarkers;
  const styled = sortStyleSpans(ir.styles.filter((span) => Boolean(styleMarkers[span.style])));

  const boundaries = new Set<number>();
  boundaries.add(0);
  boundaries.add(text.length);

  const startsAt = new Map<number, MarkdownStyleSpan[]>();
  for (const span of styled) {
    if (span.start === span.end) continue;
    boundaries.add(span.start);
    boundaries.add(span.end);
    const bucket = startsAt.get(span.start);
    if (bucket) bucket.push(span);
    else startsAt.set(span.start, [span]);
  }
  for (const spans of startsAt.values()) {
    spans.sort((a, b) => {
      if (a.end !== b.end) return b.end - a.end;
      return (STYLE_RANK.get(a.style) ?? 0) - (STYLE_RANK.get(b.style) ?? 0);
    });
  }

  const linkStarts = new Map<number, RenderLink[]>();
  const linkEnds = new Map<number, RenderLink[]>();
  if (options.buildLink) {
    for (const link of ir.links) {
      if (link.start === link.end) continue;
      const rendered = options.buildLink(link, text);
      if (!rendered) continue;
      boundaries.add(rendered.start);
      boundaries.add(rendered.end);
      const openBucket = linkStarts.get(rendered.start);
      if (openBucket) openBucket.push(rendered);
      else linkStarts.set(rendered.start, [rendered]);
      const closeBucket = linkEnds.get(rendered.end);
      if (closeBucket) closeBucket.push(rendered);
      else linkEnds.set(rendered.end, [rendered]);
    }
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const stack: MarkdownStyleSpan[] = [];
  let out = "";

  for (let i = 0; i < points.length; i += 1) {
    const pos = points[i];

    while (stack.length && stack[stack.length - 1]?.end === pos) {
      const span = stack.pop();
      if (!span) break;
      const marker = styleMarkers[span.style];
      if (marker) out += marker.close;
    }

    const closingLinks = linkEnds.get(pos);
    if (closingLinks && closingLinks.length > 0) {
      for (const link of closingLinks) {
        out += link.close;
      }
    }

    const openingLinks = linkStarts.get(pos);
    if (openingLinks && openingLinks.length > 0) {
      for (const link of openingLinks) {
        out += link.open;
      }
    }

    const openingStyles = startsAt.get(pos);
    if (openingStyles) {
      for (const span of openingStyles) {
        const marker = styleMarkers[span.style];
        if (!marker) continue;
        stack.push(span);
        out += marker.open;
      }
    }

    const next = points[i + 1];
    if (next === undefined) break;
    if (next > pos) {
      out += options.escapeText(text.slice(pos, next));
    }
  }

  return out;
}
