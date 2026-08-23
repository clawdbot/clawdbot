// Diagnostic payload helpers emit structured diagnostic events with normalized fields.
import { emitInternalDiagnosticEvent as emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

// Diagnostic helpers for oversized payload decisions across channels/providers.
type LargePayloadBase = {
  surface: string;
  bytes?: number;
  limitBytes?: number;
  count?: number;
  channel?: string;
  pluginId?: string;
  reason?: string;
};

/** Emits a normalized diagnostic event for rejected, truncated, or chunked payloads. */
export function logLargePayload(
  params: LargePayloadBase & {
    action: "rejected" | "truncated" | "chunked";
  },
): void {
  emitDiagnosticEvent({
    type: "payload.large",
    ...params,
  });
}

/** Convenience wrapper for payloads rejected before downstream processing. */
export function logRejectedLargePayload(params: LargePayloadBase): void {
  logLargePayload({
    action: "rejected",
    ...params,
  });
}

/** Parses an HTTP Content-Length header without accepting malformed numeric input. */
export function parseContentLengthHeader(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return parseStrictNonNegativeInteger(trimmed);
}
