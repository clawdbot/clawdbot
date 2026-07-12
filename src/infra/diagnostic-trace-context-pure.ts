import { expectDefined } from "@openclaw/normalization-core";

export const TRACEPARENT_VERSION = "00";
const MAX_TRACEPARENT_LENGTH = 128;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const TRACEPARENT_VERSION_RE = /^[0-9a-f]{2}$/;
export const DIAGNOSTIC_TRACEPARENT_PATTERN = "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$";
const DIAGNOSTIC_TRACEPARENT_RE = new RegExp(DIAGNOSTIC_TRACEPARENT_PATTERN);

export type DiagnosticTraceContext = {
  /** W3C trace id, 32 lowercase hex chars. */
  readonly traceId: string;
  /** Current span id, 16 lowercase hex chars. */
  readonly spanId?: string;
  /** Parent span id, 16 lowercase hex chars. */
  readonly parentSpanId?: string;
  /** W3C trace flags, 2 lowercase hex chars. Defaults to sampled. */
  readonly traceFlags?: string;
  /** Marks a current span id parsed from a remote W3C traceparent. */
  readonly spanIdSource?: "remote";
  /** Marks a parent span id inherited from a remote W3C traceparent. */
  readonly parentSpanIdSource?: "remote";
};

function isNonZeroHex(value: string): boolean {
  return !/^0+$/.test(value);
}

export function isValidDiagnosticTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_RE.test(value) && isNonZeroHex(value);
}

export function isValidDiagnosticSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_RE.test(value) && isNonZeroHex(value);
}

export function isValidDiagnosticTraceFlags(value: unknown): value is string {
  return typeof value === "string" && TRACE_FLAGS_RE.test(value);
}

export function normalizeTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValidDiagnosticTraceId(normalized) ? normalized : undefined;
}

export function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValidDiagnosticSpanId(normalized) ? normalized : undefined;
}

export function normalizeTraceFlags(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return isValidDiagnosticTraceFlags(normalized) ? normalized : undefined;
}

export function parseDiagnosticTraceparent(
  traceparent: string | undefined,
): DiagnosticTraceContext | undefined {
  if (typeof traceparent !== "string" || traceparent.length > MAX_TRACEPARENT_LENGTH) {
    return undefined;
  }
  const parts = traceparent.trim().toLowerCase().split("-");
  if (!parts || parts.length < 4) {
    return undefined;
  }
  const [version, traceId, spanId, traceFlags] = parts;
  if (
    !TRACEPARENT_VERSION_RE.test(expectDefined(version, "diagnostic trace context version")) ||
    version === "ff" ||
    (version === TRACEPARENT_VERSION && parts.length !== 4)
  ) {
    return undefined;
  }
  const normalizedTraceId = normalizeTraceId(traceId);
  const normalizedSpanId = normalizeSpanId(spanId);
  const normalizedTraceFlags = normalizeTraceFlags(traceFlags);
  if (!normalizedTraceId || !normalizedSpanId || !normalizedTraceFlags) {
    return undefined;
  }
  return {
    traceId: normalizedTraceId,
    spanId: normalizedSpanId,
    traceFlags: normalizedTraceFlags,
  };
}

export function normalizeDiagnosticTraceparent(
  traceparent: string | undefined,
): string | undefined {
  if (typeof traceparent !== "string") {
    return undefined;
  }
  const normalized = traceparent.trim().toLowerCase();
  if (!DIAGNOSTIC_TRACEPARENT_RE.test(normalized)) {
    return undefined;
  }
  return parseDiagnosticTraceparent(normalized) ? normalized : undefined;
}
