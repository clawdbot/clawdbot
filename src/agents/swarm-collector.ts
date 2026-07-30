import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureCompletionState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { backfillCollectorArchiveAtMs } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord, SwarmCollectorStatus } from "./subagent-registry.types.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";
import { consumeSwarmStructuredOutput } from "./tools/structured-output-tool.js";

function resolveStatus(
  entry: SubagentRunRecord,
  hasStructuredResult: boolean,
): SwarmCollectorStatus {
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  if (entry.outcome?.status === "timeout") {
    return "timeout";
  }
  if (entry.outcome?.status === "ok") {
    return "done";
  }
  // Tool-only structured turns can surface the runner's synthetic completion
  // marker as an error despite having fulfilled the collector contract.
  return hasStructuredResult && entry.outcome?.error === "completed" ? "done" : "failed";
}

/** Freeze the waitable collector record after raw completion capture. */
export function updateSwarmCollectorCompletion(
  entry: SubagentRunRecord,
  cfg: OpenClawConfig,
): boolean {
  if (!entry.collect) {
    return false;
  }
  const clearedPendingLaunch = entry.swarmLaunchPending === true;
  entry.swarmLaunchPending = false;
  const completion = ensureCompletionState(entry);
  const capturedAtAdded = completion.capturedAt === undefined;
  completion.capturedAt ??= Date.now();
  const archiveDeadlineAdded = backfillCollectorArchiveAtMs(entry, cfg);
  if (entry.collectorCompletion) {
    return clearedPendingLaunch || capturedAtAdded || archiveDeadlineAdded;
  }
  const executionCaptured = consumeSwarmStructuredOutput(entry.runId);
  const publicCaptured =
    entry.swarmRunId && entry.swarmRunId !== entry.runId
      ? consumeSwarmStructuredOutput(entry.swarmRunId)
      : undefined;
  const captured = executionCaptured ?? publicCaptured ?? entry.structuredOutput;
  entry.structuredOutput = undefined;
  const schemaError = entry.outputSchema
    ? (captured?.schemaError ??
      (captured?.structured === undefined ? "structured_output was not called" : undefined))
    : undefined;
  const session = loadSubagentSessionEntry({ childSessionKey: entry.childSessionKey });
  const usage =
    typeof session?.inputTokens === "number" || typeof session?.outputTokens === "number"
      ? {
          inputTokens: session.inputTokens ?? 0,
          outputTokens: session.outputTokens ?? 0,
        }
      : undefined;
  const resolvedStatus = resolveStatus(entry, captured?.structured !== undefined);
  const next = {
    status: schemaError && resolvedStatus === "done" ? ("failed" as const) : resolvedStatus,
    ...(captured?.structured !== undefined ? { structured: captured.structured } : {}),
    ...(schemaError ? { schemaError } : {}),
    ...(usage ? { usage } : {}),
  };
  if (JSON.stringify(entry.collectorCompletion) === JSON.stringify(next)) {
    return false;
  }
  entry.collectorCompletion = next;
  return true;
}
