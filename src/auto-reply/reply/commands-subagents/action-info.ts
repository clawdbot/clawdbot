import { subagentRuns } from "../../../agents/subagent-registry-memory.js";
import { countPendingDescendantRunsFromRuns } from "../../../agents/subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "../../../agents/subagent-registry-state.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import { loadSessionStore } from "../../../config/sessions/store-load.js";
import { formatDurationCompact } from "../../../shared/subagents-format.js";
import { findTaskByRunIdForOwner } from "../../../tasks/task-owner-access.js";
import { sanitizeTaskStatusText } from "../../../tasks/task-status.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import {
  type SubagentsCommandContext,
  formatTimestampWithAge,
  loadSubagentSessionEntry,
  resolveDisplayStatus,
  resolveSubagentEntryForToken,
  stopWithText,
} from "./shared.js";

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
  const { entry: sessionEntry } = loadSubagentSessionEntry(params, run.childSessionKey, {
    loadSessionStore,
    resolveStorePath,
  });
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
