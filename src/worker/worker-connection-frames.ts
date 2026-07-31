import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { WebSocket } from "ws";
import {
  type WorkerConnectParams,
  type WorkerHeartbeatParams,
  type WorkerHeartbeatRequestFrame,
  type WorkerHeartbeatResponseFrame,
  WorkerHeartbeatResponseFrameSchema,
  type WorkerLiveEventParams,
  type WorkerLiveEventRequestFrame,
  type WorkerLiveEventResponseFrame,
  WorkerLiveEventResponseFrameSchema,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitRequestFrame,
  type WorkerTranscriptCommitResponseFrame,
  WorkerTranscriptCommitResponseFrameSchema,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  type WorkerInferenceCancelParams,
  type WorkerInferenceCancelRequestFrame,
  type WorkerInferenceCancelResponseFrame,
  WorkerInferenceCancelResponseFrameSchema,
  type WorkerInferenceEventFrame,
  type WorkerInferenceStartParams,
  type WorkerInferenceStartRequestFrame,
  type WorkerInferenceStartResponseFrame,
  WorkerInferenceStartResponseFrameSchema,
  type WorkerInferenceTerminalFrame,
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  validateWorkerInferenceEventFrame,
  validateWorkerInferenceTerminalFrame,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WorkerConnectionInterruptedError, toError } from "./worker-connection-contract.js";

