import type { Block, KnownBlock } from "@slack/web-api";
import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-streaming";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_PROGRESS_FIELD_MAX = 1800;
const SLACK_PROGRESS_DETAIL_MAX_CHARS = 48;

function field(text: string) {
  return {
    type: "mrkdwn" as const,
    text: truncateSlackText(text, SLACK_PROGRESS_FIELD_MAX),
  };
}

function lineTitle(line: ChannelProgressDraftLine): string {
  return `${line.icon ?? "•"} *${escapeSlackMrkdwn(line.label)}*`;
}

function compactDetail(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= SLACK_PROGRESS_DETAIL_MAX_CHARS) {
    return normalized;
  }
  const keepStart = Math.ceil((SLACK_PROGRESS_DETAIL_MAX_CHARS - 1) * 0.45);
  const keepEnd = SLACK_PROGRESS_DETAIL_MAX_CHARS - keepStart - 1;
  return `${chars.slice(0, keepStart).join("").trimEnd()}…${chars
    .slice(-keepEnd)
    .join("")
    .trimStart()}`;
}

function lineDetail(line: ChannelProgressDraftLine): string {
  const parts = [
    line.detail,
    line.status && !line.detail?.includes(line.status) ? line.status : undefined,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length ? escapeSlackMrkdwn(compactDetail(parts.join(" · "))) : " ";
}

export function buildSlackProgressDraftBlocks(params: {
  label?: string;
  lines: readonly ChannelProgressDraftLine[];
}): (Block | KnownBlock)[] | undefined {
  const blocks: (Block | KnownBlock)[] = [];
  const label = params.label?.trim();
  if (label) {
    blocks.push({
      type: "section",
      text: field(`*${escapeSlackMrkdwn(label)}*`),
    });
  }
  const availableLineBlocks = Math.max(0, SLACK_MAX_BLOCKS - blocks.length);
  for (const line of params.lines.slice(-availableLineBlocks)) {
    blocks.push({
      type: "section",
      fields: [field(lineTitle(line)), field(lineDetail(line))],
    });
  }
  return blocks.length ? blocks : undefined;
}
