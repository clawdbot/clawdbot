// Telegram progress-draft formatting and HTML preview rendering.
import type { ChannelProgressDraftCompositorLine } from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramDraftPreview } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  boldRichText,
  codeRichText,
  italicRichText,
  paragraphBlock,
  type InputRichBlock,
  type RichText,
} from "./rich-block-model.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";
import { buildTelegramRichBlocksPlan } from "./rich-message.js";
import { clipTelegramProgressText } from "./truncate.js";

function sanitizeProgressMarkdownText(text: string): string {
  return text.replaceAll("`", "'");
}

function formatProgressAsMarkdownCode(text: string): string {
  const clipped = clipTelegramProgressText(text);
  return `\`${sanitizeProgressMarkdownText(clipped)}\``;
}

export function formatTelegramProgressLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("_") && trimmed.endsWith("_")
    ? trimmed
    : formatProgressAsMarkdownCode(text);
}

function escapeTelegramProgressHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTelegramProgressStringLine(text: string): string {
  // Reasoning/commentary lanes carry model-authored markdown. Render through
  // renderTelegramHtmlText (parse_mode HTML-safe), not the full rich block
  // converter — block output from headings/lists can reject the edit.
  const trimmed = text.trim();
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "")}_`
    : clipTelegramProgressText(trimmed);
  return renderTelegramHtmlText(clipped);
}

function renderTelegramProgressLine(line: ChannelProgressDraftCompositorLine): string {
  if (typeof line === "string") {
    return line.split(/\r?\n/u).map(renderTelegramProgressStringLine).filter(Boolean).join("<br>");
  }
  if (!line.icon && line.label === "Commentary") {
    return line.text
      .split(/\r?\n/u)
      .map(renderTelegramProgressStringLine)
      .filter(Boolean)
      .join("<br>");
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts = [`<b>${escapeTelegramProgressHtml(label)}</b>`];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(`<code>${escapeTelegramProgressHtml(clipTelegramProgressText(detail))}</code>`);
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      parts.push(`<code>${escapeTelegramProgressHtml(clipTelegramProgressText(text))}</code>`);
    }
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(`<i>${escapeTelegramProgressHtml(line.status)}</i>`);
  }
  return parts.join(" ");
}

function joinRichText(parts: RichText[], separator: string): RichText {
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0] ?? "";
  }
  const result: RichText[] = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      result.push(separator);
    }
    result.push(part);
  }
  return result;
}

function markdownLineToRichText(text: string): RichText {
  const trimmed = text.trim();
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "")}_`
    : clipTelegramProgressText(trimmed);
  const { blocks } = markdownToTelegramRichBlocks(clipped, { skipEntityDetection: true });
  const first = blocks[0];
  if (first?.type === "paragraph") {
    return first.text;
  }
  return clipped;
}

function progressLineToRichText(line: ChannelProgressDraftCompositorLine): RichText | undefined {
  if (typeof line === "string") {
    const parts = line
      .split(/\r?\n/u)
      .map(markdownLineToRichText)
      .filter((part) => part !== "");
    return parts.length ? joinRichText(parts, "\n") : undefined;
  }
  if (!line.icon && line.label === "Commentary") {
    const parts = line.text
      .split(/\r?\n/u)
      .map(markdownLineToRichText)
      .filter((part) => part !== "");
    return parts.length ? joinRichText(parts, "\n") : undefined;
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts: RichText[] = [boldRichText(label)];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(codeRichText(clipTelegramProgressText(detail)));
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      parts.push(codeRichText(clipTelegramProgressText(text)));
    }
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(italicRichText(line.status));
  }
  return joinRichText(parts, " ");
}

function buildProgressRichBlocks(parts: RichText[]): InputRichBlock[] {
  return [paragraphBlock(joinRichText(parts, "\n"))];
}

export function renderTelegramProgressDraftPreview(
  text: string,
  lines: readonly ChannelProgressDraftCompositorLine[],
  richMessages: boolean,
  statusHeadlineActive = false,
): TelegramDraftPreview {
  const trimmed = text.trimEnd();
  if (statusHeadlineActive) {
    const statusLines = trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!richMessages) {
      const html =
        statusLines.length > 1
          ? [
              `<b>${escapeTelegramProgressHtml(statusLines[0] ?? "")}</b>`,
              ...statusLines.slice(1).map(renderTelegramProgressStringLine),
            ].join("<br>")
          : statusLines.map(renderTelegramProgressStringLine).join("<br>");
      return { text: html, parseMode: "HTML" };
    }
    const richParts: RichText[] =
      statusLines.length > 1
        ? [boldRichText(statusLines[0] ?? ""), ...statusLines.slice(1).map(markdownLineToRichText)]
        : statusLines.map(markdownLineToRichText);
    return {
      text: trimmed,
      richMessage: buildTelegramRichBlocksPlan(buildProgressRichBlocks(richParts), {
        skipEntityDetection: true,
        plainText: trimmed,
      }).richMessage,
    };
  }
  const renderedLines = lines.map(renderTelegramProgressLine).filter(Boolean);
  const textLines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = textLines.length > renderedLines.length ? textLines[0] : undefined;
  if (!richMessages) {
    const htmlParts = heading
      ? [`<b>${escapeTelegramProgressHtml(heading)}</b>`, ...renderedLines]
      : renderedLines;
    return { text: htmlParts.join("<br>"), parseMode: "HTML" };
  }
  const richLineParts = lines
    .map(progressLineToRichText)
    .filter((part): part is RichText => part !== undefined);
  const richParts = heading ? [boldRichText(heading), ...richLineParts] : richLineParts;
  return {
    text: trimmed,
    richMessage: buildTelegramRichBlocksPlan(buildProgressRichBlocks(richParts), {
      skipEntityDetection: true,
      plainText: trimmed,
    }).richMessage,
  };
}
