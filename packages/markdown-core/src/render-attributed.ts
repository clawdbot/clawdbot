import { applyConstructFallbacks } from "./construct-fallbacks.js";
import type { FormatCapabilityProfile } from "./format-capabilities.js";
import { isAutoLinkedMarkdownLink, type MarkdownAnnotationSpan } from "./ir-spans.js";
import type { MarkdownIR, MarkdownLinkSpan, MarkdownStyle } from "./ir.js";

type AttributedRange<TStyle extends string> = {
  start: number;
  length: number;
  style: TStyle;
};

/** Renderer hooks for converting Markdown IR into text plus native style ranges. */
export type AttributedRenderOptions<TStyle extends string> = {
  styleMap: Partial<Record<MarkdownStyle, TStyle>>;
  annotationStyleMap?: Partial<Record<MarkdownAnnotationSpan["type"], TStyle>>;
  /** Returns text appended after a link label; appended text remains unstyled. */
  renderLink?: (
    link: MarkdownLinkSpan,
    text: string,
    context: { origin: "authored" | "linkify" },
  ) => string;
  trimEnd?: boolean;
};

/** Renders Markdown IR into text plus UTF-16 style ranges for attributed-text targets. */
export function renderMarkdownWithAttributedRanges<TStyle extends string>(
  ir: MarkdownIR,
  options: AttributedRenderOptions<TStyle>,
  profile?: FormatCapabilityProfile,
): { text: string; ranges: AttributedRange<TStyle>[] } {
  const projected = profile ? applyConstructFallbacks(ir, profile) : ir;
  const text = projected.text ?? "";
  const insertions: Array<{ pos: number; length: number }> = [];
  let rendered = text;
  if (options.renderLink) {
    rendered = "";
    let cursor = 0;
    for (const link of [...projected.links].toSorted((a, b) => a.start - b.start)) {
      if (link.start < cursor) {
        continue;
      }
      rendered += text.slice(cursor, link.end);
      const origin = isAutoLinkedMarkdownLink(link) ? "linkify" : "authored";
      const suffix = options.renderLink(link, text, { origin });
      rendered += suffix;
      if (suffix) {
        insertions.push({ pos: link.end, length: suffix.length });
      }
      cursor = link.end;
    }
    rendered += text.slice(cursor);
  }
  rendered = options.trimEnd ? rendered.trimEnd() : rendered;

  const spans = projected.styles.flatMap((span) => {
    const style = options.styleMap[span.style];
    return style === undefined ? [] : [{ start: span.start, end: span.end, style }];
  });
  for (const annotation of projected.annotations ?? []) {
    const style = options.annotationStyleMap?.[annotation.type];
    if (style !== undefined) {
      spans.push({ start: annotation.start, end: annotation.end, style });
    }
  }

  const ranges = spans
    .flatMap((span) => {
      const pieces: typeof spans = [];
      let cursor = span.start;
      let shift = 0;
      for (const insertion of insertions) {
        if (insertion.pos <= cursor) {
          shift += insertion.length;
        } else if (insertion.pos >= span.end) {
          break;
        } else {
          pieces.push({ ...span, start: cursor + shift, end: insertion.pos + shift });
          cursor = insertion.pos;
          shift += insertion.length;
        }
      }
      pieces.push({ ...span, start: cursor + shift, end: span.end + shift });
      return pieces;
    })
    .map((span) => {
      const start = Math.max(0, Math.min(span.start, rendered.length));
      return { start, length: Math.min(span.end, rendered.length) - start, style: span.style };
    })
    .filter((range) => range.length > 0)
    .toSorted((a, b) => a.start - b.start || a.length - b.length || a.style.localeCompare(b.style));

  const merged: AttributedRange<TStyle>[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.style === range.style &&
      range.start <= previous.start + previous.length
    ) {
      previous.length =
        Math.max(previous.start + previous.length, range.start + range.length) - previous.start;
    } else {
      merged.push({ ...range });
    }
  }
  return { text: rendered, ranges: merged };
}
