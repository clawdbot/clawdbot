import { subagentRuns } from "../../../agents/subagent-registry-memory.js";
import { countPendingDescendantRunsFromRuns } from "../../../agents/subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "../../../agents/subagent-registry-state.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import { loadSessionStore } from "../../../config/sessions/store-load.js";
import { formatTimeAgo } from "../../../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { formatDurationCompact } from "../../../shared/subagents-format.js";
import { findTaskByRunIdForOwner } from "../../../tasks/task-owner-access.js";
import { sanitizeTaskStatusText } from "../../../tasks/task-status.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  formatRunLabel,
  formatRunStatus,
  resolveSubagentTargetFromRuns,
} from "../subagents-utils.js";
import { type SubagentsCommandContext } from "./shared.js";

const RECENT_WINDOW_MINUTES = 30;

function stopWithText(text: string): CommandHandlerResult {
  return { shouldContinue: false, reply: { text } };
}

function formatTimestamp(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return new Date(valueMs).toISOString();
}

function formatTimestampWithAge(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  return `${formatTimestamp(valueMs)} (${formatTimeAgo(Date.now() - valueMs, { fallback: "n/a" })})`;
}

function resolveDisplayStatus(
  entry: SubagentsCommandContext["runs"][number],
  options?: { pendingDescendants?: number },
) {
  const pendingDescendants = Math.max(0, options?.pendingDescendants ?? 0);
  if (pendingDescendants > 0) {
    const childLabel = pendingDescendants === 1 ? "child" : "children";
    return `active (waiting on ${pendingDescendants} ${childLabel})`;
  }
  const status = formatRunStatus(entry);
  return status === "error" ? "failed" : status;
}

function resolveSubagentEntryForToken(
  runs: SubagentsCommandContext["runs"],
  token: string | undefined,
): { entry: SubagentsCommandContext["runs"][number] } | { reply: CommandHandlerResult } {
  const resolved = resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: RECENT_WINDOW_MINUTES,
    label: (entry) => formatRunLabel(entry),
    aliases: (entry) => (entry.taskName ? [entry.taskName] : []),
    isActive: (entry) =>
      !entry.endedAt ||
      Math.max(
        0,
        countPendingDescendantRunsFromRuns(
          getSubagentRunsSnapshotForRead(subagentRuns),
          entry.childSessionKey,
        ),
      ) > 0,
    errors: {
      missingTarget: "Missing subagent id.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent id: ${value}`,
    },
  });
  if (!resolved.entry) {
    return { reply: stopWithText(`⚠️ ${resolved.error ?? "Unknown subagent."}`) };
  }
  return { entry: resolved.entry };
}

function loadSubagentSessionEntry(params: SubagentsCommandContext["params"], childKey: string) {
  const parsed = parseAgentSessionKey(childKey);
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  const store = loadSessionStore(storePath);
  return { entry: store[childKey] };
}

export function handleSubagentsInfoAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, requesterKey, runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return stopWithText("ℹ️ Usage: /subagents info <id|#>");
  }

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const run = targetResolution.entry;
  const { entry: sessionEntry } = loadSubagentSessionEntry(params, run.childSessionKey);
  const runtime =
    run.startedAt && Number.isFinite(run.startedAt)
      ? (formatDurationCompact((run.endedAt ?? Date.now()) - run.startedAt) ?? "n/a")
      : "n/a";
  const outcomeError = sanitizeTaskStatusText(run.outcome?.error, { errorContext: true });
  const outcome = run.outcome
    ? `${run.outcome.status}${outcomeError ? ` (${outcomeError})` : ""}`
    : "n/a";
  const linkedTask = findTaskByRunIdForOwner({
    runId: run.runId,
    callerOwnerKey: requesterKey,
  });
  const taskText = sanitizeTaskStatusText(run.task) || "n/a";
  const progressText = sanitizeTaskStatusText(linkedTask?.progressSummary);
  const taskSummaryText = sanitizeTaskStatusText(linkedTask?.terminalSummary, {
    errorContext: true,
  });
  const taskErrorText = sanitizeTaskStatusText(linkedTask?.error, { errorContext: true });

  const lines = [
    "ℹ️ Subagent info",
    `Status: ${resolveDisplayStatus(run, {
      pendingDescendants: countPendingDescendantRunsFromRuns(
        getSubagentRunsSnapshotForRead(subagentRuns),
        run.childSessionKey,
      ),
    })}`,
    `Label: ${formatRunLabel(run)}`,
    `Task: ${taskText}`,
    `Run: ${run.runId}`,
    linkedTask ? `TaskId: ${linkedTask.taskId}` : undefined,
    linkedTask ? `TaskStatus: ${linkedTask.status}` : undefined,
    `Session: ${run.childSessionKey}`,
    `SessionId: ${sessionEntry?.sessionId ?? "n/a"}`,
    `Transcript: ${sessionEntry?.sessionFile ?? "n/a"}`,
    `Runtime: ${runtime}`,
    `Created: ${formatTimestampWithAge(run.createdAt)}`,
    `Started: ${formatTimestampWithAge(run.startedAt)}`,
    `Ended: ${formatTimestampWithAge(run.endedAt)}`,
    `Cleanup: ${run.cleanup}`,
    run.archiveAtMs ? `Archive: ${formatTimestampWithAge(run.archiveAtMs)}` : undefined,
    run.cleanupHandled ? "Cleanup handled: yes" : undefined,
    `Outcome: ${outcome}`,
    progressText ? `Progress: ${progressText}` : undefined,
    taskSummaryText ? `Task summary: ${taskSummaryText}` : undefined,
    taskErrorText ? `Task error: ${taskErrorText}` : undefined,
    linkedTask ? `Delivery: ${linkedTask.deliveryStatus}` : undefined,
  ].filter(Boolean);

  return stopWithText(lines.join("\n"));
}
