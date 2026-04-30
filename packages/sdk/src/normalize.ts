import type { GatewayEvent, JsonObject, OpenClawEvent, OpenClawEventType } from "./types.js";

function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null ? (value as JsonObject) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readLowerString(value: unknown): string | undefined {
  return readString(value)?.toLowerCase();
}

function normalizeLifecycleEndEventType(data: JsonObject): OpenClawEventType {
  const status = readLowerString(data.status);
  const stopReason = readLowerString(data.stopReason);
  if (
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "killed" ||
    stopReason === "aborted" ||
    stopReason === "cancelled" ||
    stopReason === "canceled" ||
    stopReason === "killed" ||
    stopReason === "rpc" ||
    stopReason === "user" ||
    (data.aborted === true && stopReason === "stop")
  ) {
    return "run.cancelled";
  }
  if (
    status === "timeout" ||
    status === "timed_out" ||
    stopReason === "timeout" ||
    stopReason === "timed_out"
  ) {
    return "run.timed_out";
  }
  if (data.aborted === true) {
    return "run.timed_out";
  }
  return "run.completed";
}

function normalizeAgentEventType(payload: JsonObject): OpenClawEventType {
  const stream = readString(payload.stream);
  const data = asRecord(payload.data);
  const phase = readString(data.phase);
  const status = readString(data.status);

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
    if (phase === "end") {
      return normalizeLifecycleEndEventType(data);
    }
    if (phase === "error") {
      return "run.failed";
    }
  }
  if (stream === "tool" || stream === "item" || stream === "command_output") {
    if (phase === "start" || status === "running") {
      return "tool.call.started";
    }
    if (phase === "delta" || phase === "update") {
      return "tool.call.delta";
    }
    if (phase === "end" || status === "completed") {
      return "tool.call.completed";
    }
    if (status === "failed" || status === "blocked") {
      return "tool.call.failed";
    }
    return "tool.call.delta";
  }
  if (stream === "approval") {
    return phase === "resolved" ? "approval.resolved" : "approval.requested";
  }
  if (stream === "patch") {
    return "artifact.updated";
  }
  if (stream === "error") {
    return "run.failed";
  }
  return "raw";
}

function normalizeNamedEventType(event: GatewayEvent): OpenClawEventType {
  const payload = asRecord(event.payload);
  switch (event.event) {
    case "agent":
      return normalizeAgentEventType(payload);
    case "sessions.changed": {
      const reason = readString(payload.reason);
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

export function normalizeGatewayEvent(event: GatewayEvent): OpenClawEvent {
  const payload = asRecord(event.payload);
  const runId = readString(payload.runId);
  const sessionId = readString(payload.sessionId);
  const sessionKey = readString(payload.sessionKey);
  const taskId = readString(payload.taskId);
  const agentId = readString(payload.agentId);
  const ts = readNumber(payload.ts) ?? Date.now();
  const idParts = [event.seq ?? "local", event.event, runId, sessionKey, ts].filter(Boolean);

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
