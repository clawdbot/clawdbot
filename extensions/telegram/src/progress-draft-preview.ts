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
import { clipTelegramProgressText, TELEGRAM_PROGRESS_MAX_CHARS } from "./truncate.js";

function sanitizeProgressMarkdownText(text: string): string {
  return text.replaceAll("`", "'");
}

function formatProgressAsMarkdownCode(text: string, maxLineChars: number): string {
  const clipped = clipTelegramProgressText(text, maxLineChars);
  return `\`${sanitizeProgressMarkdownText(clipped)}\``;
}

export function formatTelegramProgressLine(
  text: string,
  maxLineChars: number = TELEGRAM_PROGRESS_MAX_CHARS,
): string {
  const trimmed = text.trim();
  return trimmed.startsWith("_") && trimmed.endsWith("_")
    ? trimmed
    : formatProgressAsMarkdownCode(text, maxLineChars);
}

function escapeTelegramProgressHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clipTelegramProgressDetail(
  detail: string,
  label: string,
  maxLineChars: number,
  reservedChars = 0,
): string {
  // Mirror the shared compact renderer: the label prefix shares the line
  // budget, and the canonical compaction keeps the detail's useful prefix and
  // suffix around a middle ellipsis instead of blindly cutting the tail.
  // `reservedChars` is what the rest of the composed line (the status tail)
  // already consumes, so the label + detail + status line stays within one
  // line budget like the shared renderer's whole-line cap.
  const lineBudget = maxLineChars - reservedChars;
  const prefix = `${label}: `;
  const compacted = clipTelegramProgressText(`${prefix}${detail}`, lineBudget);
  if (compacted.startsWith(prefix)) {
    return compacted.slice(prefix.length);
  }
  // The canonical compactor keeps the label only while the remaining detail
  // budget still reaches its eight-character minimum. For a valid budget
  // shorter than that, reserve the label and its rendered separator before
  // clipping the fallback detail.
  const detailBudget = lineBudget - Array.from(`${label} `).length;
  return detailBudget >= 1 ? clipTelegramProgressText(detail, detailBudget) : "";
}

function clipTelegramProgressLabel(label: string, maxLineChars: number): string {
  // Structured labels stay verbatim while they fit; a label longer than the
  // configured budget is itself compacted so the composed line can never
  // exceed the budget through its label half alone.
  return Array.from(label).length > maxLineChars
    ? clipTelegramProgressText(label, maxLineChars)
    : label;
}

type TelegramProgressLineParts = {
  label: string;
  detail: string | undefined;
  status: string | undefined;
};

function resolveTelegramProgressLineParts(
  line: Exclude<ChannelProgressDraftCompositorLine, string>,
  maxLineChars: number,
): TelegramProgressLineParts {
  const label = clipTelegramProgressLabel(
    [line.icon, line.label].filter(Boolean).join(" "),
    maxLineChars,
  );
  const labelLength = Array.from(label).length;
  // The shared renderer bounds the whole composed line, status tail included,
  // so reserve the label and status halves before the detail sees a budget.
  const rawStatus =
    line.status && line.status !== "completed" && line.status !== line.detail
      ? line.status
      : undefined;
  // Reserve the joining separator before allocating status characters; when
  // the label already fills the whole-line budget there is no room left for
  // the status tail, so omit it instead of overflowing the visible line.
  const statusBudget = maxLineChars - labelLength - 1;
  const status =
    rawStatus && statusBudget >= 1 ? clipTelegramProgressText(rawStatus, statusBudget) : undefined;
  const statusLength = status ? Array.from(status).length + 1 : 0;
  const rawDetail = line.detail && line.detail !== line.label ? line.detail : undefined;
  const detail = rawDetail
    ? clipTelegramProgressDetail(rawDetail, label, maxLineChars, statusLength)
    : undefined;
  return { label, detail, status };
}

function renderTelegramProgressStringLine(text: string, maxLineChars: number): string {
  // Reasoning/commentary lanes carry model-authored markdown. Render through
  // renderTelegramHtmlText (parse_mode HTML-safe), not the full rich block
  // converter — block output from headings/lists can reject the edit.
  const trimmed = text.trim();
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "", maxLineChars)}_`
    : clipTelegramProgressText(trimmed, maxLineChars);
  return renderTelegramHtmlText(clipped);
}

function renderTelegramProgressText(text: string, maxLineChars: number): string {
  return text
    .split(/\r?\n/u)
    .map((line) => renderTelegramProgressStringLine(line, maxLineChars))
    .filter(Boolean)
    .join("<br>");
}

function renderTelegramProgressLine(
  line: ChannelProgressDraftCompositorLine,
  maxLineChars: number,
): string {
  if (typeof line === "string") {
    return renderTelegramProgressText(line, maxLineChars);
  }
  if (!line.icon && (!line.label || line.label === "Commentary")) {
    return renderTelegramProgressText(line.text, maxLineChars);
  }
  const { label, detail, status } = resolveTelegramProgressLineParts(line, maxLineChars);
  const labelLength = Array.from(label).length;
  const statusLength = status ? Array.from(status).length + 1 : 0;
  const parts = [`<b>${escapeTelegramProgressHtml(label)}</b>`];
  if (detail) {
    parts.push(`<code>${escapeTelegramProgressHtml(detail)}</code>`);
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      const textBudget = maxLineChars - labelLength - 1 - statusLength;
      if (textBudget >= 1) {
        parts.push(
          `<code>${escapeTelegramProgressHtml(clipTelegramProgressText(text, textBudget))}</code>`,
        );
      }
    }
  }
  if (status) {
    parts.push(`<i>${escapeTelegramProgressHtml(status)}</i>`);
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

function markdownLineToRichText(text: string, maxLineChars: number): RichText {
  const trimmed = text.trim();
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "", maxLineChars)}_`
    : clipTelegramProgressText(trimmed, maxLineChars);
  const { blocks } = markdownToTelegramRichBlocks(clipped, { skipEntityDetection: true });
  const first = blocks[0];
  if (first?.type === "paragraph") {
    return first.text;
  }
  return clipped;
}

