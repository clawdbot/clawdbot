import type { AnyChunk, TaskUpdateChunk } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import type { AgentPlanStep, ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { normalizeSlackOutboundText } from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { SLACK_SESSION_LINK_ACTION_ID } from "./reply-action-ids.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_PROGRESS_FIELD_MAX = 1800;
const DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS = 120;
const SLACK_PROGRESS_CHUNK_TEXT_MAX = 256;
const SLACK_PROGRESS_TASK_TITLE_MAX = 120;

type SlackPlanTask = Pick<TaskUpdateChunk, "id" | "title" | "status">;

function buildSessionSources(url: string): NonNullable<TaskUpdateChunk["sources"]> {
  // The live Slack API requires url_source; @slack/types 3.0.0 still declares the old `url` tag.
  return [{ type: "url_source", url, text: "Open in OpenClaw" }] as unknown as NonNullable<
    TaskUpdateChunk["sources"]
  >;
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

function isAuthoredProgressLine(line: ChannelProgressDraftLine): boolean {
  return line.id === "reasoning" || line.id?.startsWith("commentary:") === true;
}

function resolveProgressAttention(
  lines: readonly ChannelProgressDraftLine[],
  finalStatus?: "complete" | "error",
): SlackPlanTask | undefined {
  const approval = lines.findLast(
    (line) => line.kind === "approval" && line.status === "requested",
  );
  if (approval) {
    return finalStatus
      ? undefined
      : {
          id: "openclaw_attention",
          title: compactTitle(`Approval required: ${approval.detail || approval.label}`),
          status: "pending",
        };
  }
  const failure = lines.findLast((line) => {
    const status = line.status?.trim().toLowerCase();
    return (
      status === "error" ||
      status === "failed" ||
      status === "failure" ||
      (status?.startsWith("exit ") && status !== "exit 0")
    );
  });
  if (!failure) {
    return undefined;
  }
  const title = [...new Set([failure.label, failure.detail, failure.status].filter(Boolean))].join(
    " — ",
  );
  // Native rows cannot be removed; successful turns retain failures as recovered history.
  return {
    id: "openclaw_attention",
    title: compactTitle(finalStatus === "complete" ? `Recovered: ${title}` : title),
    status: finalStatus ?? "error",
  };
}

export function buildSlackProgressStreamChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  finalInProgressStatus?: "complete" | "error";
  sessionUrl?: string;
}): AnyChunk[] | undefined {
  const title = compactChunkText(params.title?.trim() || params.label?.trim() || "Working");
  if (
    !params.title &&
    !params.label &&
    !params.lines.length &&
    !params.plan?.length &&
    !params.sessionUrl
  ) {
    return undefined;
  }
  // Native rows cannot be removed. Only authored milestones get their own row;
  // routine tool activity shares one replaceable summary for the whole turn.
  const tasks: SlackPlanTask[] = params.plan?.length
    ? params.plan.slice(-SLACK_MAX_BLOCKS).map((entry, index) => ({
        id: `plan_step_${index + 1}`,
        title: compactTitle(entry.step),
        status: entry.status === "completed" ? "complete" : entry.status,
      }))
    : [{ id: "openclaw_summary", title: compactTitle(title), status: "in_progress" }];
  let attention = resolveProgressAttention(params.lines, params.finalInProgressStatus);
  if (
    params.finalInProgressStatus === "error" &&
    !tasks.some((task) => task.status === "in_progress")
  ) {
    attention = {
      id: "openclaw_attention",
      title: attention?.status === "error" ? attention.title : "Failed",
      status: "error",
    };
  }
  if (attention) {
    tasks.push(attention);
  }
  const finalTaskIndex = tasks.length - 1;
  const taskChunks: TaskUpdateChunk[] = tasks.map((task, index) => {
    const chunk: TaskUpdateChunk = {
      type: "task_update",
      id: task.id,
      title: task.title,
      status:
        task.status === "in_progress" ? (params.finalInProgressStatus ?? task.status) : task.status,
    };
    if (index === finalTaskIndex && params.sessionUrl) {
      chunk.sources = buildSessionSources(params.sessionUrl);
    }
    return chunk;
  });
  return [{ type: "plan_update", title }, ...taskChunks];
}

type SlackProgressCardState = "working" | "success" | "error";

// Card text is transient status: render authored Markdown as mrkdwn, but never
// let it ping anyone or nest the card's own bold/italic wrapper.
function renderProgressCardText(text: string, enclosingStyle?: "bold" | "italic"): string {
  return normalizeSlackOutboundText(text, { mentions: "escape", enclosingStyle });
}

