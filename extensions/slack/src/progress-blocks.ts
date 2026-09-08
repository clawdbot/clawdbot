import { createHash } from "node:crypto";
import type { AnyChunk, TaskUpdateChunk } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import {
  type AgentPlanStep,
  type ChannelProgressDraftCompositorSnapshot,
  type ChannelProgressDraftLine,
  formatChannelProgressDraftDiffStat,
  formatPlanChecklistLines,
} from "openclaw/plugin-sdk/channel-outbound";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { normalizeSlackOutboundText } from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { SLACK_SESSION_LINK_ACTION_ID } from "./reply-action-ids.js";
import { applyAppendOnlyStreamUpdate } from "./stream-mode.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_PROGRESS_FIELD_MAX = 1800;
const DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS = 120;
const DEFAULT_SLACK_PROGRESS_TASK_DETAIL_MAX_CHARS = 48;
const SLACK_PROGRESS_CHUNK_TEXT_MAX = 256;
const SLACK_PROGRESS_TASK_TITLE_MAX = 120;
const SLACK_PROGRESS_PLAN_FALLBACK_TITLE = "Thinking";
const SLACK_PROGRESS_LINE_DELTA_RE = /(?:^|\s)\+(\d+)\s+[−-](\d+)(?=\s|$)/u;
// Work IDs cannot contain hyphens; this namespace marks transient attention.
const SLACK_ATTENTION_TASK_PREFIX = "openclaw-attention-";

type SlackPlanTaskStatus = TaskUpdateChunk["status"];
type SlackPlanTask = Pick<TaskUpdateChunk, "id" | "title" | "status" | "details" | "output">;
type SlackProgressDiffStat = NonNullable<ChannelProgressDraftCompositorSnapshot["diffStat"]>;

function buildSessionSources(url: string): NonNullable<TaskUpdateChunk["sources"]> {
  // The live Slack API requires url_source; @slack/types 3.0.0 still declares the old `url` tag.
  return [{ type: "url_source", url, text: "Open in OpenClaw" }] as unknown as NonNullable<
    TaskUpdateChunk["sources"]
  >;
}

