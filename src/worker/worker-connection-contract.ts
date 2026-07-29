import type { WebSocket } from "ws";
import type {
  WorkerConnectParams,
  WorkerHeartbeatParams,
  WorkerHelloOk,
  WorkerProtocolCloseReason,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { BackoffPolicy } from "../infra/backoff.js";

const FENCED_CLOSE_REASONS = new Set<WorkerProtocolCloseReason>([
  "credential-replaced",
  "owner-epoch-mismatch",
]);

export type WorkerFencedReason = "credential-replaced" | "owner-epoch-mismatch";

export function isFencedCloseReason(
  reason: WorkerProtocolCloseReason,
): reason is WorkerFencedReason {
  return FENCED_CLOSE_REASONS.has(reason);
}

export type WorkerConnectionState =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "admitting"; attempt: number }
  | { kind: "ready"; hello: WorkerHelloOk }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "fenced"; reason: WorkerFencedReason }
  | { kind: "failed"; error: Error }
  | { kind: "stopped" };

export type WorkerConnectionExit =
  | { kind: "fenced"; reason: WorkerFencedReason }
  | { kind: "failed"; error: Error }
  | { kind: "stopped" };

export type WorkerConnectionOptions = {
  socketPath: string;
  connectParams: WorkerConnectParams;
  reconnectBackoff?: BackoffPolicy;
  admissionTimeoutMs?: number;
  admissionDeadlineMs?: number;
  requestTimeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
  heartbeatStatus?: () => WorkerHeartbeatParams["status"];
};

export class WorkerConnectionInterruptedError extends Error {
  constructor(message = "worker connection interrupted") {
    super(message);
    this.name = "WorkerConnectionInterruptedError";
  }
}

export class WorkerConnectionStoppedError extends Error {
  constructor(message = "worker connection stopped") {
    super(message);
    this.name = "WorkerConnectionStoppedError";
  }
}

export class WorkerAdmissionError extends Error {
  constructor(
    readonly reason: WorkerProtocolCloseReason,
    readonly retryable: boolean,
  ) {
    super(`worker admission rejected: ${reason}`);
    this.name = "WorkerAdmissionError";
  }
}

export class WorkerAdmissionDeadlineExceededError extends Error {
  constructor() {
    super("worker admission deadline exceeded");
    this.name = "WorkerAdmissionDeadlineExceededError";
  }
}

export class WorkerFencedError extends Error {
  constructor(readonly reason: WorkerProtocolCloseReason) {
    super(`worker fenced: ${reason}`);
    this.name = "WorkerFencedError";
  }
}

export function resolvePositiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("worker connection timeout must be a positive safe integer");
  }
  return value;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