type PendingHeartbeat = {
  kind: "heartbeat";
  resolve: (frame: WorkerHeartbeatResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingTranscript = {
  kind: "transcript";
  resolve: (frame: WorkerTranscriptCommitResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingLiveEvent = {
  kind: "live-event";
  resolve: (frame: WorkerLiveEventResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingInferenceStart = {
  kind: "inference-start";
  // Durable replay can emit its terminal as the next socket frame. Reset the
  // consumer cursor synchronously after validation, before Promise continuation.
  beforeResolve?: (frame: WorkerInferenceStartResponseFrame) => void;
  resolve: (frame: WorkerInferenceStartResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingInferenceCancel = {
  kind: "inference-cancel";
  resolve: (frame: WorkerInferenceCancelResponseFrame) => void;
  reject: (error: Error) => void;
};

type PendingRequest = (
  | PendingHeartbeat
  | PendingTranscript
  | PendingLiveEvent
  | PendingInferenceStart
  | PendingInferenceCancel
) & { timeout?: ReturnType<typeof setTimeout> };

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
  private readonly pending = new Map<string, PendingRequest>();
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

  requestHeartbeat(params: WorkerHeartbeatParams): Promise<WorkerHeartbeatResponseFrame> {
    const id = randomUUID();
    const frame: WorkerHeartbeatRequestFrame = {
      type: "req",
      id,
      method: "worker.heartbeat",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "heartbeat", resolve, reject });
    });
  }

  requestTranscriptCommit(
    params: WorkerTranscriptCommitParams,
  ): Promise<WorkerTranscriptCommitResponseFrame> {
    const id = randomUUID();
    const frame: WorkerTranscriptCommitRequestFrame = {
      type: "req",
      id,
      method: "worker.transcript.commit",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "transcript", resolve, reject });
    });
  }

  requestLiveEvent(params: WorkerLiveEventParams): Promise<WorkerLiveEventResponseFrame> {
    const id = randomUUID();
    const frame: WorkerLiveEventRequestFrame = {
      type: "req",
      id,
      method: "worker.live-event",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "live-event", resolve, reject });
    });
  }

  requestInferenceStart(
    params: WorkerInferenceStartParams,
    beforeResolve?: (frame: WorkerInferenceStartResponseFrame) => void,
  ): Promise<WorkerInferenceStartResponseFrame> {
    const id = randomUUID();
    const frame: WorkerInferenceStartRequestFrame = {
      type: "req",
      id,
      method: "worker.inference.start",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, {
        kind: "inference-start",
        ...(beforeResolve ? { beforeResolve } : {}),
        resolve,
        reject,
      });
    });
  }

  requestInferenceCancel(
    params: WorkerInferenceCancelParams,
  ): Promise<WorkerInferenceCancelResponseFrame> {
    const id = randomUUID();
    const frame: WorkerInferenceCancelRequestFrame = {
      type: "req",
      id,
      method: "worker.inference.cancel",
      params,
    };
    return new Promise((resolve, reject) => {
      this.sendRequest(id, frame, { kind: "inference-cancel", resolve, reject });
    });
  }

  dispatchReadyFrame(frame: unknown, socket: WebSocket): void {
    if (validateWorkerInferenceEventFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      for (const listener of this.inferenceEventListeners) {
        listener(frame);
      }
      return;
    }
    if (validateWorkerInferenceTerminalFrame(frame)) {
      if (!this.matchesInferenceIdentity(frame.payload)) {
        closeInvalidWorkerFrame(socket);
        return;
      }
      for (const listener of this.inferenceTerminalListeners) {
        listener(frame);
      }
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
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      if (request.timeout) {
        clearTimeout(request.timeout);
        request.timeout = undefined;
      }
      request.reject(error);
    }
  }

  private matchesInferenceIdentity(payload: { runEpoch: number; sessionId: string }): boolean {
    const admission = this.options.connectParams().admission;
    return payload.runEpoch === admission.ownerEpoch && payload.sessionId === admission.sessionId;
  }

  private resolvePendingFrame(id: string, pending: PendingRequest, frame: unknown): boolean {
    switch (pending.kind) {
      case "heartbeat": {
        if (!Value.Check(WorkerHeartbeatResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerHeartbeatResponseFrame);
        return true;
      }
      case "transcript": {
        if (!Value.Check(WorkerTranscriptCommitResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerTranscriptCommitResponseFrame);
        return true;
      }
      case "live-event": {
        if (!Value.Check(WorkerLiveEventResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerLiveEventResponseFrame);
        return true;
      }
      case "inference-start": {
        if (!Value.Check(WorkerInferenceStartResponseFrameSchema, frame)) {
          return false;
        }
        const response = frame as WorkerInferenceStartResponseFrame;
        this.deletePending(id, pending);
        try {
          pending.beforeResolve?.(response);
        } catch (error) {
          pending.reject(toError(error));
          return true;
        }
        pending.resolve(response);
        return true;
      }
      case "inference-cancel": {
        if (!Value.Check(WorkerInferenceCancelResponseFrameSchema, frame)) {
          return false;
        }
        this.deletePending(id, pending);
        pending.resolve(frame as WorkerInferenceCancelResponseFrame);
        return true;
      }
    }
    return false;
  }

  private sendRequest(id: string, frame: object, pending: PendingRequest): void {
    const ready = this.options.isReady();
    const readySocket = ready ? this.options.socket() : undefined;
    if (!ready || !readySocket || readySocket.readyState !== WebSocket.OPEN) {
      pending.reject(
        this.options.isTerminal()
          ? this.options.terminalError()
          : new WorkerConnectionInterruptedError("worker connection is not ready"),
      );
      return;
    }
    if (this.pending.has(id)) {
      pending.reject(new Error("worker request id collision"));
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(frame);
    } catch (error) {
      pending.reject(toError(error));
      return;
    }
    const payloadLimit =
      pending.kind === "inference-start"
        ? WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES
        : WORKER_PROTOCOL_MAX_PAYLOAD_BYTES;
    if (Buffer.byteLength(encoded, "utf8") > payloadLimit) {
      pending.reject(new Error("worker request exceeds the protocol payload limit"));
      return;
    }
    const socket = this.options.socket()!;
    this.pending.set(id, pending);
    pending.timeout = setTimeout(() => {
      if (!this.deletePending(id, pending)) {
        return;
      }
      pending.reject(
        new WorkerConnectionInterruptedError(`worker ${pending.kind} response timed out`),
      );
      this.options.interruptReadySocket(socket);
    }, this.options.requestTimeoutMs);
    pending.timeout.unref?.();
    try {
      socket.send(encoded, (error) => {
        if (!error || this.pending.get(id) !== pending) {
          return;
        }
        this.deletePending(id, pending);
        pending.reject(new WorkerConnectionInterruptedError(error.message));
        this.options.interruptReadySocket(socket);
      });
    } catch (error) {
      this.deletePending(id, pending);
      pending.reject(new WorkerConnectionInterruptedError(toError(error).message));
      this.options.interruptReadySocket(socket);
    }
  }

  private deletePending(id: string, pending: PendingRequest): boolean {
    if (this.pending.get(id) !== pending) {
      return false;
    }
    this.pending.delete(id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
    return true;
  }
}
