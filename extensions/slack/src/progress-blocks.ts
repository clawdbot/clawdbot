import type { Block, KnownBlock } from "@slack/web-api";
import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-streaming";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_PROGRESS_FIELD_MAX = 1800;
const DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS = 120;

function field(text: string) {
  return {
    type: "mrkdwn" as const,
    text: truncateSlackText(text, SLACK_PROGRESS_FIELD_MAX),
  };
}

function lineTitle(line: ChannelProgressDraftLine): string {
  return `${line.icon ?? "•"} *${escapeSlackMrkdwn(line.label)}*`;
}

function compactDetail(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 1) {
    return "…";
  }
  const keepStart = Math.max(1, Math.ceil((maxChars - 1) * 0.45));
  const keepEnd = Math.max(1, maxChars - keepStart - 1);
  return `${chars.slice(0, keepStart).join("").trimEnd()}…${chars
    .slice(-keepEnd)
    .join("")
    .trimStart()}`;
}

function lineDetail(line: ChannelProgressDraftLine, maxChars: number): string {
  const parts = [
    line.detail,
    line.status && !line.detail?.includes(line.status) ? line.status : undefined,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length ? escapeSlackMrkdwn(compactDetail(parts.join(" · "), maxChars)) : " ";
}

export function buildSlackProgressDraftBlocks(params: {
  label?: string;
  lines: readonly ChannelProgressDraftLine[];
  maxLineChars?: number;
}): (Block | KnownBlock)[] | undefined {
  const label = params.label?.trim();
  const maxLineChars =
    params.maxLineChars && params.maxLineChars > 0
      ? Math.floor(params.maxLineChars)
      : DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS;
  const renderedBlocks: (Block | KnownBlock)[] = [
    ...(label
      ? [
          {
            type: "section" as const,
            text: field(`*${escapeSlackMrkdwn(label)}*`),
          },
        ]
      : []),
    ...params.lines.map((line) => ({
      type: "section",
      fields: [field(lineTitle(line)), field(lineDetail(line, maxLineChars))],
    })),
  ].slice(-SLACK_MAX_BLOCKS);
  const blocks: (Block | KnownBlock)[] = renderedBlocks;
  return blocks.length ? blocks : undefined;
}
