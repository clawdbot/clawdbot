import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { WebSocket } from "ws";
import {
  type WorkerConnectParams,
  type WorkerHeartbeatParams,
  type WorkerHeartbeatResponseFrame,
  WorkerHeartbeatResponseFrameSchema,
  type WorkerLiveEventParams,
  type WorkerLiveEventResponseFrame,
  WorkerLiveEventResponseFrameSchema,
  type WorkerPortalParams,
  type WorkerPortalResponseFrame,
  WorkerPortalResponseFrameSchema,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  type WorkerSessionsSendParams,
  type WorkerSessionsSendResponseFrame,
  WorkerSessionsSendResponseFrameSchema,
  type WorkerSessionsSpawnParams,
  type WorkerSessionsSpawnResponseFrame,
  WorkerSessionsSpawnResponseFrameSchema,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitResponseFrame,
  WorkerTranscriptCommitResponseFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  type WorkerComputerParams,
  type WorkerComputerResponseFrame,
  WorkerComputerResponseFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-computer.js";
import {
  type WorkerInferenceCancelParams,
  type WorkerInferenceCancelResponseFrame,
  WorkerInferenceCancelResponseFrameSchema,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceStartResponseFrame,
  WorkerInferenceStartResponseFrameSchema,
  type WorkerInferenceTerminalFrame,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  validateWorkerInferenceEventFrame,
  validateWorkerInferenceTerminalFrame,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  WorkerSkillWorkshopResponseFrameSchema,
  type WorkerSkillWorkshopParams,
  type WorkerSkillWorkshopResponseFrame,
} from "../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import { isWorkerTranscriptFrameWithinBudget } from "../../packages/gateway-protocol/src/worker-transcript-budget.js";
import { notifyListeners } from "../shared/listeners.js";
import {
  createPendingRequestRegistry,
  type PendingRequestEntry,
} from "../shared/pending-request-registry.js";
import {
  WorkerConnectionInterruptedError,
  toWorkerConnectionError,
} from "./worker-connection-contract.js";

const WORKER_REQUEST_SPECS = {
  "skill-workshop": {
    method: "worker.skill-workshop",
    responseSchema: WorkerSkillWorkshopResponseFrameSchema,
  },
  heartbeat: {
    method: "worker.heartbeat",
    responseSchema: WorkerHeartbeatResponseFrameSchema,
  },
  transcript: {
    method: "worker.transcript.commit",
    responseSchema: WorkerTranscriptCommitResponseFrameSchema,
  },
  "live-event": {
    method: "worker.live-event",
    responseSchema: WorkerLiveEventResponseFrameSchema,
  },
  "sessions-spawn": {
    method: "worker.sessions.spawn",
    responseSchema: WorkerSessionsSpawnResponseFrameSchema,
  },
  "sessions-send": {
    method: "worker.sessions.send",
    responseSchema: WorkerSessionsSendResponseFrameSchema,
  },
  portal: {
    method: "worker.portal",
    responseSchema: WorkerPortalResponseFrameSchema,
  },
  computer: {
    method: "worker.computer",
    responseSchema: WorkerComputerResponseFrameSchema,
  },
  "inference-start": {
    method: "worker.inference.start",
    responseSchema: WorkerInferenceStartResponseFrameSchema,
  },
  "inference-cancel": {
    method: "worker.inference.cancel",
    responseSchema: WorkerInferenceCancelResponseFrameSchema,
  },
} as const;

type WorkerRequestKind = keyof typeof WORKER_REQUEST_SPECS;
type WorkerRequestParams = {
  "skill-workshop": WorkerSkillWorkshopParams;
  heartbeat: WorkerHeartbeatParams;
  transcript: WorkerTranscriptCommitParams;
  "live-event": WorkerLiveEventParams;
  "sessions-spawn": WorkerSessionsSpawnParams;
  "sessions-send": WorkerSessionsSendParams;
  portal: WorkerPortalParams;
  computer: WorkerComputerParams;
  "inference-start": WorkerInferenceStartParams;
  "inference-cancel": WorkerInferenceCancelParams;
};
type WorkerResponseFrames = {
  "skill-workshop": WorkerSkillWorkshopResponseFrame;
  heartbeat: WorkerHeartbeatResponseFrame;
  transcript: WorkerTranscriptCommitResponseFrame;
  "live-event": WorkerLiveEventResponseFrame;
  "sessions-spawn": WorkerSessionsSpawnResponseFrame;
  "sessions-send": WorkerSessionsSendResponseFrame;
  portal: WorkerPortalResponseFrame;
  computer: WorkerComputerResponseFrame;
  "inference-start": WorkerInferenceStartResponseFrame;
  "inference-cancel": WorkerInferenceCancelResponseFrame;
};
type WorkerResponseFrame = WorkerResponseFrames[WorkerRequestKind];
type PendingRequestValue = {
  kind: WorkerRequestKind;
  timeoutMs?: number;
  // Durable replay can emit its terminal as the next socket frame. Reset the
  // consumer cursor synchronously after validation, before Promise continuation.
  beforeResolve?: (frame: WorkerResponseFrame) => void;
};
type PendingRequest = PendingRequestEntry<WorkerResponseFrame, PendingRequestValue>;

type WorkerConnectionFrameDispatcherOptions = {
  connectParams: () => WorkerConnectParams;
  requestTimeoutMs: number;
  isReady: () => boolean;
  socket: () => WebSocket | undefined;
  isTerminal: () => boolean;
  terminalError: () => Error;
  interruptReadySocket: (socket: WebSocket) => void;
};

function responseId(frame: unknown): string | undefined {
  if (!frame || typeof frame !== "object") {
    return undefined;
  }
  const candidate = frame as { id?: unknown; type?: unknown };
  return candidate.type === "res" && typeof candidate.id === "string" ? candidate.id : undefined;
}

export function closeInvalidWorkerFrame(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1008, "invalid-frame");
  }
}

