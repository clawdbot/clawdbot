// Formats detailed subagent run information for the info action.
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { countPendingDescendantRuns } from "../../../agents/subagents/registry/subagent-registry-read.js";
import { resolveSubagentDisplayStatus } from "../../../agents/subagents/registry/subagent-session-metrics.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { formatDurationCompact } from "../../../infra/format-time/format-duration.js";
import { formatTimeAgo } from "../../../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { findTaskByRunIdForOwner } from "../../../tasks/task-owner-access.js";
import { sanitizeTaskStatusText } from "../../../tasks/task-status.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { formatRunLabel } from "../subagents-utils.js";
import { resolveSubagentEntryForToken, type SubagentsCommandContext } from "./shared.js";

function formatTimestampWithAge(valueMs?: number) {
  if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
    return "n/a";
  }
  const timestamp = timestampMsToIsoString(valueMs);
  if (!timestamp) {
    return "n/a";
  }
  return `${timestamp} (${formatTimeAgo(Date.now() - valueMs, { fallback: "n/a" })})`;
}

function loadSubagentSessionEntry(params: SubagentsCommandContext["params"], childKey: string) {
  const parsed = parseAgentSessionKey(childKey);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: parsed?.agentId,
  });
  return {
    entry: loadSessionEntryReadOnly({
      storePath,
      sessionKey: childKey,
      clone: false,
    }),
  };
}

export function handleSubagentsInfoAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params, requesterKey, runs, restTokens } = ctx;
  const target = restTokens[0];
  if (!target) {
    return commandReply("ℹ️ Usage: /subagents info <id|#>");
  }

  const targetResolution = resolveSubagentEntryForToken(runs, target);
  if ("reply" in targetResolution) {
    return targetResolution.reply;
  }

  const run = targetResolution.entry;
  const { entry: sessionEntry } = loadSubagentSessionEntry(params, run.childSessionKey);
  const runtime =
    run.execution.startedAt && Number.isFinite(run.execution.startedAt)
      ? (formatDurationCompact((run.execution.endedAt ?? Date.now()) - run.execution.startedAt) ??
        "n/a")
      : "n/a";
  const outcomeError = sanitizeTaskStatusText(run.execution.outcome?.error, { errorContext: true });
  const outcome = run.execution.outcome
    ? `${run.execution.outcome.status}${outcomeError ? ` (${outcomeError})` : ""}`
    : "n/a";
  const linkedTask = findTaskByRunIdForOwner({
    runId: run.runId,
    callerOwnerKey: requesterKey,
    callerAgentId: params.agentId,
    config: params.cfg,
  });
  const taskText = sanitizeTaskStatusText(run.task) || "n/a";
  const progressText = sanitizeTaskStatusText(linkedTask?.progressSummary);
  const taskSummaryText = sanitizeTaskStatusText(linkedTask?.terminalSummary, {
    errorContext: true,
  });
  const taskErrorText = sanitizeTaskStatusText(linkedTask?.error, { errorContext: true });

  const lines = [
    "ℹ️ Subagent info",
    `Status: ${resolveSubagentDisplayStatus(run, countPendingDescendantRuns(run.childSessionKey))}`,
    `Label: ${formatRunLabel(run)}`,
    `Task: ${taskText}`,
    `Run: ${run.runId}`,
    linkedTask ? `TaskId: ${linkedTask.taskId}` : undefined,
    linkedTask ? `TaskStatus: ${linkedTask.status}` : undefined,
    `Session: ${run.childSessionKey}`,
    `SessionId: ${sessionEntry?.sessionId ?? "n/a"}`,
    `Runtime: ${runtime}`,
    `Created: ${formatTimestampWithAge(run.createdAt)}`,
    `Started: ${formatTimestampWithAge(run.execution.startedAt)}`,
    `Ended: ${formatTimestampWithAge(run.execution.endedAt)}`,
    `Cleanup: ${run.cleanup}`,
    run.archiveAtMs ? `Archive: ${formatTimestampWithAge(run.archiveAtMs)}` : undefined,
    run.cleanupHandled ? "Cleanup handled: yes" : undefined,
    `Outcome: ${outcome}`,
    progressText ? `Progress: ${progressText}` : undefined,
    taskSummaryText ? `Task summary: ${taskSummaryText}` : undefined,
    taskErrorText ? `Task error: ${taskErrorText}` : undefined,
    linkedTask ? `Delivery: ${linkedTask.deliveryStatus}` : undefined,
  ].filter(Boolean);

  return commandReply(lines.join("\n"));
}
