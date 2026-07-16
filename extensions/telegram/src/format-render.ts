import {
  type MarkdownIR,
  type MarkdownLinkSpan,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";

type TelegramRenderLink = {
  start: number;
  end: number;
  open: string;
  close: string;
};

export function renderTelegramMarkdownIR(
  ir: MarkdownIR,
  options: {
    escapeText: (text: string) => string;
    buildLink: (link: MarkdownLinkSpan, text: string) => TelegramRenderLink | null;
    buildCodeBlockOpen: (span: { language?: string }) => string;
  },
): string {
  return renderMarkdownWithMarkers(ir, {
    annotationMarkers: {
      assistant_transcript_role: {
        open: "<code>",
        close: "</code>",
        suppressNestedFormatting: true,
      },
    },
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: options.buildCodeBlockOpen, close: "</code></pre>" },
      spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
      blockquote: { open: "<blockquote>", close: "</blockquote>" },
      heading_1: { open: "<h1>", close: "</h1>" },
      heading_2: { open: "<h2>", close: "</h2>" },
      heading_3: { open: "<h3>", close: "</h3>" },
      heading_4: { open: "<h4>", close: "</h4>" },
      heading_5: { open: "<h5>", close: "</h5>" },
      heading_6: { open: "<h6>", close: "</h6>" },
    },
    escapeText: options.escapeText,
    buildLink: options.buildLink,
  });
}
