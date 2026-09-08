import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonEmptyStringPreservingWhitespace as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { resolveSdkLifecycleEventType } from "./run-terminal.js";
import type { GatewayEvent, JsonObject, OpenClawEvent, OpenClawEventType } from "./types.js";

function normalizeAgentEventType(payload: JsonObject): OpenClawEventType {
  const stream = readNonEmptyString(payload.stream);
  const data = asRecord(payload.data);
  const phase = readNonEmptyString(data.phase);
  const status = readNonEmptyString(data.status);

  if (stream === "assistant") {
    return data.delta === true || typeof data.delta === "string"
      ? "assistant.delta"
      : "assistant.message";
  }
  if (stream === "thinking" || stream === "plan") {
    return "thinking.delta";
  }
  if (stream === "lifecycle") {
    if (phase === "start") {
      return "run.started";
    }
    if (phase === "end" || phase === "error") {
      return resolveSdkLifecycleEventType(data, phase);
    }
  }
  if (stream === "tool" || stream === "item" || stream === "command_output") {
    if (phase === "start" || status === "running") {
      return "tool.call.started";
    }
    if (phase === "delta" || phase === "update") {
      return "tool.call.delta";
    }
    // Terminal tool/item events carry phase:"end" together with the real status, so a failed or
    // blocked tool must be classified before the end/completed branch — otherwise phase:"end" wins
    // and failures are reported as tool.call.completed.
    if (status === "failed" || status === "blocked") {
      return "tool.call.failed";
    }
    if (phase === "end" || status === "completed") {
      return "tool.call.completed";
    }
    return "tool.call.delta";
  }
  if (stream === "approval") {
    return phase === "resolved" ? "approval.resolved" : "approval.requested";
  }
  if (stream === "patch") {
    return "artifact.updated";
  }
  return "raw";
}

function normalizeNamedEventType(event: GatewayEvent): OpenClawEventType {
  const payload = asRecord(event.payload);
  switch (event.event) {
    case "agent":
      return normalizeAgentEventType(payload);
    case "sessions.changed": {
      const reason = readNonEmptyString(payload.reason);
      if (reason === "create") {
        return "session.created";
      }
      if (reason === "compact") {
        return "session.compacted";
      }
      return "session.updated";
    }
    case "session.message":
      return "assistant.message";
    case "session.tool":
      return "tool.call.delta";
    case "exec.approval.requested":
    case "plugin.approval.requested":
      return "approval.requested";
    case "exec.approval.resolved":
    case "plugin.approval.resolved":
      return "approval.resolved";
    case "task.updated":
    case "tasks.changed":
      return "task.updated";
    default:
      return "raw";
  }
}

/** Normalize a raw Gateway event into the public SDK event shape. */
export function normalizeGatewayEvent(event: GatewayEvent): OpenClawEvent {
  const payload = asRecord(event.payload);
  const runId = readNonEmptyString(payload.runId);
  const sessionId = readNonEmptyString(payload.sessionId);
  const sessionKey = readNonEmptyString(payload.sessionKey);
  const taskId = readNonEmptyString(payload.taskId);
  const agentId = readNonEmptyString(payload.agentId);
  const ts = asFiniteNumber(payload.ts) ?? Date.now();
  const idParts = [event.seq ?? "local", event.event, runId, sessionKey, ts].filter(
    (part) => part !== undefined,
  );

  return {
    version: 1,
    id: idParts.join(":"),
    ts,
    type: normalizeNamedEventType(event),
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(taskId ? { taskId } : {}),
    ...(agentId ? { agentId } : {}),
    data: payload.data ?? payload,
    raw: event,
  };
}
