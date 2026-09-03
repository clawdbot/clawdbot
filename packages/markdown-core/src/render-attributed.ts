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
    for (const link of projected.links.toSorted((a, b) => a.start - b.start)) {
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

  const ranges: AttributedRange<TStyle>[] = [];
  const appendRange = (offset: number, end: number, style: TStyle) => {
    const start = Math.max(0, Math.min(offset, rendered.length));
    const length = Math.min(end, rendered.length) - start;
    if (length > 0) {
      ranges.push({ start, length, style });
    }
  };
  const appendSpan = (span: { start: number; end: number }, style: TStyle | undefined) => {
    if (style === undefined) {
      return;
    }
    let cursor = span.start;
    let shift = 0;
    for (const insertion of insertions) {
      if (insertion.pos <= cursor) {
        shift += insertion.length;
      } else if (insertion.pos >= span.end) {
        break;
      } else {
        appendRange(cursor + shift, insertion.pos + shift, style);
        cursor = insertion.pos;
        shift += insertion.length;
      }
    }
    appendRange(cursor + shift, span.end + shift, style);
  };
  projected.styles.forEach((span) => appendSpan(span, options.styleMap[span.style]));
  for (const annotation of projected.annotations ?? []) {
    appendSpan(annotation, options.annotationStyleMap?.[annotation.type]);
  }
  ranges.sort((a, b) => a.start - b.start || a.length - b.length || a.style.localeCompare(b.style));

  // Ranges are freshly owned, so compacting adjacent matches cannot mutate the IR.
  let retained = 0;
  for (const range of ranges) {
    const previous = ranges[retained - 1];
    if (
      previous &&
      previous.style === range.style &&
      range.start <= previous.start + previous.length
    ) {
      previous.length =
        Math.max(previous.start + previous.length, range.start + range.length) - previous.start;
    } else {
      ranges[retained] = range;
      retained += 1;
    }
  }
  ranges.length = retained;
  return { text: rendered, ranges };
}
