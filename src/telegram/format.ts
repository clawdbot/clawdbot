import {
  chunkMarkdownIR,
  markdownToIR,
  type MarkdownLinkSpan,
  type MarkdownIR,
} from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";
import type { MarkdownTableMode } from "../config/types.base.js";

export type TelegramFormattedChunk = {
  html: string;
  text: string;
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function buildTelegramLink(link: MarkdownLinkSpan, _text: string) {
  const href = link.href.trim();
  if (!href) return null;
  if (link.start === link.end) return null;
  const safeHref = escapeHtmlAttr(href);
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${safeHref}">`,
    close: "</a>",
  };
}

function renderTelegramHtml(ir: MarkdownIR): string {
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: {
      bold: { open: "<b>", close: "</b>" },
      italic: { open: "<i>", close: "</i>" },
      strikethrough: { open: "<s>", close: "</s>" },
      code: { open: "<code>", close: "</code>" },
      code_block: { open: "<pre><code>", close: "</code></pre>" },
    },
    escapeText: escapeHtml,
    buildLink: buildTelegramLink,
  });
}

export function markdownToTelegramHtml(
  markdown: string,
  options: { tableMode?: MarkdownTableMode } = {},
): string {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  return renderTelegramHtml(ir);
}

export function renderTelegramHtmlText(
  text: string,
  options: { textMode?: "markdown" | "html"; tableMode?: MarkdownTableMode } = {},
): string {
  const textMode = options.textMode ?? "markdown";
  if (textMode === "html") return text;
  return markdownToTelegramHtml(text, { tableMode: options.tableMode });
}

export function markdownToTelegramChunks(
  markdown: string,
  limit: number,
  options: { tableMode?: MarkdownTableMode } = {},
): TelegramFormattedChunk[] {
  const ir = markdownToIR(markdown ?? "", {
    linkify: true,
    headingStyle: "none",
    blockquotePrefix: "",
    tableMode: options.tableMode,
  });
  const chunks = chunkMarkdownIR(ir, limit);
  return (
    chunks
      .map((chunk) => ({
        html: renderTelegramHtml(chunk),
        text: chunk.text,
      }))
      // Filter out empty chunks produced by thematic breaks (---/***/___),
      // empty blockquotes, or headings without text.  These render to empty
      // HTML and would cause Telegram API "message text is empty" errors.
      // See #3011.
      .filter((chunk) => chunk.html.trim().length > 0)
  );
}

export function markdownToTelegramHtmlChunks(markdown: string, limit: number): string[] {
  return markdownToTelegramChunks(markdown, limit).map((chunk) => chunk.html);
}