export class WorkerConnectionFrameDispatcher {
  private readonly pending = createPendingRequestRegistry<
    string,
    WorkerResponseFrame,
    PendingRequestValue
  >();
  private readonly inferenceEventListeners = new Set<(frame: WorkerInferenceEventFrame) => void>();
  private readonly inferenceTerminalListeners = new Set<
    (frame: WorkerInferenceTerminalFrame) => void
  >();

  constructor(private readonly options: WorkerConnectionFrameDispatcherOptions) {}

  onInferenceEvent(listener: (frame: WorkerInferenceEventFrame) => void): () => void {
    this.inferenceEventListeners.add(listener);
    return () => this.inferenceEventListeners.delete(listener);
  }

  onInferenceTerminal(listener: (frame: WorkerInferenceTerminalFrame) => void): () => void {
    this.inferenceTerminalListeners.add(listener);
    return () => this.inferenceTerminalListeners.delete(listener);
  }

  dispatchReadyFrame(frame: unknown, socket: WebSocket): void {
    if (validateWorkerInferenceEventFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      notifyListeners(this.inferenceEventListeners, frame);
      return;
    }
    if (validateWorkerInferenceTerminalFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      notifyListeners(this.inferenceTerminalListeners, frame);
      return;
    }
    const id = responseId(frame);
    const pending = id ? this.pending.get(id) : undefined;
    if (!id || !pending) {
      closeInvalidWorkerFrame(socket);
      return;
    }
    if (!this.resolvePendingFrame(id, pending, frame)) {
      closeInvalidWorkerFrame(socket);
    }
  }

  rejectPending(error: Error): void {
    this.pending.rejectAll(error);
  }

  private matchesInferenceIdentity(payload: { runEpoch: number; sessionId: string }): boolean {
    const admission = this.options.connectParams().admission;
    return payload.runEpoch === admission.ownerEpoch && payload.sessionId === admission.sessionId;
  }

  request<K extends WorkerRequestKind>(
    kind: K,
    params: WorkerRequestParams[K],
    beforeResolve?: (frame: WorkerResponseFrames[K]) => void,
    timeoutMs?: number,
  ): Promise<WorkerResponseFrames[K]> {
    const id = randomUUID();
    const spec = WORKER_REQUEST_SPECS[kind];
    const frame = { type: "req", id, method: spec.method, params };
    if (
      kind === "transcript" &&
      !isWorkerTranscriptFrameWithinBudget({
        type: "req",
        id,
        method: "worker.transcript.commit",
        // SAFETY: The generic request kind selects its matching WorkerRequestParams member.
        params: params as WorkerTranscriptCommitParams,
      })
    ) {
      return Promise.reject(new Error("worker transcript exceeds the protocol payload limit"));
    }
    const wrappedBeforeResolve = beforeResolve
      ? (response: WorkerResponseFrame) => beforeResolve(response as WorkerResponseFrames[K])
      : undefined;
    return this.sendRequest(id, frame, {
      kind,
      ...(wrappedBeforeResolve ? { beforeResolve: wrappedBeforeResolve } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }) as Promise<WorkerResponseFrames[K]>;
  }

  private resolvePendingFrame(id: string, pending: PendingRequest, frame: unknown): boolean {
    const spec = WORKER_REQUEST_SPECS[pending.value.kind];
    if (!Value.Check(spec.responseSchema, frame)) {
      return false;
    }
    const completed = this.pending.take(id, pending);
    if (!completed) {
      return false;
    }
    const response = frame as WorkerResponseFrame;
    try {
      completed.value.beforeResolve?.(response);
    } catch (error) {
      completed.reject(toWorkerConnectionError(error));
      return true;
    }
    completed.resolve(response);
    return true;
  }

  private sendRequest(
    id: string,
    frame: object,
    value: PendingRequestValue,
  ): Promise<WorkerResponseFrame> {
    const ready = this.options.isReady();
    const readySocket = ready ? this.options.socket() : undefined;
    if (!ready || !readySocket || readySocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        this.options.isTerminal()
          ? this.options.terminalError()
          : new WorkerConnectionInterruptedError("worker connection is not ready"),
      );
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(frame);
    } catch (error) {
      return Promise.reject(toWorkerConnectionError(error));
    }
    const payloadLimit =
      value.kind === "inference-start" || value.kind === "transcript"
        ? WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES
        : WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
    if (Buffer.byteLength(encoded, "utf8") > payloadLimit) {
      return Promise.reject(new Error("worker request exceeds the protocol payload limit"));
    }
    const pending = this.pending.add(id, {
      value,
      timeoutMs: value.timeoutMs ?? this.options.requestTimeoutMs,
      timeoutError: () =>
        new WorkerConnectionInterruptedError(`worker ${value.kind} response timed out`),
      onTimeout: () => this.options.interruptReadySocket(readySocket),
    });
    if (!pending) {
      return Promise.reject(new Error("worker request id collision"));
    }
    try {
      readySocket.send(encoded, (error) => {
        if (!error) {
          return;
        }
        const failed = this.pending.take(id, pending);
        if (!failed) {
          return;
        }
        failed.reject(new WorkerConnectionInterruptedError(error.message));
        this.options.interruptReadySocket(readySocket);
      });
    } catch (error) {
      this.pending
        .take(id, pending)
        ?.reject(new WorkerConnectionInterruptedError(toWorkerConnectionError(error).message));
      this.options.interruptReadySocket(readySocket);
    }
    return pending.promise;
  }
}
