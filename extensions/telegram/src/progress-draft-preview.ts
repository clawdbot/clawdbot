import {
  compactChannelProgressDraftLine,
  formatChannelProgressDraftDiffStat,
  isChannelProgressAttentionLine,
  selectPlanChecklistSteps,
  type ChannelProgressDraftCompositorLine,
  type ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramDraftPreview } from "./draft-stream.js";
import { escapeTelegramHtml, renderTelegramHtmlText } from "./format.js";
import {
  boldRichText,
  italicRichText,
  paragraphBlock,
  type InputRichBlock,
  type RichText,
} from "./rich-block-model.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";
import { buildTelegramRichBlocksPlan } from "./rich-message.js";

// Each row has one content decision; both Telegram transports use that row.
type ProgressText = { html: string; rich: RichText };

function literalProgressText(text: string, style?: "bold" | "italic"): ProgressText {
  const escaped = escapeTelegramHtml(text);
  return style === "bold"
    ? { html: `<b>${escaped}</b>`, rich: boldRichText(text) }
    : style === "italic"
      ? { html: `<i>${escaped}</i>`, rich: italicRichText(text) }
      : { html: escaped, rich: text };
}

function joinProgressText(parts: ProgressText[], separator: string): ProgressText {
  return {
    html: parts.map((part) => part.html).join(separator === "\n" ? "<br>" : separator),
    rich: parts.flatMap((part, index) => (index ? [separator, part.rich] : [part.rich])),
  };
}

function markdownProgressText(text: string): ProgressText {
  const { blocks } = markdownToTelegramRichBlocks(text, { skipEntityDetection: true });
  return {
    html: renderTelegramHtmlText(text),
    rich: blocks[0]?.type === "paragraph" ? blocks[0].text : text,
  };
}

function progressLineText(
  line: ChannelProgressDraftCompositorLine,
  maxLineChars: number,
): ProgressText {
  const compact = (text: string) => compactChannelProgressDraftLine(text, maxLineChars);
  if (typeof line === "string" || (!line.icon && (!line.label || line.label === "Commentary"))) {
    // Reasoning/commentary retain authored Markdown; checklist labels stay literal.
    const text = compact(typeof line === "string" ? line : line.text);
    return markdownProgressText(text);
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts = [literalProgressText(label, "bold")];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(literalProgressText(compact(detail)));
  } else if (line.text.trim() && line.text.trim() !== label) {
    parts.push(literalProgressText(compact(line.text)));
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(literalProgressText(line.status, "italic"));
  }
  return joinProgressText(parts, " ");
}

export function renderTelegramProgressDraftPreview(
  snapshot: ChannelProgressDraftCompositorSnapshot,
  options: { richMessages: boolean; maxLines: number; maxLineChars: number },
): TelegramDraftPreview {
  const { maxLines, maxLineChars } = options;
  const activity =
    snapshot.statusHeadline || snapshot.plan?.length
      ? snapshot.lines.filter(
          (line) =>
            typeof line !== "string" &&
            !line.id?.startsWith("reasoning:") &&
            !line.id?.startsWith("commentary:"),
        )
      : snapshot.lines;
  const attention = activity.filter(isChannelProgressAttentionLine);
  const checklist = selectPlanChecklistSteps(snapshot.plan ?? [], {
    maxLines: maxLines - attention.length,
  });
  const checklistLines = checklist.steps.length + (checklist.summary ? 1 : 0);
  const lineBudget = Math.max(0, maxLines - checklistLines);
  const lines = [...activity.filter((line) => !isChannelProgressAttentionLine(line)), ...attention];
  const visibleLines = lineBudget ? lines.slice(-lineBudget) : [];
  const diffStat =
    visibleLines.length + checklistLines < maxLines
      ? formatChannelProgressDraftDiffStat(snapshot.diffStat)
      : undefined;
  const label =
    checklistLines || visibleLines.length + (diffStat ? 1 : 0) < maxLines
      ? snapshot.label
      : undefined;
  const blocks: InputRichBlock[] = [];
  const html: string[] = [];
  const addParagraph = (text: ProgressText) => {
    blocks.push(paragraphBlock(text.rich));
    html.push(text.html);
  };
  if (label) {
    addParagraph(literalProgressText(compactChannelProgressDraftLine(label, maxLineChars), "bold"));
  }
  if (snapshot.statusHeadline) {
    const status = markdownProgressText(
      compactChannelProgressDraftLine(snapshot.statusHeadline, maxLineChars),
    );
    addParagraph(
      label
        ? status
        : {
            html: `<b>${status.html}</b>`,
            rich: { type: "bold", text: status.rich },
          },
    );
  }
  if (visibleLines.length) {
    addParagraph(
      joinProgressText(
        visibleLines.map((line) => progressLineText(line, maxLineChars)),
        "\n",
      ),
    );
  }
  if (checklist.summary) {
    addParagraph(
      literalProgressText(compactChannelProgressDraftLine(checklist.summary, maxLineChars)),
    );
  }
  if (checklist.steps.length) {
    blocks.push({
      type: "list",
      items: checklist.steps.map((step) => {
        const active = step.status === "in_progress";
        const text = literalProgressText(
          compactChannelProgressDraftLine(
            active ? `${step.step} (in progress)` : step.step,
            maxLineChars,
          ),
          active ? "bold" : undefined,
        );
        const completed = step.status === "completed";
        html.push(`${completed ? "[x]" : "[ ]"} ${text.html}`);
        return {
          blocks: [paragraphBlock(text.rich)],
          has_checkbox: true as const,
          is_checked: completed || undefined,
        };
      }),
    });
  }
  if (diffStat) {
    addParagraph(literalProgressText(compactChannelProgressDraftLine(diffStat, maxLineChars)));
  }
  const plan = buildTelegramRichBlocksPlan(blocks, { skipEntityDetection: true });
  return options.richMessages
    ? { text: plan.plainText, richMessage: plan.richMessage, complete: true }
    : { text: html.join("<br>"), parseMode: "HTML", complete: true };
}
