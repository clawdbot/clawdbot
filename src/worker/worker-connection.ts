import type { WebSocket } from "ws";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import type {
  WorkerHeartbeatParams,
  WorkerHeartbeatResponseFrame,
  WorkerHelloOk,
  WorkerLiveEventParams,
  WorkerLiveEventResponseFrame,
  WorkerProtocolCloseReason,
  WorkerTranscriptCommitParams,
  WorkerTranscriptCommitResponseFrame,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceCancelParams,
  WorkerInferenceCancelResponseFrame,
  WorkerInferenceEventFrame,
  WorkerInferenceStartParams,
  WorkerInferenceStartResponseFrame,
  WorkerInferenceTerminalFrame,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../infra/backoff.js";
import {
  connectWorkerConnectionAttempt,
  isRetryableWorkerCloseReason,
} from "./worker-connection-admission.js";
import {
  WorkerAdmissionDeadlineExceededError,
  WorkerAdmissionError,
  WorkerConnectionInterruptedError,
  WorkerConnectionStoppedError,
  WorkerFencedError,
  isFencedCloseReason,
  resolvePositiveTimeout,
  toError,
  type WorkerConnectionExit,
  type WorkerConnectionOptions,
  type WorkerConnectionState,
  type WorkerFencedReason,
} from "./worker-connection-contract.js";
import { WorkerConnectionFrameDispatcher } from "./worker-connection-frames.js";

export {
  WorkerConnectionInterruptedError,
  WorkerConnectionStoppedError,
  WorkerFencedError,
} from "./worker-connection-contract.js";
export type { WorkerConnectionState } from "./worker-connection-contract.js";

const DEFAULT_RECONNECT_BACKOFF: BackoffPolicy = {
  initialMs: 250,
  maxMs: 30_000,
  factor: 2,
  jitter: 0,
};

const DEFAULT_ADMISSION_TIMEOUT_MS = DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS;
const DEFAULT_ADMISSION_DEADLINE_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type ReadyWaiter = {
  resolve: (hello: WorkerHelloOk) => void;
  reject: (error: Error) => void;
};

export class WorkerConnection {
  private stateValue: WorkerConnectionState = { kind: "idle" };
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly readyListeners = new Set<(hello: WorkerHelloOk) => void>();
  private readonly stateListeners = new Set<(state: WorkerConnectionState) => void>();
  private readonly frames: WorkerConnectionFrameDispatcher;
  private readonly reconnectAbort = new AbortController();
  private readonly exitPromise: Promise<WorkerConnectionExit>;
  private resolveExit!: (exit: WorkerConnectionExit) => void;
  private exitSettled = false;
  private generation = 0;
  private socket: WebSocket | undefined;
  private startPromise: Promise<WorkerHelloOk> | undefined;
  private reconnectPromise: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly admissionTimeoutMs: number;
  private readonly admissionDeadlineMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: WorkerConnectionOptions) {
    this.admissionTimeoutMs = resolvePositiveTimeout(
      options.admissionTimeoutMs,
      DEFAULT_ADMISSION_TIMEOUT_MS,
    );
    this.admissionDeadlineMs = resolvePositiveTimeout(
      options.admissionDeadlineMs,
      DEFAULT_ADMISSION_DEADLINE_MS,
    );
    this.requestTimeoutMs = resolvePositiveTimeout(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.frames = new WorkerConnectionFrameDispatcher({
      connectParams: () => this.options.connectParams,
      requestTimeoutMs: this.requestTimeoutMs,
      isReady: () => this.stateValue.kind === "ready",
      socket: () => this.socket,
      isTerminal: () => this.isTerminal(),
      terminalError: () => this.terminalError(),
      interruptReadySocket: (socket) => this.interruptReadySocket(socket),
    });
  }

  get state(): WorkerConnectionState {
    return this.stateValue;
  }

  start(): Promise<WorkerHelloOk> {
    if (this.stateValue.kind === "ready") {
      return Promise.resolve(this.stateValue.hello);
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.isTerminal()) {
      return Promise.reject(this.terminalError());
    }
    this.startPromise = this.connectUntilReady();
    return this.startPromise;
  }

  waitForExit(): Promise<WorkerConnectionExit> {
    return this.exitPromise;
  }

  waitForReady(): Promise<WorkerHelloOk> {
    if (this.stateValue.kind === "ready") {
      return Promise.resolve(this.stateValue.hello);
    }
    if (this.isTerminal()) {
      return Promise.reject(this.terminalError());
    }
    return new Promise((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  }

  onReady(listener: (hello: WorkerHelloOk) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  onStateChange(listener: (state: WorkerConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onInferenceEvent(listener: (frame: WorkerInferenceEventFrame) => void): () => void {
    return this.frames.onInferenceEvent(listener);
  }

  onInferenceTerminal(listener: (frame: WorkerInferenceTerminalFrame) => void): () => void {
    return this.frames.onInferenceTerminal(listener);
  }

  async stop(): Promise<void> {
    if (this.stateValue.kind === "stopped") {
      return;
    }
    this.reconnectAbort.abort(new Error("worker connection stopped"));
    this.stopHeartbeat();
    const stopped = new WorkerConnectionStoppedError();
    this.frames.rejectPending(stopped);
    this.rejectReadyWaiters(stopped);
    this.socket?.close(1000, "worker stopped");
    this.socket = undefined;
    this.transition({ kind: "stopped" });
    this.settleExit({ kind: "stopped" });
  }

  fence(reason: WorkerFencedReason): void {
    if (!this.isTerminal()) {
      this.finishFenced(reason);
    }
  }

  requestHeartbeat(params: WorkerHeartbeatParams): Promise<WorkerHeartbeatResponseFrame> {
    return this.frames.requestHeartbeat(params);
  }

  requestTranscriptCommit(
    params: WorkerTranscriptCommitParams,
  ): Promise<WorkerTranscriptCommitResponseFrame> {
    return this.frames.requestTranscriptCommit(params);
  }

  requestLiveEvent(params: WorkerLiveEventParams): Promise<WorkerLiveEventResponseFrame> {
    return this.frames.requestLiveEvent(params);
  }

  requestInferenceStart(
    params: WorkerInferenceStartParams,
    beforeResolve?: (frame: WorkerInferenceStartResponseFrame) => void,
  ): Promise<WorkerInferenceStartResponseFrame> {
    return this.frames.requestInferenceStart(params, beforeResolve);
  }

  requestInferenceCancel(
    params: WorkerInferenceCancelParams,
  ): Promise<WorkerInferenceCancelResponseFrame> {
    return this.frames.requestInferenceCancel(params);
  }

  private async connectUntilReady(): Promise<WorkerHelloOk> {
    const startedAt = Date.now();
    let attempt = 0;
    while (!this.isTerminal()) {
      let remainingMs = this.admissionDeadlineMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw this.failAdmissionDeadline();
      }
      if (attempt > 0) {
        this.transition({ kind: "reconnecting", attempt });
        try {
          await sleepWithAbort(
            Math.min(
              computeBackoff(this.options.reconnectBackoff ?? DEFAULT_RECONNECT_BACKOFF, attempt),
              remainingMs,
            ),
            this.reconnectAbort.signal,
          );
        } catch (error) {
          throw this.isTerminal() ? this.terminalError() : toError(error);
        }
        remainingMs = this.admissionDeadlineMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
          throw this.failAdmissionDeadline();
        }
      }
      try {
        return await this.connectOnce(attempt, Math.min(this.admissionTimeoutMs, remainingMs));
      } catch (error) {
        if (error instanceof WorkerAdmissionError) {
          if (error.retryable) {
            attempt += 1;
            continue;
          }
          this.handleAdmissionFailure(error);
          throw error;
        }
        if (this.isTerminal()) {
          throw this.terminalError();
        }
        attempt += 1;
      }
    }
    throw this.terminalError();
  }

  private connectOnce(attempt: number, attemptTimeoutMs: number): Promise<WorkerHelloOk> {
    const generation = ++this.generation;
    this.transition({ kind: "connecting", attempt });
    return connectWorkerConnectionAttempt({
      attemptTimeoutMs,
      connectionOptions: this.options,
      isCurrentGeneration: () => generation === this.generation,
      isTerminal: () => this.isTerminal(),
      onSocket: (socket) => {
        this.socket = socket;
      },
      onAdmitting: () => {
        this.transition({ kind: "admitting", attempt });
      },
      onReady: (hello) => {
        this.transition({ kind: "ready", hello });
        this.notifyReady(hello);
        this.startHeartbeat(hello.policy.heartbeatIntervalMs);
      },
      onReadyFrame: (frame, socket) => {
        this.frames.dispatchReadyFrame(frame, socket);
      },
      onSocketClosed: () => {
        this.stopHeartbeat();
        this.socket = undefined;
        const interrupted = new WorkerConnectionInterruptedError();
        this.frames.rejectPending(interrupted);
        return interrupted;
      },
      onReadyClose: (reason) => this.handleReadyClose(reason),
    });
  }

  private handleReadyClose(reason: WorkerProtocolCloseReason | undefined): void {
    if (this.isTerminal()) {
      return;
    }
    if (reason && isFencedCloseReason(reason)) {
      this.finishFenced(reason);
      return;
    }
    if (reason && !isRetryableWorkerCloseReason(reason)) {
      this.finishFailed(new WorkerAdmissionError(reason, false));
      return;
    }
    if (!this.reconnectPromise) {
      this.reconnectPromise = this.reconnectAfterClose();
    }
  }

  private async reconnectAfterClose(): Promise<void> {
    try {
      await this.connectUntilReady();
    } catch (error) {
      if (!this.isTerminal()) {
        this.finishFailed(toError(error));
      }
    } finally {
      this.reconnectPromise = undefined;
    }
  }

  private handleAdmissionFailure(error: WorkerAdmissionError): void {
    if (isFencedCloseReason(error.reason)) {
      this.finishFenced(error.reason);
      return;
    }
    this.finishFailed(error);
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      void this.sendHeartbeat();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.stateValue.kind !== "ready") {
      return;
    }
    const intervalMs = this.stateValue.hello.policy.heartbeatIntervalMs;
    try {
      const response = await this.requestHeartbeat({
        sentAtMs: Date.now(),
        status: this.options.heartbeatStatus?.() ?? "ready",
      });
      if (response.ok) {
        if (response.payload.ownerEpoch !== this.options.connectParams.admission.ownerEpoch) {
          // Fenced: state is now terminal, so the trailing kind==="ready" guard skips re-arming.
          this.finishFenced("owner-epoch-mismatch");
        }
      } else if (isFencedCloseReason(response.error.details.reason)) {
        this.finishFenced(response.error.details.reason);
        return;
      } else {
        this.finishFailed(new Error(`worker heartbeat rejected: ${response.error.details.reason}`));
        return;
      }
    } catch (error) {
      if (!(error instanceof WorkerConnectionInterruptedError) && !this.isTerminal()) {
        this.finishFailed(toError(error));
        return;
      }
    }
    if (this.stateValue.kind === "ready") {
      this.startHeartbeat(intervalMs);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private interruptReadySocket(socket: WebSocket): void {
    if (this.socket === socket && this.stateValue.kind === "ready") {
      this.transition({ kind: "reconnecting", attempt: 0 });
    }
    socket.terminate();
  }

  private notifyReady(hello: WorkerHelloOk): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) {
      waiter.resolve(hello);
    }
    for (const listener of this.readyListeners) {
      listener(hello);
    }
  }

  private transition(state: WorkerConnectionState): void {
    this.stateValue = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private finishFenced(reason: WorkerFencedReason): void {
    this.stopHeartbeat();
    const error = new WorkerFencedError(reason);
    this.frames.rejectPending(error);
    this.rejectReadyWaiters(error);
    this.socket?.close(1008, reason);
    this.transition({ kind: "fenced", reason });
    this.settleExit({ kind: "fenced", reason });
  }

  private finishFailed(error: Error): void {
    this.stopHeartbeat();
    this.frames.rejectPending(error);
    this.rejectReadyWaiters(error);
    this.socket?.close(1008, "invalid-frame");
    this.transition({ kind: "failed", error });
    this.settleExit({ kind: "failed", error });
  }

  private rejectReadyWaiters(error: Error): void {
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private settleExit(exit: WorkerConnectionExit): void {
    if (this.exitSettled) {
      return;
    }
    this.exitSettled = true;
    this.resolveExit(exit);
  }

  private failAdmissionDeadline(): Error {
    if (this.isTerminal()) {
      return this.terminalError();
    }
    const error = new WorkerAdmissionDeadlineExceededError();
    this.finishFailed(error);
    return error;
  }

  private isTerminal(): boolean {
    return (
      this.stateValue.kind === "failed" ||
      this.stateValue.kind === "fenced" ||
      this.stateValue.kind === "stopped"
    );
  }

  private terminalError(): Error {
    if (this.stateValue.kind === "failed") {
      return this.stateValue.error;
    }
    if (this.stateValue.kind === "fenced") {
      return new WorkerFencedError(this.stateValue.reason);
    }
    if (this.stateValue.kind === "stopped") {
      return new WorkerConnectionStoppedError();
    }
    return new WorkerConnectionInterruptedError("worker connection terminated");
  }
}

export function createWorkerConnection(options: WorkerConnectionOptions): WorkerConnection {
  return new WorkerConnection(options);
}
