import type {
  AssistantTranscriptRole,
  AssistantTranscriptRoleHeaderKind,
} from "./assistant-transcript-headers.js";

export type MarkdownStyle =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "code"
  | "code_block"
  | "spoiler"
  | "blockquote"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "heading_4"
  | "heading_5"
  | "heading_6";

export type MarkdownStyleSpan = {
  start: number;
  end: number;
  style: MarkdownStyle;
  language?: string;
};

export type MarkdownLinkSpan = {
  start: number;
  end: number;
  href: string;
};

// Link provenance is renderer metadata, not part of the public Markdown IR shape.
// Every span transform must use copyMarkdownLinkSpan so the private fact survives.
const autoLinkedMarkdownLinks = new WeakSet<MarkdownLinkSpan>();

export function createMarkdownLinkSpan(
  span: MarkdownLinkSpan,
  options: { autoLinked?: boolean } = {},
): MarkdownLinkSpan {
  const created = { ...span };
  if (options.autoLinked) {
    autoLinkedMarkdownLinks.add(created);
  }
  return created;
}

export function copyMarkdownLinkSpan(
  span: MarkdownLinkSpan,
  overrides: Partial<MarkdownLinkSpan> = {},
): MarkdownLinkSpan {
  return createMarkdownLinkSpan(
    { ...span, ...overrides },
    { autoLinked: autoLinkedMarkdownLinks.has(span) },
  );
}

export function isAutoLinkedMarkdownLink(span: MarkdownLinkSpan): boolean {
  return autoLinkedMarkdownLinks.has(span);
}

export type MarkdownAnnotationSpan = {
  start: number;
  end: number;
  type: "assistant_transcript_role";
  kind: AssistantTranscriptRoleHeaderKind;
  role: AssistantTranscriptRole;
};

export function createStyleSpan(params: MarkdownStyleSpan): MarkdownStyleSpan {
  const span: MarkdownStyleSpan = {
    start: params.start,
    end: params.end,
    style: params.style,
  };
  if (params.language) {
    span.language = params.language;
  }
  return span;
}

function clipSpans<T extends { start: number; end: number }>(
  spans: T[],
  start: number,
  end: number,
  copySpan: (span: T) => T,
): T[] {
  const clipped: T[] = [];
  for (const span of spans) {
    const sliceStart = Math.max(span.start, start);
    const sliceEnd = Math.min(span.end, end);
    if (sliceEnd > sliceStart) {
      const copy = copySpan(span);
      copy.start = sliceStart - start;
      copy.end = sliceEnd - start;
      clipped.push(copy);
    }
  }
  return clipped;
}

export function clampStyleSpans(
  spans: MarkdownStyleSpan[],
  maxLength: number,
): MarkdownStyleSpan[] {
  return clipSpans(spans, 0, maxLength, createStyleSpan);
}

export function clampLinkSpans(spans: MarkdownLinkSpan[], maxLength: number): MarkdownLinkSpan[] {
  return clipSpans(spans, 0, maxLength, copyMarkdownLinkSpan);
}

export function clampAnnotationSpans(
  spans: MarkdownAnnotationSpan[],
  maxLength: number,
): MarkdownAnnotationSpan[] {
  return clipSpans(spans, 0, maxLength, (span) => ({ ...span }));
}

export function mergeAnnotationSpans(spans: MarkdownAnnotationSpan[]): MarkdownAnnotationSpan[] {
  const sorted = [...spans].toSorted((a, b) => a.start - b.start || a.end - b.end);
  const merged: MarkdownAnnotationSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.end === span.start &&
      previous.type === span.type &&
      previous.kind === span.kind &&
      previous.role === span.role
    ) {
      previous.end = span.end;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

export function mergeStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  const sorted = [...spans].toSorted((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.end !== b.end) {
      return a.end - b.end;
    }
    return a.style.localeCompare(b.style);
  });

  const merged: MarkdownStyleSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.style === span.style &&
      previous.language === span.language &&
      // Blockquotes are containers; merging adjacent blocks leaks styling across paragraphs.
      (span.start < previous.end || (span.start === previous.end && span.style !== "blockquote"))
    ) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

export function sliceStyleSpans(
  spans: MarkdownStyleSpan[],
  start: number,
  end: number,
): MarkdownStyleSpan[] {
  return mergeStyleSpans(clipSpans(spans, start, end, createStyleSpan));
}

export function sliceLinkSpans(
  spans: MarkdownLinkSpan[],
  start: number,
  end: number,
): MarkdownLinkSpan[] {
  return clipSpans(spans, start, end, copyMarkdownLinkSpan);
}

export function sliceAnnotationSpans(
  spans: MarkdownAnnotationSpan[],
  start: number,
  end: number,
): MarkdownAnnotationSpan[] {
  return mergeAnnotationSpans(clipSpans(spans, start, end, (span) => ({ ...span })));
}
