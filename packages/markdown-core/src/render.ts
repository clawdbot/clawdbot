// Markdown Core module implements render behavior.
import type { MarkdownIR, MarkdownLinkSpan, MarkdownStyle, MarkdownStyleSpan } from "./ir.js";

/** Marker pair used to wrap a styled Markdown span in the target renderer. */
export type RenderStyleMarker = {
  open: string | ((span: MarkdownStyleSpan) => string);
  close: string;
};

/** Optional marker map; omitted styles are emitted as plain escaped text. */
export type RenderStyleMap = Partial<Record<MarkdownStyle, RenderStyleMarker>>;

/** Link wrapper boundaries after a renderer has accepted or rewritten a link span. */
export type RenderLink = {
  start: number;
  end: number;
  open: string;
  close: string;
};

/** Renderer hooks for converting Markdown IR into a marker-based target format. */
export type RenderOptions = {
  styleMarkers: RenderStyleMap;
  escapeText: (text: string) => string;
  buildLink?: (link: MarkdownLinkSpan, text: string) => RenderLink | null;
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

/** Renders Markdown IR by nesting configured style markers and optional link markers. */
export function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string {
  const text = ir.text ?? "";
  if (!text) {
    return "";
  }

  const styleMarkers = options.styleMarkers;
  const styled = sortStyleSpans(ir.styles.filter((span) => Boolean(styleMarkers[span.style])));

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

  const linkStarts = new Map<number, RenderLink[]>();
  if (options.buildLink) {
    for (const link of ir.links) {
      if (link.start === link.end) {
        continue;
      }
      const rendered = options.buildLink(link, text);
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
        if (a.kind !== b.kind) {
          return a.kind === "link" ? -1 : 1;
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
