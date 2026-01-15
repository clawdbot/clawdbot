import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownIR,
  type MarkdownStyle,
} from "../markdown/ir.js";

type SignalTextStyle = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";

export type SignalTextStyleRange = {
  start: number;
  length: number;
  style: SignalTextStyle;
};

export type SignalFormattedText = {
  text: string;
  styles: SignalTextStyleRange[];
};

type SignalStyleSpan = {
  start: number;
  end: number;
  style: SignalTextStyle;
};

type Insertion = {
  pos: number;
  length: number;
};

function mapStyle(style: MarkdownStyle): SignalTextStyle | null {
  switch (style) {
    case "bold":
      return "BOLD";
    case "italic":
      return "ITALIC";
    case "strikethrough":
      return "STRIKETHROUGH";
    case "code":
    case "code_block":
      return "MONOSPACE";
    case "spoiler":
      return "SPOILER";
    default:
      return null;
  }
}

function mergeStyles(styles: SignalTextStyleRange[]): SignalTextStyleRange[] {
  const sorted = [...styles].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.length !== b.length) return a.length - b.length;
    return a.style.localeCompare(b.style);
  });

  const merged: SignalTextStyleRange[] = [];
  for (const style of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === style.style && style.start <= prev.start + prev.length) {
      const prevEnd = prev.start + prev.length;
      const nextEnd = Math.max(prevEnd, style.start + style.length);
      prev.length = nextEnd - prev.start;
      continue;
    }
    merged.push({ ...style });
  }

  return merged;
}

function clampStyles(styles: SignalTextStyleRange[], maxLength: number): SignalTextStyleRange[] {
  const clamped: SignalTextStyleRange[] = [];
  for (const style of styles) {
    const start = Math.max(0, Math.min(style.start, maxLength));
    const end = Math.min(style.start + style.length, maxLength);
    const length = end - start;
    if (length > 0) clamped.push({ start, length, style: style.style });
  }
  return clamped;
}

function applyInsertionsToStyles(
  spans: SignalStyleSpan[],
  insertions: Insertion[],
): SignalStyleSpan[] {
  if (insertions.length === 0) return spans;
  const sortedInsertions = [...insertions].sort((a, b) => a.pos - b.pos);
  let updated = spans;

  for (const insertion of sortedInsertions) {
    const next: SignalStyleSpan[] = [];
    for (const span of updated) {
      if (span.end <= insertion.pos) {
        next.push(span);
        continue;
      }
      if (span.start >= insertion.pos) {
        next.push({
          start: span.start + insertion.length,
          end: span.end + insertion.length,
          style: span.style,
        });
        continue;
      }
      if (span.start < insertion.pos && span.end > insertion.pos) {
        if (insertion.pos > span.start) {
          next.push({
            start: span.start,
            end: insertion.pos,
            style: span.style,
          });
        }
        const shiftedStart = insertion.pos + insertion.length;
        const shiftedEnd = span.end + insertion.length;
        if (shiftedEnd > shiftedStart) {
          next.push({
            start: shiftedStart,
            end: shiftedEnd,
            style: span.style,
          });
        }
      }
    }
    updated = next;
  }

  return updated;
}

function renderSignalText(ir: MarkdownIR): SignalFormattedText {
  const text = ir.text ?? "";
  if (!text) return { text: "", styles: [] };

  const sortedLinks = [...ir.links].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  const insertions: Insertion[] = [];

  for (const link of sortedLinks) {
    if (link.start < cursor) continue;
    out += text.slice(cursor, link.end);

    const href = link.href.trim();
    const label = text.slice(link.start, link.end);
    const trimmedLabel = label.trim();
    const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;

    if (href) {
      if (!trimmedLabel) {
        out += href;
        insertions.push({ pos: link.end, length: href.length });
      } else if (trimmedLabel !== href && trimmedLabel !== comparableHref) {
        const addition = ` (${href})`;
        out += addition;
        insertions.push({ pos: link.end, length: addition.length });
      }
    }

    cursor = link.end;
  }

  out += text.slice(cursor);

  const mappedStyles: SignalStyleSpan[] = ir.styles
    .map((span) => {
      const mapped = mapStyle(span.style);
      if (!mapped) return null;
      return { start: span.start, end: span.end, style: mapped };
    })
    .filter((span): span is SignalStyleSpan => span !== null);

  const adjusted = applyInsertionsToStyles(mappedStyles, insertions);
  const trimmedText = out.trimEnd();
  const trimmedLength = trimmedText.length;
  const clamped = clampStyles(
    adjusted.map((span) => ({
      start: span.start,
      length: span.end - span.start,
      style: span.style,
    })),
    trimmedLength,
  );

  return {
    text: trimmedText,
    styles: mergeStyles(clamped),
  };
}

export function markdownToSignalText(markdown: string): SignalFormattedText {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
  });
  return renderSignalText(ir);
}

export function markdownToSignalTextChunks(markdown: string, limit: number): SignalFormattedText[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    enableSpoilers: true,
    headingStyle: "none",
    blockquotePrefix: "",
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return chunks.map((chunk) => renderSignalText(chunk));
}
