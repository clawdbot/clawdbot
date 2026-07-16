import { findAssistantTranscriptRoleHeaderSpans } from "../../../packages/markdown-core/src/assistant-transcript-headers.js";
import { markdownToIR, type MarkdownIR } from "../../../packages/markdown-core/src/ir.js";

type StripMarkdownOptions = {
  /** Mark parsed assistant transcript-role headers in transports without rich text. */
  assistantTranscriptRoleHeaders?: boolean;
  /** Prefix inserted before each marked transcript-role header. */
  assistantTranscriptRolePrefix?: string;
  /** Link projection after formatting is removed. Default: label-and-url. */
  linkStyle?: "label" | "label-and-url";
};

type PlainTextInsertion = {
  position: number;
  text: string;
};

function collectLinkInsertions(
  ir: MarkdownIR,
  options: StripMarkdownOptions,
): PlainTextInsertion[] {
  const insertions: PlainTextInsertion[] = [];
  const linkStyle = options.linkStyle ?? "label-and-url";
  if (linkStyle === "label-and-url") {
    for (const link of ir.links) {
      const href = link.href.trim();
      const label = ir.text.slice(link.start, link.end).trim();
      const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
      if (href && label && label !== href && label !== comparableHref) {
        insertions.push({ position: link.end, text: ` (${href})` });
      }
    }
  }
  return insertions;
}

function collectAssistantTranscriptRoleInsertions(
  text: string,
  options: StripMarkdownOptions,
): PlainTextInsertion[] {
  if (options.assistantTranscriptRoleHeaders !== true) {
    return [];
  }
  const prefix = options.assistantTranscriptRolePrefix ?? "[assistant-authored transcript] ";
  if (!prefix) {
    return [];
  }
  return findAssistantTranscriptRoleHeaderSpans(text).map((span) => ({
    position: span.start,
    text: prefix,
  }));
}

function collectParsedAssistantTranscriptRoleInsertions(
  ir: MarkdownIR,
  options: StripMarkdownOptions,
): PlainTextInsertion[] {
  if (options.assistantTranscriptRoleHeaders !== true) {
    return [];
  }
  const prefix = options.assistantTranscriptRolePrefix ?? "[assistant-authored transcript] ";
  if (!prefix) {
    return [];
  }
  return (ir.annotations ?? [])
    .filter((annotation) => annotation.type === "assistant_transcript_role")
    .map((annotation) => ({ position: annotation.start, text: prefix }));
}

function applyPlainTextInsertions(text: string, insertions: PlainTextInsertion[]): string {
  if (insertions.length === 0) {
    return text;
  }
  const sorted = insertions.toSorted((a, b) => a.position - b.position);
  let output = "";
  let cursor = 0;
  for (const insertion of sorted) {
    const position = Math.max(cursor, Math.min(insertion.position, text.length));
    output += text.slice(cursor, position);
    output += insertion.text;
    cursor = position;
  }
  return output + text.slice(cursor);
}

/** Parse Markdown, then protect role headers exposed by the final plain-text projection. */
export function stripMarkdown(text: string, options: StripMarkdownOptions = {}): string {
  // The IR parser preserves links when role annotations are enabled so this
  // plain-text projection can still append explicit destinations. Direct rich
  // renderers suppress overlapping active links later at their own boundary.
  const ir = markdownToIR(text, {
    assistantTranscriptRoleHeaders: options.assistantTranscriptRoleHeaders,
    autolink: false,
    blockquotePrefix: "",
    headingStyle: "none",
    horizontalRuleText: "",
    linkify: false,
    preserveSourceBlockSpacing: true,
    tableMode: "bullets",
  });
  // Detect against the exact leading boundary transports receive. String.trim
  // removes Unicode whitespace that the transcript header grammar intentionally
  // does not treat as Markdown indentation.
  const plainText = applyPlainTextInsertions(ir.text, [
    ...collectLinkInsertions(ir, options),
    ...collectParsedAssistantTranscriptRoleInsertions(ir, options),
  ]).trim();
  return applyPlainTextInsertions(
    plainText,
    collectAssistantTranscriptRoleInsertions(plainText, options),
  ).trim();
}
