import {
  classifyAgentRunTerminalOutcome,
  isDefinitiveRunLifecycle,
  resolveAgentRunLifecycleTerminalFacts,
  resolveAgentRunWaitTerminalFacts,
} from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonEmptyStringPreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import type { JsonObject, OpenClawEventType, RunResult, RunTimestamp } from "./types.js";

const SDK_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "completed",
  timeout: "timed_out",
  cancellation: "cancelled",
  failure: "failed",
} as const;

export function readSdkRunTimestamp(value: unknown): RunTimestamp | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolveSdkLifecycleEventType(
  data: JsonObject,
  phase: "end" | "error",
): OpenClawEventType {
  if (!isDefinitiveRunLifecycle({ phase, data })) {
    return "raw";
  }
  const facts = resolveAgentRunLifecycleTerminalFacts({ phase, data });
  return `run.${SDK_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(facts)]}`;
}

export function resolveSdkRunWaitStatus(payload: unknown): RunResult["status"] {
  const record = asRecord(payload);
  if (record.status === "pending" || record.status === "accepted" || record.pendingError === true) {
    return "accepted";
  }
  const facts = resolveAgentRunWaitTerminalFacts(record);
  if (!facts) {
    return "failed";
  }
  // A wait deadline carries no terminal observation. Run timeout attribution,
  // cancellation, and terminal metadata still settle the caller's run handle.
  if (
    facts.reason === "timed_out" &&
    readSdkRunTimestamp(record.endedAt) === undefined &&
    readNonEmptyStringPreservingWhitespace(record.error) === undefined &&
    readNonEmptyStringPreservingWhitespace(record.stopReason) === undefined &&
    typeof record.livenessState !== "string" &&
    record.yielded !== true
  ) {
    return "accepted";
  }
  return SDK_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(facts)];
}
