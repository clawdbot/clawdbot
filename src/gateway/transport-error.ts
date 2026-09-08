import type { GatewayConnectionDetails } from "./connection-details.js";

export type GatewayTransportErrorKind = "closed" | "timeout";

export class GatewayTransportError extends Error {
  readonly kind: GatewayTransportErrorKind;
  readonly connectionDetails: GatewayConnectionDetails;
  readonly code?: number;
  readonly reason?: string;
  readonly timeoutMs?: number;

  constructor(params: {
    kind: GatewayTransportErrorKind;
    message: string;
    connectionDetails: GatewayConnectionDetails;
    code?: number;
    reason?: string;
    timeoutMs?: number;
  }) {
    super(params.message);
    this.name = "GatewayTransportError";
    this.kind = params.kind;
    this.connectionDetails = params.connectionDetails;
    if (params.code !== undefined) {
      this.code = params.code;
    }
    if (params.reason !== undefined) {
      this.reason = params.reason;
    }
    if (params.timeoutMs !== undefined) {
      this.timeoutMs = params.timeoutMs;
    }
  }
}

export function isGatewayTransportError(value: unknown): value is GatewayTransportError {
  if (value instanceof GatewayTransportError) {
    return true;
  }
  if (!(value instanceof Error) || value.name !== "GatewayTransportError") {
    return false;
  }
  return (
    "kind" in value &&
    (value.kind === "closed" || value.kind === "timeout") &&
    "connectionDetails" in value &&
    typeof value.connectionDetails === "object" &&
    value.connectionDetails !== null
  );
}

/** Transport uncertainty permits read recovery or an exclusively ownership-locked mutation. */
export function isGatewayRpcUnavailableError(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    return error.kind === "timeout" || [undefined, 1006, 1012].includes(error.code);
  }
  // Pending protocol requests still surface these exact transport failures as plain Errors.
  return (
    error instanceof Error &&
    error.name === "Error" &&
    (/^gateway closed \((?:1006|1012)\): [^\r\n]*$/u.test(error.message) ||
      /^gateway timeout after \d+ms(?:\n[\s\S]*)?$/u.test(error.message))
  );
}
