// Extracts provider diagnostic metadata from error objects and text.
import { sha256HexPrefix } from "./crypto-digest.js";

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const REQUEST_ID_HASH_PREFIX_LEN = 12;
const PROVIDER_REQUEST_ID_KEYS = [
  "upstreamRequestId",
  "providerRequestId",
  "requestId",
  "request_id",
] as const;
const PROVIDER_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const PROVIDER_REQUEST_ID_TEXT_PATTERNS = [
  /\b(?:x-request-id|request-id|request_id|requestId|trace-id|trace_id)\b["'\s:=([]+([A-Za-z0-9._:-]{1,128})/i,
  /\((?:request_id|trace_id)\s*:\s*([A-Za-z0-9._:-]{1,128})\)/i,
] as const;

type DiagnosticErrorFailureKind =
  | "aborted"
  | "connection_closed"
  | "connection_reset"
  | "terminated"
  | "timeout";

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  try {
    // Read only own data properties; diagnostic extraction must not trigger userland getters.
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function findDiagnosticErrorProperty<T>(
  err: unknown,
  reader: (candidate: unknown) => T | undefined,
  seen: Set<object> = new Set(),
): T | undefined {
  const direct = reader(err);
  if (direct !== undefined) {
    return direct;
  }
  if (!isObjectLike(err) || seen.has(err)) {
    return undefined;
  }
  seen.add(err);
  return (
    findDiagnosticErrorProperty(readOwnDataProperty(err, "error"), reader, seen) ??
    findDiagnosticErrorProperty(readOwnDataProperty(err, "cause"), reader, seen)
  );
}

function isHttpStatusCode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= HTTP_STATUS_MIN &&
    value <= HTTP_STATUS_MAX
  );
}

function normalizeProviderRequestId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return PROVIDER_REQUEST_ID_RE.test(trimmed) ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = String(value);
    return PROVIDER_REQUEST_ID_RE.test(normalized) ? normalized : undefined;
  }
  if (typeof value === "bigint") {
    const normalized = String(value);
    return PROVIDER_REQUEST_ID_RE.test(normalized) ? normalized : undefined;
  }
  return undefined;
}

function hashDiagnosticIdentifier(value: string): string {
  return `sha256:${sha256HexPrefix(value, REQUEST_ID_HASH_PREFIX_LEN)}`;
}

function readDirectProviderRequestId(err: unknown): string | undefined {
  for (const key of PROVIDER_REQUEST_ID_KEYS) {
    const normalized = normalizeProviderRequestId(readOwnDataProperty(err, key));
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readDirectMessage(err: unknown): string | undefined {
  if (typeof err === "string") {
    return err;
  }
  const message = readOwnDataProperty(err, "message");
  return typeof message === "string" ? message : undefined;
}

function readDirectCode(err: unknown): string | undefined {
  const code = readOwnDataProperty(err, "code");
  return typeof code === "string" ? code : undefined;
}

function extractProviderRequestIdFromText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  for (const pattern of PROVIDER_REQUEST_ID_TEXT_PATTERNS) {
    const normalized = normalizeProviderRequestId(text.match(pattern)?.[1]);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

/** Returns a low-cardinality error category without trusting mutable `Error.name`. */
export function diagnosticErrorCategory(err: unknown): string {
  try {
    if (err instanceof TypeError) {
      return "TypeError";
    }
    if (err instanceof RangeError) {
      return "RangeError";
    }
    if (err instanceof ReferenceError) {
      return "ReferenceError";
    }
    if (err instanceof SyntaxError) {
      return "SyntaxError";
    }
    if (err instanceof URIError) {
      return "URIError";
    }
    if (typeof AggregateError !== "undefined" && err instanceof AggregateError) {
      return "AggregateError";
    }
    if (err instanceof Error) {
      return "Error";
    }
  } catch {
    return "unknown";
  }
  if (err === null) {
    return "null";
  }
  return typeof err;
}

/**
 * Human-readable error message for diagnostics. Complements
 * {@link diagnosticErrorCategory} (low-cardinality class name) with the actual
 * message so error spans carry a real status message instead of a bare
 * category. Reads only an own data property so diagnostics never invoke a
 * user-defined getter.
 */
export function diagnosticErrorMessage(err: unknown): string | undefined {
  const text = readDirectMessage(err);
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/** Extracts a safe HTTP status code from own `status` or `statusCode` data properties. */
export function diagnosticHttpStatusCode(err: unknown): string | undefined {
  const status = readOwnDataProperty(err, "status");
  if (isHttpStatusCode(status)) {
    return String(status);
  }
  const statusCode = readOwnDataProperty(err, "statusCode");
  if (isHttpStatusCode(statusCode)) {
    return String(statusCode);
  }
  return undefined;
}

/** Classifies transport-style failures without exposing raw error messages. */
export function diagnosticErrorFailureKind(err: unknown): DiagnosticErrorFailureKind | undefined {
  const code = findDiagnosticErrorProperty(err, readDirectCode)?.trim().toUpperCase();
  switch (code) {
    case undefined:
      break;
    case "ABORT_ERR":
    case "ECONNABORTED":
    case "ERR_ABORTED":
      return "aborted";
    case "ECONNRESET":
      return "connection_reset";
    case "ERR_STREAM_PREMATURE_CLOSE":
    case "UND_ERR_SOCKET":
      return "connection_closed";
    case "ETIMEDOUT":
    case "ERR_SOCKET_CONNECTION_TIMEOUT":
      return "timeout";
  }

  const message = findDiagnosticErrorProperty(err, readDirectMessage);
  if (!message) {
    return undefined;
  }
  if (/\b(?:terminated|sigkill|sigterm)\b/i.test(message)) {
    return "terminated";
  }
  if (/\b(?:econnreset|connection reset)\b/i.test(message)) {
    return "connection_reset";
  }
  if (/\b(?:socket hang up|premature close|connection closed|other side closed)\b/i.test(message)) {
    return "connection_closed";
  }
  if (/\b(?:timed out|timeout|etimedout)\b/i.test(message)) {
    return "timeout";
  }
  if (/\b(?:aborted|abort_err|operation was aborted)\b/i.test(message)) {
    return "aborted";
  }
  return undefined;
}

/** Extracts and hashes bounded provider request ids so diagnostics never expose raw ids. */
export function diagnosticProviderRequestIdHash(err: unknown): string | undefined {
  const fromProperty = findDiagnosticErrorProperty(err, readDirectProviderRequestId);
  if (fromProperty) {
    return hashDiagnosticIdentifier(fromProperty);
  }
  const fromMessage = findDiagnosticErrorProperty(err, (candidate) =>
    extractProviderRequestIdFromText(readDirectMessage(candidate)),
  );
  return fromMessage ? hashDiagnosticIdentifier(fromMessage) : undefined;
}
