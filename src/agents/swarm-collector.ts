import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord, SwarmCollectorStatus } from "./subagent-registry.types.js";
import { loadSubagentSessionEntry } from "./subagent-session-reconciliation.js";
import { consumeSwarmStructuredOutput } from "./tools/structured-output-tool.js";

function resolveStatus(entry: SubagentRunRecord): SwarmCollectorStatus {
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  if (entry.outcome?.status === "timeout") {
    return "timeout";
  }
  return entry.outcome?.status === "ok" ? "done" : "failed";
}

/** Freeze the waitable collector record after raw completion capture. */
export function updateSwarmCollectorCompletion(entry: SubagentRunRecord): boolean {
  if (!entry.collect) {
    return false;
  }
  const clearedPendingLaunch = entry.swarmLaunchPending === true;
  entry.swarmLaunchPending = false;
  if (entry.collectorCompletion) {
    return clearedPendingLaunch;
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
  const resolvedStatus = resolveStatus(entry);
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
