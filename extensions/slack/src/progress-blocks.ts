// Slack plugin module implements progress blocks behavior.
import { createHash } from "node:crypto";
import type { AnyChunk } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_PROGRESS_FIELD_MAX = 1800;
const DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS = 120;
const DEFAULT_SLACK_PROGRESS_TASK_DETAIL_MAX_CHARS = 48;
const SLACK_PROGRESS_CHUNK_TEXT_MAX = 256;
const SLACK_PROGRESS_TASK_TITLE_MAX = 120;
const SLACK_PROGRESS_PLAN_FALLBACK_TITLE = "Thinking";

type SlackPlanTaskStatus = "in_progress" | "complete" | "error";

type SlackPlanTask = {
  id: string;
  title: string;
  status: SlackPlanTaskStatus;
};

function field(text: string) {
  return {
    type: "mrkdwn" as const,
    text: truncateSlackText(text, SLACK_PROGRESS_FIELD_MAX),
  };
}

function resolveMaxLineChars(value: number | undefined, fallback: number): number {
  return value && value > 0 ? Math.floor(value) : fallback;
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

function compactTitle(value: string): string {
  return truncateSlackText(value.replace(/\s+/g, " ").trim(), SLACK_PROGRESS_TASK_TITLE_MAX);
}

function compactChunkText(value: string): string {
  return truncateSlackText(value.replace(/\s+/g, " ").trim(), SLACK_PROGRESS_CHUNK_TEXT_MAX);
}

function lineDetailParts(line: ChannelProgressDraftLine): string[] {
  return [line.detail, line.status && !line.detail?.includes(line.status) ? line.status : undefined]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
}

function legacyLineTitle(line: ChannelProgressDraftLine): string {
  return `${line.icon ?? "•"} *${escapeSlackMrkdwn(line.label)}*`;
}

function legacyLineDetail(line: ChannelProgressDraftLine, maxChars: number): string {
  const detail = lineDetailParts(line).join(" · ");
  return detail ? escapeSlackMrkdwn(compactDetail(detail, maxChars)) : "—";
}

function lineTaskTitle(line: ChannelProgressDraftLine, maxLineChars: number): string {
  const label = line.label.replace(/\s+/g, " ").trim() || line.toolName || line.kind || "Update";
  const detail = lineDetailParts(line).join(" · ");
  const fallback = line.text.replace(/\s+/g, " ").trim();
  if (detail) {
    return compactTitle(`${label} — ${compactDetail(detail, maxLineChars)}`);
  }
  if (fallback && fallback !== label) {
    return compactTitle(fallback);
  }
  return compactTitle(label);
}

function lineTaskStatus(line: ChannelProgressDraftLine): SlackPlanTaskStatus {
  const normalized = line.status?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return "in_progress";
  }
  if (
    normalized === "complete" ||
    normalized === "completed" ||
    normalized === "done" ||
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "successful" ||
    normalized === "exit 0"
  ) {
    return "complete";
  }
  if (
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "failure" ||
    normalized.startsWith("exit ")
  ) {
    return normalized === "exit 0" ? "complete" : "error";
  }
  return "in_progress";
}

function slugTaskIdPart(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "task";
}

function stableTaskIdPart(value: string): string {
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${slugTaskIdPart(value)}_${suffix}`;
}

function buildPlanTasks(params: {
  lines: readonly ChannelProgressDraftLine[];
  maxLineChars?: number;
}): SlackPlanTask[] {
  const maxLineChars = resolveMaxLineChars(
    params.maxLineChars,
    DEFAULT_SLACK_PROGRESS_TASK_DETAIL_MAX_CHARS,
  );
  return params.lines.slice(-SLACK_MAX_BLOCKS).map((line, index) => ({
    id: line.id
      ? stableTaskIdPart(line.id)
      : `${slugTaskIdPart(line.toolName ?? line.kind ?? line.label)}_${index + 1}`,
    title: lineTaskTitle(line, maxLineChars),
    status: lineTaskStatus(line),
  }));
}

function resolvePlanTitle(params: {
  label?: string;
  title?: string;
  tasks: readonly SlackPlanTask[];
}): string {
  return compactChunkText(
    params.title?.trim() ||
      params.label?.trim() ||
      params.tasks.at(-1)?.title ||
      SLACK_PROGRESS_PLAN_FALLBACK_TITLE,
  );
}

function buildSlackProgressStreamChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  maxLineChars?: number;
  completeInProgress?: boolean;
  finalInProgressStatus?: SlackPlanTaskStatus;
}): AnyChunk[] | undefined {
  const tasks = buildPlanTasks({ lines: params.lines, maxLineChars: params.maxLineChars });
  if (tasks.length === 0) {
    return undefined;
  }
  const title = resolvePlanTitle({ label: params.label, title: params.title, tasks });
  const chunks: AnyChunk[] = [
    {
      type: "plan_update",
      title,
    },
    ...tasks.map((task) => ({
      type: "task_update" as const,
      id: task.id,
      title: task.title,
      status:
        task.status === "in_progress"
          ? (params.finalInProgressStatus ?? (params.completeInProgress ? "complete" : task.status))
          : task.status,
    })),
  ];
  return chunks;
}

export function buildSlackProgressDraftBlocks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  maxLineChars?: number;
}): (Block | KnownBlock)[] | undefined {
  const label = params.label?.trim() || params.title?.trim();
  const maxLineChars = resolveMaxLineChars(
    params.maxLineChars,
    DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS,
  );
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
      type: "section" as const,
      fields: [field(legacyLineTitle(line)), field(legacyLineDetail(line, maxLineChars))],
    })),
  ].slice(-SLACK_MAX_BLOCKS);
  return renderedBlocks.length ? renderedBlocks : undefined;
}

export function buildSlackProgressStreamStartChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  maxLineChars?: number;
}): AnyChunk[] | undefined {
  return buildSlackProgressStreamChunks(params);
}

export function buildSlackProgressStreamUpdateChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  maxLineChars?: number;
}): AnyChunk[] | undefined {
  return buildSlackProgressStreamChunks(params);
}

export function buildSlackProgressStreamCompletionChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  maxLineChars?: number;
  finalInProgressStatus?: SlackPlanTaskStatus;
}): AnyChunk[] | undefined {
  return buildSlackProgressStreamChunks({ ...params, completeInProgress: true });
}
