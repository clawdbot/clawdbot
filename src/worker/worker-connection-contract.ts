import { toStructuredErrorObject } from "@openclaw/normalization-core/error-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ClientOptions, WebSocket } from "ws";
import type {
  WorkerConnectParams,
  WorkerHeartbeatParams,
  WorkerHelloOk,
  WorkerProtocolCloseReason,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { WorkerConnectionEndpoint } from "./worker-connection-endpoint.js";

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
  endpoint: WorkerConnectionEndpoint;
  connectParams: WorkerConnectParams;
  reconnectBackoff?: BackoffPolicy;
  admissionTimeoutMs?: number;
  admissionDeadlineMs?: number;
  requestTimeoutMs?: number;
  createSocket?: (url: string, options: ClientOptions) => WebSocket;
  heartbeatStatus?: () => WorkerHeartbeatParams["status"];
  onConnectionFailure?: (error: Error | undefined) => void;
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
  constructor(diagnosis: string) {
    super(diagnosis);
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

export function toWorkerConnectionError(error: unknown): Error {
  return toStructuredErrorObject(error);
}

export function formatWorkerConnectionFailure(
  options: WorkerConnectionOptions,
  error: unknown,
  attempts?: number,
): string {
  const endpoint = options.endpoint;
  let address: string;
  if (endpoint.kind === "websocket") {
    const url = new URL(endpoint.url);
    address = `${url.hostname}:${url.port || (url.protocol === "wss:" ? "443" : "80")}`;
  } else {
    address = endpoint.socketPath;
  }
  const target = truncateUtf16Safe(address, 128);
  let detail = toWorkerConnectionError(error).message;
  const access = endpoint.kind === "websocket" ? endpoint.cloudflareAccess : undefined;
  const credentials = [
    options.connectParams.admission.credential,
    ...(access ? [access.clientId, access.clientSecret] : []),
  ];
  // Scrub before truncating so a cut credential cannot escape into stderr or IPC.
  for (const credential of credentials) {
    for (const value of [
      credential,
      encodeURIComponent(credential),
      JSON.stringify(credential).slice(1, -1),
    ]) {
      if (value) {
        detail = detail.replaceAll(value, "[REDACTED]");
      }
    }
  }
  if (endpoint.kind === "websocket") {
    detail = detail.replaceAll(endpoint.url, target);
  }
  const cause =
    truncateUtf16Safe(
      redactSensitiveText(detail, { mode: "tools" }).replace(/\s+/gu, " ").trim(),
      160,
    ) || "connection failed";
  if (attempts !== undefined) {
    return `worker admission deadline exceeded after ${attempts} attempts to ${target}: ${cause}`;
  }
  const hint =
    endpoint.kind === "websocket"
      ? "check TLS pin/publicUrl configuration"
      : "check the local gateway socket";
  return `worker could not reach gateway ${target}: ${cause}; ${hint}`;
}
