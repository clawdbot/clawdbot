import type { ErrorShape } from "@openclaw/gateway-protocol";

const gatewayResponseErrors = new WeakSet<Error>();

/** Distinguishes correlated Gateway responses from locally constructed transport errors. */
export function isGatewayProtocolResponseError(
  error: unknown,
): error is GatewayProtocolRequestError {
  return error instanceof Error && gatewayResponseErrors.has(error);
}

export type GatewayProtocolRequestOptions = {
  timeoutMs?: number | null;
  expectFinal?: boolean;
  onSent?: () => void;
  onAccepted?: (payload: unknown) => void;
  signal?: AbortSignal;
};

export class GatewayProtocolRequestError extends Error {
  readonly code: string;
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  declare readonly responsePayload?: unknown;

  constructor(error: Partial<ErrorShape>) {
    super(error.message ?? "request failed");
    this.name = "GatewayProtocolRequestError";
    this.code = error.code ?? "UNAVAILABLE";
    this.gatewayCode = this.code;
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

/** Preserve response metadata after custom factories without adding it to error JSON. */
export function retainGatewayResponsePayload(
  error: GatewayProtocolRequestError,
  payload: unknown,
): void {
  gatewayResponseErrors.add(error);
  Object.defineProperty(error, "responsePayload", {
    value: payload,
    enumerable: false,
    configurable: true,
  });
}

/** A local transport deadline, distinct from a Gateway's authoritative rejection. */
export class GatewayProtocolRequestTimeoutError extends Error {
  readonly code = "CLIENT_TIMEOUT";
  readonly method: string;
  readonly timeoutMs: number;
  readonly requestSent: boolean;

  constructor(
    params: { method: string; timeoutMs: number; requestSent: boolean },
    message = `gateway request timed out after ${params.timeoutMs}ms: ${params.method}`,
  ) {
    super(message);
    this.name = "GatewayProtocolRequestTimeoutError";
    this.method = params.method;
    this.timeoutMs = params.timeoutMs;
    this.requestSent = params.requestSent;
  }
}
