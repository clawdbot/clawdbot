// Implements task-list commands that route through the current session agent.
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import {
  listTasksForAgentIdForStatus,
  listTasksForSessionKeyForStatus,
} from "../../tasks/task-status-access.js";
import {
  buildTaskStatusSnapshot,
  formatTaskStatus,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "../../tasks/task-status.js";
import type { ReplyPayload } from "../types.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const MAX_VISIBLE_TASKS = 5;

const TASK_STATUS_ICONS: Record<ReturnType<typeof formatTaskStatus>, string> = {
  queued: "🟡",
  running: "🟢",
  succeeded: "✅",
  blocked: "⚠️",
  failed: "🔴",
  timed_out: "⏱️",
  cancelled: "⚪️",
  lost: "⚠️",
};

const TASK_RUNTIME_LABELS: Record<TaskRecord["runtime"], string> = {
  subagent: "Subagent",
  acp: "ACP",
  cli: "CLI",
  cron: "Cron",
};

function formatTaskHeadline(snapshot: ReturnType<typeof buildTaskStatusSnapshot>): string {
  if (snapshot.totalCount === 0) {
    return "All clear - nothing linked to this session right now.";
  }
  return `Current session: ${snapshot.activeCount} active · ${snapshot.totalCount} total`;
}

function formatAgentFallbackLine(agentId: string): string | undefined {
  const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
  if (snapshot.totalCount === 0) {
    return undefined;
  }
  return `Agent-local: ${snapshot.activeCount} active · ${snapshot.totalCount} total`;
}

function formatTaskTiming(task: TaskRecord): string | undefined {
  if (task.status === "running") {
    const startedAt = task.startedAt ?? task.createdAt;
    return `elapsed ${formatDurationCompact(Date.now() - startedAt, { spaced: true }) ?? "0s"}`;
  }
  if (task.status === "queued") {
    return `queued ${formatTimeAgo(Date.now() - task.createdAt)}`;
  }
  const endedAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  return `finished ${formatTimeAgo(Date.now() - endedAt)}`;
}

function formatVisibleTask(task: TaskRecord, index: number): string {
  const title = formatTaskStatusTitle(task);
  const status = formatTaskStatus(task);
  const timing = formatTaskTiming(task);
  const detail = formatTaskStatusDetail(task);
  let meta = `${TASK_RUNTIME_LABELS[task.runtime]} · ${status.replaceAll("_", " ")}`;
  if (timing) {
    meta += ` · ${timing}`;
  }
  const lines = [`${index + 1}. ${TASK_STATUS_ICONS[status]} ${title}`, `   ${meta}`];
  if (detail) {
    lines.push(`   ${detail}`);
  }
  return lines.join("\n");
}

function buildTasksText(params: { sessionKey: string; agentId: string }): string {
  const sessionSnapshot = buildTaskStatusSnapshot(
    listTasksForSessionKeyForStatus(params.sessionKey),
  );
  const lines = ["📋 Tasks", formatTaskHeadline(sessionSnapshot)];

  if (sessionSnapshot.totalCount > 0) {
    const visible = sessionSnapshot.visible.slice(0, MAX_VISIBLE_TASKS);
    lines.push("");
    for (const [index, task] of visible.entries()) {
      lines.push(formatVisibleTask(task, index));
      if (index < visible.length - 1) {
        lines.push("");
      }
    }
    const hiddenCount = sessionSnapshot.visible.length - visible.length;
    if (hiddenCount > 0) {
      lines.push("", `+${hiddenCount} more recent task${hiddenCount === 1 ? "" : "s"}`);
    }
    return lines.join("\n");
  }

  const agentFallback = formatAgentFallbackLine(params.agentId);
  if (agentFallback) {
    lines.push(agentFallback);
  }
  return lines.join("\n");
}

async function buildTasksReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  return {
    text: buildTasksText({
      sessionKey: params.sessionKey,
      agentId,
    }),
  };
}

export const handleTasksCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/tasks",
    match: (body) => matchCommandPrefix(body, "/tasks"),
    silentUnauthorized: true,
  },
  async (params) =>
    params.command.commandBodyNormalized === "/tasks"
      ? { shouldContinue: false, reply: await buildTasksReply(params) }
      : commandReply("Usage: /tasks"),
);