function field(text: string) {
  return { type: "mrkdwn" as const, text: truncateSlackText(text, SLACK_PROGRESS_FIELD_MAX) };
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

// Card text is transient status: render authored Markdown as mrkdwn, but never
// let it ping anyone or nest the card's own bold/italic wrapper.
function renderProgressCardText(text: string, enclosingStyle?: "bold" | "italic"): string {
  return normalizeSlackOutboundText(text, { mentions: "escape", enclosingStyle });
}

function lineDetailParts(line: ChannelProgressDraftLine): string[] {
  return [
    line.detail,
    line.status && line.status !== "completed" && !line.detail?.includes(line.status)
      ? line.status
      : undefined,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
}

function activityLineDetail(line: ChannelProgressDraftLine, maxChars: number): string {
  const detail = lineDetailParts(line).join(" · ");
  if (detail) {
    return escapeSlackMrkdwn(compactDetail(detail, maxChars));
  }
  const text = line.text.replace(/^(?:🧠|💬)\s+/u, "").trim();
  return line.kind === "item" && !line.toolName && text && text !== line.label
    ? renderProgressCardText(compactDetail(text, maxChars))
    : "—";
}

function lineTaskTitle(line: ChannelProgressDraftLine): string {
  const label = line.label.replace(/\s+/g, " ").trim() || line.toolName || line.kind || "Update";
  const fallback = line.text.replace(/\s+/g, " ").trim();
  if (fallback && fallback !== label) {
    return compactTitle(lineDetailParts(line).length > 0 || line.status ? label : fallback);
  }
  return compactTitle(label);
}

// Native tasks append details/output; keep details stable and put results in
// output so a status change cannot repeat the command.
function lineTaskDetails(line: ChannelProgressDraftLine, maxLineChars: number): string | undefined {
  const detail = line.detail
    ?.replace(SLACK_PROGRESS_LINE_DELTA_RE, "")
    .replace(/\s+·\s*$/u, "")
    .trim();
  return detail && detail !== line.status?.trim() ? compactDetail(detail, maxLineChars) : undefined;
}

function lineTaskOutput(line: ChannelProgressDraftLine): string | undefined {
  const match = line.detail ? SLACK_PROGRESS_LINE_DELTA_RE.exec(line.detail) : null;
  if (match) {
    return `+${match[1]} −${match[2]}`;
  }
  const status = line.status?.replace(/\s+/g, " ").trim();
  return status && lineTaskStatus(line) === "error" ? status : undefined;
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
    return "error";
  }
  return "in_progress";
}

function stableTaskIdPart(value: string, slugValue = value): string {
  const slug = slugValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${(slug || "task").slice(0, 48)}_${suffix}`;
}

function resolveLineTaskIdentity(
  line: ChannelProgressDraftLine,
  contentIdOccurrences: Map<string, number>,
): string {
  if (line.id?.trim()) {
    return stableTaskIdPart(line.id);
  }
  const contentKey = [line.kind, line.toolName, line.label, line.text].join("\0");
  const id = stableTaskIdPart(contentKey, line.toolName ?? line.kind ?? line.label);
  // Suffix singletons too, so duplicates entering the window cannot re-key them.
  const occurrence = (contentIdOccurrences.get(id) ?? 0) + 1;
  contentIdOccurrences.set(id, occurrence);
  return `${id}_${occurrence}`;
}

// Native tasks follow the full plan or compositor window. Block Kit's block
// limit does not apply here: truncation hides late failures and shifts plan IDs.
function buildNativeTasks(params: {
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  maxLineChars?: number;
}): SlackPlanTask[] {
  // Slack cannot remove native rows. Position-keyed plan IDs let snapshots
  // replace row i; reconciliation completes rows that disappear.
  const tasks: SlackPlanTask[] = (params.plan ?? []).map((entry, index) => ({
    id: `plan_step_${index + 1}`,
    title: compactTitle(entry.step),
    status: entry.status === "completed" ? "complete" : entry.status,
  }));
  const maxLineChars = resolveMaxLineChars(
    params.maxLineChars,
    DEFAULT_SLACK_PROGRESS_TASK_DETAIL_MAX_CHARS,
  );
  const contentIdOccurrences = new Map<string, number>();
  for (const line of params.lines) {
    const id = resolveLineTaskIdentity(line, contentIdOccurrences);
    const task: SlackPlanTask = { id, title: lineTaskTitle(line), status: lineTaskStatus(line) };
    const details = lineTaskDetails(line, maxLineChars);
    const output = lineTaskOutput(line);
    if (details) {
      task.details = details;
    }
    if (output) {
      task.output = output;
    }
    tasks.push(task);
  }
  return tasks;
}

function buildProgressAttentionTasks(
  lines: readonly ChannelProgressDraftLine[],
  finalStatus: "complete" | "error" | undefined,
): SlackPlanTask[] {
  const contentIdOccurrences = new Map<string, number>();
  // Attention follows the compositor window; Block Kit limits apply after projection.
  return lines.flatMap((line) => {
    const approval = line.kind === "approval";
    if (
      approval
        ? line.status !== "requested" || finalStatus !== undefined
        : lineTaskStatus(line) !== "error"
    ) {
      return [];
    }
    const title = approval
      ? `Approval required: ${line.detail || line.label}`
      : [...new Set([line.label, line.detail, line.status].filter(Boolean))].join(" — ");
    const recovered = !approval && finalStatus === "complete";
    const task: SlackPlanTask = {
      id: `${SLACK_ATTENTION_TASK_PREFIX}${resolveLineTaskIdentity(line, contentIdOccurrences)}`,
      title: compactTitle(recovered ? `Recovered: ${title}` : title),
      status: approval ? "pending" : (finalStatus ?? "error"),
    };
    return [task];
  });
}

function formatTaskDiffOutput(diffStat: SlackProgressDiffStat | undefined): string | undefined {
  return diffStat && (diffStat.added > 0 || diffStat.removed > 0)
    ? `+${diffStat.added} −${diffStat.removed}`
    : undefined;
}

export function buildSlackProgressStreamChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  maxLineChars?: number;
  /** Quiet cards keep one stable work row instead of a task per tool call. */
  summaryRow?: boolean;
  /** Terminal status applied to rows still in progress when the turn finishes. */
  finalInProgressStatus?: "complete" | "error";
  diffStat?: SlackProgressDiffStat;
  sessionUrl?: string;
}): AnyChunk[] | undefined {
  const approvals = params.lines.filter((line) => line.kind === "approval");
  const tasks = buildNativeTasks({
    lines: params.summaryRow ? [] : params.lines.filter((line) => line.kind !== "approval"),
    plan: params.plan,
    maxLineChars: params.maxLineChars,
  });
  // Detailed work rows keep their identity through plan changes and already
  // carry failures. Quiet cards need separate failure attention rows.
  const attention = buildProgressAttentionTasks(
    params.summaryRow ? params.lines : approvals,
    params.finalInProgressStatus,
  );
  const headline = params.title?.trim() || params.label?.trim();
  const newest = tasks.at(-1);
  const title = compactChunkText(
    headline ||
      (newest?.details ? `${newest.title} — ${newest.details}` : newest?.title) ||
      (params.summaryRow ? "Working" : attention.at(-1)?.title) ||
      SLACK_PROGRESS_PLAN_FALLBACK_TITLE,
  );
  const diffOutput = formatTaskDiffOutput(params.diffStat);
  if (tasks.length === 0 && (params.summaryRow || params.sessionUrl || diffOutput)) {
    // Native rows cannot be removed, so the quiet card owns one replaceable
    // summary row for the whole turn; detailed cards add it only as a receipt.
    tasks.push({
      id: "openclaw_summary",
      title: params.summaryRow ? compactTitle(title) : "Completed",
      status: params.finalInProgressStatus ?? (params.summaryRow ? "in_progress" : "complete"),
    });
  }
  tasks.push(...attention);
  if (
    params.finalInProgressStatus === "error" &&
    !tasks.some((task) => task.status === "in_progress" || task.status === "error")
  ) {
    tasks.push({ id: "openclaw_attention", title: "Failed", status: "error" });
  }
  if (!headline && tasks.length === 0) {
    return undefined;
  }
  const finalTaskIndex = tasks.length - 1;
  const taskChunks: TaskUpdateChunk[] = tasks.map((task, index) => {
    const recovered = params.finalInProgressStatus === "complete" && task.status === "error";
    const chunk: TaskUpdateChunk = {
      type: "task_update",
      id: task.id,
      title: recovered ? compactTitle(`Recovered: ${task.title}`) : task.title,
      status: recovered
        ? "complete"
        : task.status === "in_progress"
          ? (params.finalInProgressStatus ?? task.status)
          : task.status,
    };
    if (task.details) {
      chunk.details = task.details;
    }
    if (task.output) {
      chunk.output = task.output;
    }
    if (index === finalTaskIndex && diffOutput) {
      chunk.output = [task.output, diffOutput].filter(Boolean).join(" · ");
    }
    if (index === finalTaskIndex && params.sessionUrl) {
      chunk.sources = buildSessionSources(params.sessionUrl);
    }
    return chunk;
  });
  return [{ type: "plan_update", title }, ...taskChunks];
}

type SlackProgressCardState = "working" | "success" | "error";

function joinRecentProgressRows(rows: readonly string[]): string {
  const rendered: string[] = [];
  let length = 0;
  for (const row of rows.toReversed()) {
    const nextLength = length + row.length + (rendered.length > 0 ? 1 : 0);
    if (nextLength > SLACK_PROGRESS_FIELD_MAX) {
      break;
    }
    rendered.push(row);
    length = nextLength;
  }
  return rendered.toReversed().join("\n");
}

function buildActivityText(lines: readonly ChannelProgressDraftLine[], maxLineChars: number) {
  return joinRecentProgressRows(
    lines.slice(-SLACK_MAX_BLOCKS).map((line) => {
      const title = `${line.icon ?? "•"} *${renderProgressCardText(line.label, "bold")}*`;
      return `${title} — ${activityLineDetail(line, maxLineChars)}`;
    }),
  );
}

export function buildSlackProgressCardBlocks(params: {
  state: SlackProgressCardState;
  title: string;
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  narration?: string;
  maxLineChars?: number;
  toolCalls?: number;
  elapsedSeconds?: number;
  diffStat?: SlackProgressDiffStat;
  sessionUrl?: string;
}): (Block | KnownBlock)[] {
  const maxLineChars = resolveMaxLineChars(
    params.maxLineChars,
    DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS,
  );
  const planLines = formatPlanChecklistLines(params.plan ?? [], {
    maxLines: SLACK_MAX_BLOCKS,
    maxLineChars,
  });
  const narration = params.narration?.replace(/\s+/g, " ").trim();
  const diffStat = formatChannelProgressDraftDiffStat(params.diffStat);
  const workingFooter = [
    ...(params.toolCalls && params.toolCalls > 0 ? [`🛠️ ${params.toolCalls} tools`] : []),
    ...(diffStat ? [diffStat] : []),
    ...(params.elapsedSeconds && params.elapsedSeconds > 0 ? [`⏱ ${params.elapsedSeconds}s`] : []),
  ].join(" · ");
  // A finished card keeps only the durable diff stat. Tool-call/elapsed counters
  // are live working state, not a receipt to leave behind in the transcript.
  const footer = params.state === "working" ? workingFooter : diffStat;
  const icon = params.state === "working" ? "🔄" : params.state === "success" ? "✅" : "❌";
  const finalStatus =
    params.state === "working" ? undefined : params.state === "success" ? "complete" : "error";
  const attention = buildProgressAttentionTasks(params.lines, finalStatus).map((task) =>
    escapeSlackMrkdwn(task.title),
  );
  const sections = [
    `${icon} *${renderProgressCardText(params.title.trim() || "Working", "bold")}*`,
    narration ? `_${renderProgressCardText(narration, "italic")}_` : "",
    planLines.map((line) => renderProgressCardText(line)).join("\n"),
    buildActivityText(
      params.lines.filter((line) => line.kind !== "approval" && lineTaskStatus(line) !== "error"),
      maxLineChars,
    ),
    // Attention has its own bounded section so activity truncation cannot hide it.
    joinRecentProgressRows(attention),
  ];
  const blocks: (Block | KnownBlock)[] = sections
    .filter(Boolean)
    .map((text) => ({ type: "section", text: field(text) }));
  if (footer) {
    blocks.push({ type: "context", elements: [field(footer)] });
  }
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

type SlackNativeStreamField = { rendered: string; source: string };

type SlackNativeTaskRow = Pick<TaskUpdateChunk, "title" | "status"> & {
  details?: SlackNativeStreamField;
  output?: SlackNativeStreamField;
  sourcesSent?: boolean;
};

/** Task rows and plan title already delivered to one native Slack stream. */
export type SlackNativeStreamSnapshot = {
  planTitle?: string;
  tasks: ReadonlyMap<string, SlackNativeTaskRow>;
};

export const EMPTY_SLACK_NATIVE_STREAM_SNAPSHOT: SlackNativeStreamSnapshot = { tasks: new Map() };

const SLACK_TASK_FIELD_SEPARATOR = " · ";

// Slack appends `details`/`output` text per task_update for the same id
// (verified live 2026-08-17: two chunks with "detA"/"detB" rendered "detAdetB");
// title/status replace. Each field therefore streams as append-only text: send
// only the unsent suffix, and join a divergent value with a separator.
function resolveTaskFieldDelta(
  previous: SlackNativeStreamField | undefined,
  incoming: string | undefined,
): { field: SlackNativeStreamField | undefined; delta: string | undefined } {
  if (!incoming) {
    return { field: previous, delta: undefined };
  }
  // A restatement already visible in the row (write start "to a.ts (22 chars)"
  // -> patch result "a.ts") adds nothing; joining it would only repeat the file.
  if (previous?.rendered.includes(incoming)) {
    return { field: { rendered: previous.rendered, source: incoming }, delta: undefined };
  }
  const next = applyAppendOnlyStreamUpdate({
    incoming,
    rendered: previous?.rendered ?? "",
    source: previous?.source ?? "",
    separator: SLACK_TASK_FIELD_SEPARATOR,
  });
  const delta = next.changed ? next.rendered.slice(previous?.rendered.length ?? 0) : undefined;
  return { field: { rendered: next.rendered, source: next.source }, delta };
}

/**
 * Turns a full task snapshot into the delta Slack must receive. Native streams
 * key rows by persistent id with no removal chunk: unchanged rows are omitted,
 * changed rows carry only their unsent field text, and rows that dropped out
 * (plan shrinks, tool-line <-> plan source switches) get a final complete
 * update or they linger in_progress forever.
 */
export function reconcileSlackNativeTaskChunks(params: {
  previous: SlackNativeStreamSnapshot;
  chunks: AnyChunk[] | undefined;
  finalStatus?: "complete" | "error";
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
    const details = resolveTaskFieldDelta(previousRow?.details, chunk.details);
    const output = resolveTaskFieldDelta(previousRow?.output, chunk.output);
    // The session source is a per-turn constant; deliver it once.
    const sourcesChanged = Boolean(chunk.sources) && !previousRow?.sourcesSent;
    const row: SlackNativeTaskRow = { title: chunk.title, status: chunk.status };
    if (details.field) {
      row.details = details.field;
    }
    if (output.field) {
      row.output = output.field;
    }
    if (sourcesChanged || previousRow?.sourcesSent) {
      row.sourcesSent = true;
    }
    nextTasks.set(chunk.id, row);
    const rowChanged =
      !previousRow ||
      previousRow.title !== chunk.title ||
      previousRow.status !== chunk.status ||
      Boolean(details.delta) ||
      Boolean(output.delta) ||
      sourcesChanged;
    if (!rowChanged) {
      continue;
    }
    const update: TaskUpdateChunk = {
      type: "task_update",
      id: chunk.id,
      title: chunk.title,
      status: chunk.status,
    };
    if (details.delta) {
      update.details = details.delta;
    }
    if (output.delta) {
      update.output = output.delta;
    }
    if (sourcesChanged) {
      update.sources = chunk.sources;
    }
    emitted.push(update);
  }
  for (const [id, row] of params.previous.tasks) {
    if (nextTasks.has(id)) {
      continue;
    }
    // Missing attention has cleared; failed tool history instead outlives the
    // rolling window until successful closeout. Never resend append-only fields.
    const recovered =
      row.status === "error" &&
      (id.startsWith(SLACK_ATTENTION_TASK_PREFIX) || params.finalStatus === "complete");
    if (row.status === "complete" || (row.status === "error" && !recovered)) {
      nextTasks.set(id, row);
      continue;
    }
    const title = recovered ? compactTitle(`Recovered: ${row.title}`) : row.title;
    nextTasks.set(id, { ...row, title, status: "complete" });
    emitted.push({ type: "task_update", id, title, status: "complete" });
  }
  return {
    chunks: emitted.length > 0 ? emitted : undefined,
    snapshot: { ...(planTitle ? { planTitle } : {}), tasks: nextTasks },
  };
}
