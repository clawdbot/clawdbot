import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FormatCapabilityProfile,
  markdownToIR,
  type MarkdownIR,
  renderMarkdownWithAttributedRanges,
  renderMarkdownIRChunksWithinLimit,
} from "openclaw/plugin-sdk/text-chunking";

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

type SignalMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

const SIGNAL_STYLE_MAP = {
  bold: "BOLD",
  italic: "ITALIC",
  strikethrough: "STRIKETHROUGH",
  code: "MONOSPACE",
  code_block: "MONOSPACE",
  spoiler: "SPOILER",
} as const;

const SIGNAL_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "ranges",
  constructs: {
    underline: "strip",
    codeLanguage: "fallback",
    linkLabel: "fallback",
    heading: "fallback",
    bulletList: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
    blockquote: "fallback",
    image: "fallback",
    mention: "strip",
  },
  // Signal clients switch beyond 2 KiB bytes; byte-aware chunking remains an open question.
  chunk: { limit: 4_000, unit: "chars" },
});

function stripEquivalentSignalLinks(ir: MarkdownIR): MarkdownIR {
  const normalize = (value: string) =>
    normalizeLowercaseStringOrEmpty(value)
      .replace(/^(?:https?:\/\/)?(?:www\.)?/, "")
      .replace(/\/+$/, "");
  // Core owns link suffixes; Signal retains its established normalized-URL de-duplication.
  return {
    ...ir,
    links: ir.links.filter((link) => {
      const label = ir.text.slice(link.start, link.end).trim();
      return normalize(label) !== normalize(link.href.trim().replace(/^mailto:/, ""));
    }),
  };
}

function renderSignalText(ir: MarkdownIR): SignalFormattedText {
  const rendered = renderMarkdownWithAttributedRanges(
    stripEquivalentSignalLinks(ir),
    {
      styleMap: SIGNAL_STYLE_MAP,
      annotationStyleMap: { assistant_transcript_role: "MONOSPACE" },
      trimEnd: true,
    },
    SIGNAL_FORMAT_PROFILE,
  );
  return { text: rendered.text, styles: rendered.ranges };
}

function markdownToSignalIR(markdown: string, options: SignalMarkdownOptions): MarkdownIR {
  return markdownToIR(markdown ?? "", {
    assistantTranscriptRoleHeaders: true,
    linkify: true,
    enableSpoilers: true,
    headingStyle: "rich",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
}

export function markdownToSignalText(
  markdown: string,
  options: SignalMarkdownOptions = {},
): SignalFormattedText {
  return renderSignalText(markdownToSignalIR(markdown, options));
}

export function markdownToSignalTextChunks(
  markdown: string,
  limit: number,
  options: SignalMarkdownOptions = {},
): SignalFormattedText[] {
  const ir = markdownToSignalIR(markdown, options);
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    assistantTranscriptRoleMessageBoundaries: true,
    renderChunk: renderSignalText,
    measureRendered: (rendered) => rendered.text.length,
  }).map(({ rendered }) => rendered);
}
