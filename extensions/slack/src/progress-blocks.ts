// Slack plugin module implements progress blocks behavior.
import { createHash } from "node:crypto";
import type { AnyChunk, TaskUpdateChunk } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import {
  type AgentPlanStep,
  type ChannelProgressDraftCompositorSnapshot,
  type ChannelProgressDraftLine,
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

type SlackPlanTaskStatus = "pending" | "in_progress" | "complete" | "error";

type SlackPlanTask = {
  id: string;
  title: string;
  status: SlackPlanTaskStatus;
  details?: string;
  output?: string;
  sources?: TaskUpdateChunk["sources"];
};

function buildSessionSources(url: string): NonNullable<TaskUpdateChunk["sources"]> {
  // The live Slack API requires url_source; @slack/types 3.0.0 still declares the old `url` tag.
  return [{ type: "url_source", url, text: "Open in OpenClaw" }] as unknown as NonNullable<
    TaskUpdateChunk["sources"]
  >;
}

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
  return [
    line.detail,
    line.status && line.status !== "completed" && !line.detail?.includes(line.status)
      ? line.status
      : undefined,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
}

function legacyLineTitle(line: ChannelProgressDraftLine): string {
  return `${line.icon ?? "•"} *${escapeSlackMrkdwn(line.label)}*`;
}

function isAuthoredProgressLine(line: ChannelProgressDraftLine): boolean {
  return line.id === "reasoning" || line.id?.startsWith("commentary:") === true;
}

function legacyLineDetail(line: ChannelProgressDraftLine, maxChars: number): string {
  const detail = lineDetailParts(line).join(" · ");
  if (detail) {
    return escapeSlackMrkdwn(compactDetail(detail, maxChars));
  }
  if (isAuthoredProgressLine(line)) {
    const text = line.text.replace(/^(?:🧠|💬)\s+/u, "");
    return normalizeSlackOutboundText(compactDetail(text, maxChars));
  }
  return "—";
}

function lineTaskTitle(line: ChannelProgressDraftLine): string {
  const label =
    (line.kind === "command-output" ? line.toolName : undefined) ||
    line.label.replace(/\s+/g, " ").trim() ||
    line.toolName ||
    line.kind ||
    "Update";
  const fallback = line.text.replace(/\s+/g, " ").trim();
  if (fallback && fallback !== label) {
    return compactTitle(lineDetailParts(line).length > 0 || line.status ? label : fallback);
  }
  return compactTitle(label);
}

// Native task rows stream `details`/`output` append-only (see
// reconcileSlackNativeTaskChunks), so `details` holds only the stable tool
// detail and `output` the once-emitted result: a file delta or the failing
// terminal status. Non-terminal status words are already the row icon.
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

function stableTaskIdPart(value: string, slugValue = value): string {
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${slugTaskIdPart(slugValue).slice(0, 48)}_${suffix}`;
}

function resolveLineTaskIdentity(line: ChannelProgressDraftLine): {
  id: string;
  contentDerived: boolean;
} {
  if (line.id?.trim()) {
    return { id: stableTaskIdPart(line.id), contentDerived: false };
  }
  const contentKey = [line.kind, line.toolName, line.label, line.text].join("\0");
  return {
    id: stableTaskIdPart(contentKey, line.toolName ?? line.kind ?? line.label),
    contentDerived: true,
  };
}

function buildPlanTasks(params: {
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  maxLineChars?: number;
}): SlackPlanTask[] {
  if (params.plan) {
    // Slack keys task_update chunks by id with no removal primitive, so
    // position-keyed ids make each snapshot rewrite row i in place: renames,
    // reorders, and insertions reconcile in place. Dropped ids (shrinks, mode
    // switches) are terminalized by reconcileSlackNativeTaskChunks.
    return params.plan.slice(-SLACK_MAX_BLOCKS).map((entry, index) => ({
      id: `plan_step_${index + 1}`,
      title: compactTitle(entry.step),
      status: entry.status === "completed" ? ("complete" as const) : entry.status,
    }));
  }
  const maxLineChars = resolveMaxLineChars(
    params.maxLineChars,
    DEFAULT_SLACK_PROGRESS_TASK_DETAIL_MAX_CHARS,
  );
  const lines = params.lines.slice(-SLACK_MAX_BLOCKS);
  const identities = lines.map(resolveLineTaskIdentity);
  const contentIdOccurrences = new Map<string, number>();
  return lines.map((line, index) => {
    const identity = identities[index]!;
    let id = identity.id;
    if (identity.contentDerived) {
      // Suffix every occurrence (singletons stay `_1`): identity must not
      // re-key when a duplicate line enters or leaves the rolling window.
      const occurrence = (contentIdOccurrences.get(id) ?? 0) + 1;
      contentIdOccurrences.set(id, occurrence);
      id = `${id}_${occurrence}`;
    }
    const details = lineTaskDetails(line, maxLineChars);
    const output = lineTaskOutput(line);
    const task: SlackPlanTask = {
      id,
      title: lineTaskTitle(line),
      status: lineTaskStatus(line),
    };
    if (details) {
      task.details = details;
    }
    if (output) {
      task.output = output;
    }
    return task;
  });
}

function resolvePlanTitle(params: {
  label?: string;
  title?: string;
  tasks: readonly SlackPlanTask[];
}): string {
  return compactChunkText(
    params.title?.trim() ||
      params.label?.trim() ||
      (params.tasks.at(-1)?.details
        ? `${params.tasks.at(-1)?.title} — ${params.tasks.at(-1)?.details}`
        : params.tasks.at(-1)?.title) ||
      SLACK_PROGRESS_PLAN_FALLBACK_TITLE,
  );
}

export function buildSlackProgressStreamChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  maxLineChars?: number;
  completeInProgress?: boolean;
  finalInProgressStatus?: SlackPlanTaskStatus;
  diffStat?: SlackProgressDiffStat;
  sessionUrl?: string;
}): AnyChunk[] | undefined {
  const tasks = buildPlanTasks({
    lines: params.lines,
    plan: params.plan,
    maxLineChars: params.maxLineChars,
  });
  if (tasks.length === 0) {
    const title = params.title?.trim() || params.label?.trim();
    if (!title) {
      return undefined;
    }
    if (!params.sessionUrl && !params.diffStat) {
      return [{ type: "plan_update", title: compactChunkText(title) }];
    }
    return [
      { type: "plan_update", title: compactChunkText(title) },
      {
        type: "task_update",
        id: "openclaw_summary",
        title: "Completed",
        status: "complete",
        ...(formatTaskDiffOutput(params.diffStat)
          ? { output: formatTaskDiffOutput(params.diffStat) }
          : {}),
        ...(params.sessionUrl ? { sources: buildSessionSources(params.sessionUrl) } : {}),
      },
    ];
  }
  const title = resolvePlanTitle({ label: params.label, title: params.title, tasks });
  const finalTaskIndex = tasks.length - 1;
  const diffOutput = formatTaskDiffOutput(params.diffStat);
  const taskChunks: TaskUpdateChunk[] = tasks.map((task, index) => {
    const chunk: TaskUpdateChunk = {
      type: "task_update" as const,
      id: task.id,
      title: task.title,
      status:
        task.status === "in_progress"
          ? (params.finalInProgressStatus ?? (params.completeInProgress ? "complete" : task.status))
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
  const chunks: AnyChunk[] = [{ type: "plan_update", title }, ...taskChunks];
  return chunks;
}

type SlackProgressCardState = "working" | "success" | "error";
type SlackProgressDiffStat = NonNullable<ChannelProgressDraftCompositorSnapshot["diffStat"]>;

function formatDiffStat(diffStat: SlackProgressDiffStat | undefined): string | undefined {
  if (!diffStat || (diffStat.files === 0 && diffStat.added === 0 && diffStat.removed === 0)) {
    return undefined;
  }
  return [
    `📝 ${diffStat.files} files`,
    ...(diffStat.added > 0 ? [`+${diffStat.added}`] : []),
    ...(diffStat.removed > 0 ? [`−${diffStat.removed}`] : []),
  ].join(" ");
}

function formatTaskDiffOutput(diffStat: SlackProgressDiffStat | undefined): string | undefined {
  return diffStat && (diffStat.added > 0 || diffStat.removed > 0)
    ? `+${diffStat.added} −${diffStat.removed}`
    : undefined;
}

function buildActivityText(lines: readonly ChannelProgressDraftLine[], maxLineChars: number) {
  const rendered: string[] = [];
  let length = 0;
  for (const line of lines.slice(-SLACK_MAX_BLOCKS).toReversed()) {
    const row = `${legacyLineTitle(line)} — ${legacyLineDetail(line, maxLineChars)}`;
    const nextLength = length + row.length + (rendered.length > 0 ? 1 : 0);
    if (nextLength > SLACK_PROGRESS_FIELD_MAX) {
      break;
    }
    rendered.push(row);
    length = nextLength;
  }
  return rendered.toReversed().join("\n");
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
  const activityText = buildActivityText(params.lines, maxLineChars);
  const diffStat = formatDiffStat(params.diffStat);
  const workingFooter = [
    ...(params.toolCalls && params.toolCalls > 0 ? [`🛠️ ${params.toolCalls} tools`] : []),
    ...(diffStat ? [diffStat] : []),
    ...(params.elapsedSeconds && params.elapsedSeconds > 0 ? [`⏱ ${params.elapsedSeconds}s`] : []),
  ].join(" · ");
  // A finished card keeps only the durable diff stat. Tool-call/elapsed counters
  // are live working state, not a receipt to leave behind in the transcript.
  const footer = params.state === "working" ? workingFooter : diffStat;
  const icon = params.state === "working" ? "🔄" : params.state === "success" ? "✅" : "❌";
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section" as const,
      text: field(`${icon} *${escapeSlackMrkdwn(params.title.trim() || "Working")}*`),
    },
    ...(narration
      ? [
          {
            type: "section" as const,
            text: field(`_${escapeSlackMrkdwn(narration)}_`),
          },
        ]
      : []),
    ...(planLines.length > 0
      ? [
          {
            type: "section" as const,
            text: field(planLines.map((line) => escapeSlackMrkdwn(line)).join("\n")),
          },
        ]
      : []),
    ...(activityText
      ? [
          {
            type: "section" as const,
            text: field(activityText),
          },
        ]
      : []),
    ...(footer
      ? [
          {
            type: "context" as const,
            elements: [field(footer)],
          },
        ]
      : []),
    ...(params.state !== "working" && params.sessionUrl
      ? [
          {
            type: "actions" as const,
            elements: [
              {
                type: "button" as const,
                action_id: SLACK_SESSION_LINK_ACTION_ID,
                text: { type: "plain_text" as const, text: "Open in OpenClaw" },
                url: params.sessionUrl,
              },
            ],
          },
        ]
      : []),
  ];
  return blocks.slice(0, SLACK_MAX_BLOCKS);
}

type SlackNativeStreamField = { rendered: string; source: string };

type SlackNativeTaskRow = {
  title: string;
  status: SlackPlanTaskStatus;
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
    const status = chunk.status as SlackPlanTaskStatus;
    const details = resolveTaskFieldDelta(previousRow?.details, chunk.details);
    const output = resolveTaskFieldDelta(previousRow?.output, chunk.output);
    // The session source is a per-turn constant; deliver it once.
    const sourcesChanged = Boolean(chunk.sources) && !previousRow?.sourcesSent;
    const row: SlackNativeTaskRow = { title: chunk.title, status };
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
      previousRow.status !== status ||
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
      status,
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

export function buildSlackProgressStreamCompletionChunks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  maxLineChars?: number;
  finalInProgressStatus?: SlackPlanTaskStatus;
  diffStat?: SlackProgressDiffStat;
  sessionUrl?: string;
}): AnyChunk[] | undefined {
  return buildSlackProgressStreamChunks({ ...params, completeInProgress: true });
}
