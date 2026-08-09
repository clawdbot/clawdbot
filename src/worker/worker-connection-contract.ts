import type { WebSocket } from "ws";
import type {
  WorkerConnectParams,
  WorkerHeartbeatParams,
  WorkerHelloOk,
  WorkerProtocolCloseReason,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { toErrorObject } from "../infra/errors.js";

const FENCED_CLOSE_REASONS = new Set<WorkerProtocolCloseReason>([
  "credential-replaced",
  "owner-epoch-mismatch",
]);
const ERROR_OWNED_FIELDS = new Set(["cause", "message", "name", "stack"]);
const PROTOTYPE_MUTATING_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

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
  if (error instanceof Error) {
    return error;
  }
  const message = String(error);
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return toErrorObject(error, message);
  }
  const normalized = toErrorObject({}, message);
  normalized.cause = error;
  try {
    const detailKeys = Reflect.ownKeys(error).filter(
      (key) =>
        (typeof key !== "string" ||
          (!ERROR_OWNED_FIELDS.has(key) && !PROTOTYPE_MUTATING_FIELDS.has(key))) &&
        Reflect.getOwnPropertyDescriptor(error, key)?.enumerable,
    );
    for (const key of detailKeys) {
      try {
        Object.defineProperty(normalized, key, {
          value: Reflect.get(error, key),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch {
        // Skip fields whose getters or property definitions reject access.
      }
    }
  } catch {
    // Opaque proxies may reject enumeration; preserve the original failure as the cause.
  }
  return normalized;
}