function progressTextToRichText(text: string, maxLineChars: number): RichText | undefined {
  const parts = text
    .split(/\r?\n/u)
    .map((line) => markdownLineToRichText(line, maxLineChars))
    .filter((part) => part !== "");
  return parts.length ? joinRichText(parts, "\n") : undefined;
}

function progressLineToRichText(
  line: ChannelProgressDraftCompositorLine,
  maxLineChars: number,
): RichText | undefined {
  if (typeof line === "string") {
    return progressTextToRichText(line, maxLineChars);
  }
  if (!line.icon && (!line.label || line.label === "Commentary")) {
    return progressTextToRichText(line.text, maxLineChars);
  }
  const { label, detail, status } = resolveTelegramProgressLineParts(line, maxLineChars);
  const labelLength = Array.from(label).length;
  const statusLength = status ? Array.from(status).length + 1 : 0;
  const parts: RichText[] = [boldRichText(label)];
  if (detail) {
    parts.push(codeRichText(detail));
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      const textBudget = maxLineChars - labelLength - 1 - statusLength;
      if (textBudget >= 1) {
        parts.push(codeRichText(clipTelegramProgressText(text, textBudget)));
      }
    }
  }
  if (status) {
    parts.push(italicRichText(status));
  }
  return joinRichText(parts, " ");
}

function buildProgressRichBlocks(parts: RichText[]): InputRichBlock[] {
  return [paragraphBlock(joinRichText(parts, "\n"))];
}

function isStatusHeadlineWorkLine(
  line: ChannelProgressDraftCompositorLine,
): line is Exclude<ChannelProgressDraftCompositorLine, string> {
  if (typeof line === "string") {
    return false;
  }
  return !line.id?.startsWith("reasoning:") && !line.id?.startsWith("commentary:");
}

export function renderTelegramProgressDraftPreview(
  text: string,
  lines: readonly ChannelProgressDraftCompositorLine[],
  richMessages: boolean,
  statusHeadlineActive = false,
  maxLineChars: number = TELEGRAM_PROGRESS_MAX_CHARS,
): TelegramDraftPreview {
  const trimmed = text.trimEnd();
  if (statusHeadlineActive) {
    const statusLines = trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    // The first status line is the draft's headline. It carries the shared
    // narration's own 280-character cap, not the configured per-line budget,
    // so bound it here with the same resolved budget as every other visible
    // line in both HTML and rich-message mode.
    const headline = statusLines[0] ? clipTelegramProgressText(statusLines[0], maxLineChars) : "";
    const workLines = lines.filter(isStatusHeadlineWorkLine);
    const renderedLines = workLines
      .map((line) => renderTelegramProgressLine(line, maxLineChars))
      .filter(Boolean);
    if (!richMessages) {
      const renderedStatusLines =
        statusLines.length > 1
          ? [
              `<b>${escapeTelegramProgressHtml(headline)}</b>`,
              ...statusLines
                .slice(1)
                .map((line) => renderTelegramProgressStringLine(line, maxLineChars)),
            ]
          : statusLines.map((line) => renderTelegramProgressStringLine(line, maxLineChars));
      return { text: [...renderedStatusLines, ...renderedLines].join("<br>"), parseMode: "HTML" };
    }
    const richStatusParts: RichText[] =
      statusLines.length > 1
        ? [
            boldRichText(headline),
            ...statusLines.slice(1).map((line) => markdownLineToRichText(line, maxLineChars)),
          ]
        : statusLines.map((line) => markdownLineToRichText(line, maxLineChars));
    const richLineParts = workLines
      .map((line) => progressLineToRichText(line, maxLineChars))
      .filter((part): part is RichText => part !== undefined);
    const plainLineTexts = workLines
      .map((line) => line.text)
      .map((line) => line.trim())
      .filter(Boolean);
    const plainText = [headline, ...statusLines.slice(1), ...plainLineTexts]
      .filter(Boolean)
      .join("\n");
    return {
      text: plainText,
      richMessage: buildTelegramRichBlocksPlan(
        buildProgressRichBlocks([...richStatusParts, ...richLineParts]),
        {
          skipEntityDetection: true,
          plainText,
        },
      ).richMessage,
    };
  }
  const renderedLines = lines
    .map((line) => renderTelegramProgressLine(line, maxLineChars))
    .filter(Boolean);
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
    .map((line) => progressLineToRichText(line, maxLineChars))
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