export function buildSlackProgressCardBlocks(params: {
  state: SlackProgressCardState;
  title: string;
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  narration?: string;
  maxLineChars?: number;
  sessionUrl?: string;
}): (Block | KnownBlock)[] {
  const maxLineChars = resolveMaxLineChars(
    params.maxLineChars,
    DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS,
  );
  const statusLabels = { completed: "Completed", in_progress: "In progress", pending: "Pending" };
  const planLines = (params.plan ?? [])
    .slice(-SLACK_MAX_BLOCKS)
    .map(
      (entry) =>
        `${statusLabels[entry.status]}: ${renderProgressCardText(compactDetail(entry.step, maxLineChars))}`,
    );
  const narration = params.narration?.replace(/\s+/g, " ").trim();
  const authoredText = params.lines
    .filter(isAuthoredProgressLine)
    .map((line) => line.text.trim())
    .filter((text, index, values) => text && text !== narration && values.indexOf(text) === index)
    .map((text) => renderProgressCardText(compactDetail(text, maxLineChars)))
    .join("\n");
  const finalStatus =
    params.state === "working" ? undefined : params.state === "success" ? "complete" : "error";
  const attention = resolveProgressAttention(params.lines, finalStatus);
  const status =
    params.state === "success" ? "Completed: " : params.state === "error" ? "Failed: " : "";
  const sections = [
    `${status}*${renderProgressCardText(params.title.trim() || "Working", "bold")}*`,
    narration ? `_${renderProgressCardText(narration, "italic")}_` : "",
    planLines.join("\n"),
    authoredText,
    attention ? escapeSlackMrkdwn(attention.title) : "",
  ];
  const blocks: (Block | KnownBlock)[] = sections.filter(Boolean).map((text) => ({
    type: "section",
    text: { type: "mrkdwn", text: truncateSlackText(text, SLACK_PROGRESS_FIELD_MAX) },
  }));
  if (params.state !== "working" && params.sessionUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_SESSION_LINK_ACTION_ID,
          text: { type: "plain_text", text: "Open in OpenClaw" },
          url: params.sessionUrl,
        },
      ],
    });
  }
  return blocks.slice(0, SLACK_MAX_BLOCKS);
}

type SlackNativeTaskRow = Pick<TaskUpdateChunk, "title" | "status"> & {
  sourcesSent?: boolean;
};

/** Task rows and plan title already delivered to one native Slack stream. */
export type SlackNativeStreamSnapshot = {
  planTitle?: string;
  tasks: ReadonlyMap<string, SlackNativeTaskRow>;
};

export const EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT: SlackNativeStreamSnapshot = { tasks: new Map() };

/**
 * Turns a full task snapshot into the delta Slack must receive. Native streams
 * key rows by persistent id with no removal chunk: unchanged rows are omitted,
 * changed titles/statuses replace in place, and rows that dropped out
 * (plan shrinks, summary <-> plan source switches) get a final complete
 * update or they linger in_progress forever.
 */
export function reconcileSlackNativeTaskChunks(params: {
  previous: SlackNativeStreamSnapshot;
  chunks: AnyChunk[] | undefined;
}): { chunks: AnyChunk[] | undefined; snapshot: SlackNativeStreamSnapshot } {
  const nextTasks = new Map<string, SlackNativeTaskRow>();
  let planTitle = params.previous.planTitle;
  const emitted: AnyChunk[] = [];
  for (const chunk of params.chunks ?? []) {
    if (chunk.type === "plan_update") {
      if (chunk.title !== planTitle) {
        planTitle = chunk.title;
        emitted.push(chunk);
      }
      continue;
    }
    if (chunk.type !== "task_update") {
      emitted.push(chunk);
      continue;
    }
    const previousRow = params.previous.tasks.get(chunk.id);
    const status = chunk.status;
    // The session source is a per-turn constant; deliver it once.
    const sourcesChanged = Boolean(chunk.sources) && !previousRow?.sourcesSent;
    const row: SlackNativeTaskRow = { title: chunk.title, status };
    if (sourcesChanged || previousRow?.sourcesSent) {
      row.sourcesSent = true;
    }
    nextTasks.set(chunk.id, row);
    const rowChanged =
      !previousRow ||
      previousRow.title !== chunk.title ||
      previousRow.status !== status ||
      sourcesChanged;
    if (!rowChanged) {
      continue;
    }
    const update: TaskUpdateChunk = {
      type: "task_update",
      id: chunk.id,
      title: chunk.title,
      status,
    };
    if (sourcesChanged) {
      update.sources = chunk.sources;
    }
    emitted.push(update);
  }
  for (const [id, row] of params.previous.tasks) {
    if (nextTasks.has(id)) {
      continue;
    }
    // Carry forward already-terminal rows so a later reappearance diffs correctly.
    if (row.status === "complete" || row.status === "error") {
      nextTasks.set(id, row);
      continue;
    }
    nextTasks.set(id, { ...row, status: "complete" });
    emitted.push({ type: "task_update", id, title: row.title, status: "complete" });
  }
  return {
    chunks: emitted.length > 0 ? emitted : undefined,
    snapshot: { ...(planTitle ? { planTitle } : {}), tasks: nextTasks },
  };
}
