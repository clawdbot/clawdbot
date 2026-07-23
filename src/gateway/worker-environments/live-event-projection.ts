import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  capLiveExecResult,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "../../agents/embedded-agent-subscribe.tools.js";
import { normalizeToolName } from "../../agents/tool-policy.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";

export type WorkerLiveTrajectoryTarget = {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

export type WorkerLiveTrajectoryRecorder = ReturnType<typeof createTrajectoryRuntimeRecorder>;

export function prepareWorkerLiveEventData(
  event: WorkerLiveEventParams["event"],
): Record<string, unknown> {
  const payload = structuredClone(event.payload) as Record<string, unknown>;
  if (event.kind !== "tool") {
    return payload;
  }
  const toolName = normalizeToolName(event.payload.name);
  payload.name = toolName;
  if (event.payload.phase === "start") {
    payload.args = sanitizeToolArgs(event.payload.args);
  } else if (event.payload.phase === "update") {
    const partialResult = sanitizeToolResult(event.payload.partialResult);
    payload.partialResult = toolName === "exec" ? capLiveExecResult(partialResult) : partialResult;
  } else {
    const result = sanitizeToolResult(event.payload.result);
    payload.result = toolName === "exec" ? capLiveExecResult(result) : result;
  }
  return payload;
}

export function isDefinitiveWorkerTerminalEvent(event: WorkerLiveEventParams["event"]): boolean {
  return (
    event.kind === "lifecycle" &&
    (event.payload.phase === "end" ||
      (event.payload.phase === "error" &&
        (event.payload.aborted === true || event.payload.fallbackExhaustedFailure === true)))
  );
}

export function createWorkerLiveTrajectoryRecorder(params: {
  runId: string;
  target: WorkerLiveTrajectoryTarget;
}): WorkerLiveTrajectoryRecorder {
  return createTrajectoryRuntimeRecorder({
    runId: params.runId,
    sessionId: params.target.sessionId,
    sessionKey: params.target.sessionKey,
    sessionFile: params.target.sessionKey,
  });
}

export function recordWorkerLiveTrajectoryEvent(
  recorder: WorkerLiveTrajectoryRecorder,
  event: WorkerLiveEventParams["event"],
): void {
  if (!recorder) {
    return;
  }
  const data = prepareWorkerLiveEventData(event);
  let recorded = false;
  if (event.kind === "tool") {
    if (event.payload.phase === "start") {
      recorder.recordEvent("tool.call", data);
      recorded = true;
    } else if (event.payload.phase === "result") {
      recorder.recordEvent("tool.result", {
        ...data,
        success: !event.payload.isError,
      });
      recorded = true;
    }
  } else if (event.kind === "approval") {
    recorder.recordEvent(`approval.${event.payload.phase}`, data);
    recorded = true;
  } else if (event.kind === "lifecycle") {
    if (event.payload.phase === "start") {
      recorder.recordEvent("session.started", { ...data, backend: "cloud-worker" });
      recorded = true;
    } else if (event.payload.phase === "fallback_step") {
      recorder.recordEvent("model.fallback_step", data);
      recorded = true;
    } else if (event.payload.phase === "finishing") {
      recorder.recordEvent("model.finishing", data);
      recorded = true;
    } else if (
      (event.payload.phase === "end" || event.payload.phase === "error") &&
      isDefinitiveWorkerTerminalEvent(event)
    ) {
      const failed = event.payload.phase === "error";
      const interrupted = event.payload.aborted === true;
      recorder.recordEvent("model.completed", {
        ...data,
        ...(failed ? { promptError: event.payload.error } : {}),
      });
      recorder.recordEvent("session.ended", {
        ...data,
        status: interrupted ? "interrupted" : failed ? "error" : "success",
      });
      recorded = true;
    }
  }
  if (!recorded) {
    return;
  }
  // Live delivery is authoritative; trajectory diagnostics must never reject a
  // worker event. SQLite flushing begins synchronously and failures stay isolated.
  void recorder.flush().catch(() => undefined);
}
