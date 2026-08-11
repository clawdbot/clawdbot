import type { FormatCapabilityProfile, FormatConstruct } from "./format-capabilities.js";
import {
  copyMarkdownLinkSpan,
  createStyleSpan,
  mergeAnnotationSpans,
  mergeStyleSpans,
  type MarkdownLinkSpan,
  type MarkdownStyle,
  type MarkdownStyleSpan,
} from "./ir-spans.js";
import { sliceMarkdownIR, type MarkdownIR } from "./ir.js";

type TextEdit = { start: number; end: number; text: string };

const STYLE_CONSTRUCTS: Partial<Record<MarkdownStyle, FormatConstruct>> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strikethrough: "strikethrough",
  spoiler: "spoiler",
  code: "codeInline",
  code_block: "codeBlock",
  blockquote: "blockquote",
};

function isHeading(style: MarkdownStyle): boolean {
  return style.startsWith("heading_");
}

function projectStyles(
  styles: MarkdownStyleSpan[],
  profile: FormatCapabilityProfile,
): MarkdownStyleSpan[] {
  const projected: MarkdownStyleSpan[] = [];
  let synthesizedHeading = false;
  for (const span of styles) {
    if (isHeading(span.style)) {
      if (profile.constructs.heading === "native") {
        projected.push(span);
      } else if (
        profile.constructs.heading === "fallback" &&
        profile.constructs.bold === "native"
      ) {
        projected.push(createStyleSpan({ ...span, style: "bold" }));
        synthesizedHeading = true;
      }
      continue;
    }
    const construct = STYLE_CONSTRUCTS[span.style];
    if (construct && profile.constructs[construct] !== "native") {
      continue;
    }
    if (span.style === "code_block" && profile.constructs.codeLanguage !== "native") {
      projected.push(createStyleSpan({ start: span.start, end: span.end, style: span.style }));
    } else {
      projected.push(span);
    }
  }
  return synthesizedHeading ? mergeStyleSpans(projected) : projected;
}

function collectLinkFallbacks(
  ir: MarkdownIR,
  profile: FormatCapabilityProfile,
): { links: MarkdownLinkSpan[]; edits: TextEdit[] } {
  if (profile.constructs.linkLabel === "native") {
    return { links: ir.links, edits: [] };
  }
  if (profile.constructs.linkLabel === "strip") {
    return { links: [], edits: [] };
  }
  return {
    links: [],
    edits: ir.links.flatMap((link) => {
      const href = link.href.trim();
      const label = ir.text.slice(link.start, link.end).trim();
      const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
      return href && label && label !== href && label !== comparableHref
        ? [{ start: link.end, end: link.end, text: ` (${href})` }]
        : [];
    }),
  };
}

function collectListFallbacks(ir: MarkdownIR, profile: FormatCapabilityProfile): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const item of ir.listItems ?? []) {
    if (item.task) {
      if (profile.constructs.taskList === "fallback" && item.listMarker) {
        edits.push({ ...item.listMarker, text: "" });
      } else if (profile.constructs.taskList === "strip" && item.taskMarker) {
        edits.push({ ...item.taskMarker, text: "" });
      }
    }
    if (item.listMarker && item.kind === "bullet" && profile.constructs.bulletList === "strip") {
      edits.push({ ...item.listMarker, text: "" });
    }
    if (item.listMarker && item.kind === "ordered" && profile.constructs.orderedList === "strip") {
      edits.push({ ...item.listMarker, text: "" });
    }
  }
  return edits;
}

function appendSlice(target: MarkdownIR, source: MarkdownIR): void {
  const offset = target.text.length;
  target.text += source.text;
  target.styles.push(
    ...source.styles.map((span) =>
      createStyleSpan({
        ...span,
        start: offset + span.start,
        end: offset + span.end,
      }),
    ),
  );
  target.links.push(
    ...source.links.map((link) =>
      copyMarkdownLinkSpan(link, {
        start: offset + link.start,
        end: offset + link.end,
      }),
    ),
  );
  const annotations = source.annotations?.map((annotation) => ({
    ...annotation,
    start: offset + annotation.start,
    end: offset + annotation.end,
  }));
  if (annotations?.length) {
    (target.annotations ??= []).push(...annotations);
  }
}

function applyTextEdits(ir: MarkdownIR, edits: TextEdit[]): MarkdownIR {
  if (edits.length === 0) {
    return ir;
  }
  const ordered = edits
    .toSorted((a, b) => a.start - b.start || a.end - b.end)
    .filter((edit, index, all) => {
      const previous = all[index - 1];
      return !previous || edit.start !== previous.start || edit.end !== previous.end;
    });
  const result: MarkdownIR = { text: "", styles: [], links: [] };
  let cursor = 0;
  for (const edit of ordered) {
    appendSlice(result, sliceMarkdownIR(ir, cursor, edit.start));
    result.text += edit.text;
    cursor = edit.end;
  }
  appendSlice(result, sliceMarkdownIR(ir, cursor, ir.text.length));
  result.styles = mergeStyleSpans(result.styles);
  if (result.annotations) {
    result.annotations = mergeAnnotationSpans(result.annotations);
  }
  return result;
}

/** Applies target-declared semantic fallbacks before a mechanism-specific renderer runs. */
export function applyConstructFallbacks(
  ir: MarkdownIR,
  profile: FormatCapabilityProfile,
): MarkdownIR {
  // Tables stay in convertMarkdownTables; images and mentions are already plain
  // text in this flat IR, so those constructs have no shared fallback work here.
  const styled: MarkdownIR = {
    ...ir,
    styles: projectStyles(ir.styles, profile),
  };
  const listProjected = applyTextEdits(styled, collectListFallbacks(styled, profile));
  const linkProjection = collectLinkFallbacks(listProjected, profile);
  return applyTextEdits({ ...listProjected, links: linkProjection.links }, linkProjection.edits);
}
