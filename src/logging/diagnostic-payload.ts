import { emitInternalDiagnosticEvent as emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";

type LargePayloadBase = {
  surface: string;
  bytes?: number;
  limitBytes?: number;
  count?: number;
  channel?: string;
  pluginId?: string;
  reason?: string;
};

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

export function logRejectedLargePayload(params: LargePayloadBase): void {
  logLargePayload({
    action: "rejected",
    ...params,
  });
}

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
