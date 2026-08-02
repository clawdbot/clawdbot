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

export function clampStyleSpans(
  spans: MarkdownStyleSpan[],
  maxLength: number,
): MarkdownStyleSpan[] {
  const clamped: MarkdownStyleSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, maxLength));
    const end = Math.max(start, Math.min(span.end, maxLength));
    if (end > start) {
      clamped.push(createStyleSpan({ start, end, style: span.style, language: span.language }));
    }
  }
  return clamped;
}

export function clampLinkSpans(spans: MarkdownLinkSpan[], maxLength: number): MarkdownLinkSpan[] {
  const clamped: MarkdownLinkSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, maxLength));
    const end = Math.max(start, Math.min(span.end, maxLength));
    if (end > start) {
      clamped.push(copyMarkdownLinkSpan(span, { start, end }));
    }
  }
  return clamped;
}

export function clampAnnotationSpans(
  spans: MarkdownAnnotationSpan[],
  maxLength: number,
): MarkdownAnnotationSpan[] {
  const clamped: MarkdownAnnotationSpan[] = [];
  for (const span of spans) {
    const start = Math.max(0, Math.min(span.start, maxLength));
    const end = Math.max(start, Math.min(span.end, maxLength));
    if (end > start) {
      clamped.push({ ...span, start, end });
    }
  }
  return clamped;
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

function resolveSliceBounds(
  span: { start: number; end: number },
  start: number,
  end: number,
): { start: number; end: number } | null {
  const sliceStart = Math.max(span.start, start);
  const sliceEnd = Math.min(span.end, end);
  return sliceEnd > sliceStart ? { start: sliceStart, end: sliceEnd } : null;
}

export function sliceStyleSpans(
  spans: MarkdownStyleSpan[],
  start: number,
  end: number,
): MarkdownStyleSpan[] {
  const sliced: MarkdownStyleSpan[] = [];
  for (const span of spans) {
    const bounds = resolveSliceBounds(span, start, end);
    if (bounds) {
      sliced.push(
        createStyleSpan({
          start: bounds.start - start,
          end: bounds.end - start,
          style: span.style,
          language: span.language,
        }),
      );
    }
  }
  return mergeStyleSpans(sliced);
}

export function sliceLinkSpans(
  spans: MarkdownLinkSpan[],
  start: number,
  end: number,
): MarkdownLinkSpan[] {
  const sliced: MarkdownLinkSpan[] = [];
  for (const span of spans) {
    const bounds = resolveSliceBounds(span, start, end);
    if (bounds) {
      sliced.push(
        copyMarkdownLinkSpan(span, {
          start: bounds.start - start,
          end: bounds.end - start,
        }),
      );
    }
  }
  return sliced;
}

export function sliceAnnotationSpans(
  spans: MarkdownAnnotationSpan[],
  start: number,
  end: number,
): MarkdownAnnotationSpan[] {
  const sliced: MarkdownAnnotationSpan[] = [];
  for (const span of spans) {
    const bounds = resolveSliceBounds(span, start, end);
    if (bounds) {
      sliced.push({
        ...span,
        start: bounds.start - start,
        end: bounds.end - start,
      });
    }
  }
  return mergeAnnotationSpans(sliced);
}
