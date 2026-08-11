import { asOptionalRecord, stableStringify } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { projectDiagnosticValue, redactDiagnosticText } from "./credential-redaction.js";

const MAX_ERROR_BODY_LENGTH = 4000;

export type ProviderErrorProjection = {
  stopReason: "aborted" | "error";
  errorMessage: string;
  errorCode?: string;
  errorType?: string;
  errorBody?: string;
};

export type ProviderErrorRedactor = (value: unknown) => unknown;
let providerErrorRedactor: ProviderErrorRedactor | undefined;
export function configureProviderErrorRedactor(redactor: ProviderErrorRedactor | undefined) {
  const previous = providerErrorRedactor;
  providerErrorRedactor = redactor;
  return previous;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function readCauseCode(error: Record<string, unknown>): string | undefined {
  const seen = new Set<Record<string, unknown>>();
  for (
    let cause = asOptionalRecord(error.cause);
    cause && seen.size < 8 && !seen.has(cause);
    cause = asOptionalRecord(cause.cause)
  ) {
    seen.add(cause);
    const code = readString(cause, "code");
    if (code) {
      return code;
    }
  }
  return undefined;
}

function stringifyField(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = redactDiagnosticText(
    (typeof value === "string" ? value : stableStringify(value)).trim(),
  );
  if (!text) {
    return undefined;
  }
  return text.length <= maxLength ? text : `${truncateUtf16Safe(text, maxLength)}... [truncated]`;
}

function buildProjection(snapshot: unknown, signal?: AbortSignal): ProviderErrorProjection {
  const error = asOptionalRecord(snapshot);
  const nestedError = asOptionalRecord(error?.error);
  const response = asOptionalRecord(error?.response);
  const status = [error?.status, error?.statusCode, response?.status, response?.statusCode].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  const bodyValue =
    error?.errorBody ?? error?.body ?? response?.body ?? response?.data ?? nestedError;
  const body = stringifyField(bodyValue, MAX_ERROR_BODY_LENGTH);
  const originalMessage =
    (typeof snapshot === "string" ? snapshot : undefined) ??
    readString(error, "message") ??
    readString(nestedError, "message");
  const genericMessage = originalMessage === `${status} status code (no body)`;
  let errorMessage =
    status !== undefined && body && (!originalMessage || genericMessage)
      ? `${status}: ${body}`
      : (originalMessage ??
        body ??
        stringifyField(snapshot, MAX_ERROR_BODY_LENGTH) ??
        "Unknown provider error");
  if (
    status !== undefined &&
    !body &&
    originalMessage &&
    !originalMessage.startsWith(String(status))
  ) {
    errorMessage = `${status}: ${errorMessage}`;
  }
  const metadata = asOptionalRecord(nestedError?.metadata);
  const rawMetadata = stringifyField(metadata?.raw, MAX_ERROR_BODY_LENGTH);
  if (rawMetadata && !errorMessage.includes(rawMetadata)) {
    errorMessage += `\n${rawMetadata}`;
  }
  const errorCode =
    readString(error, "errorCode") ??
    readString(error, "code") ??
    readString(nestedError, "code") ??
    (error ? readCauseCode(error) : undefined) ??
    (status === undefined ? undefined : String(status));
  const errorType =
    readString(error, "errorType") ?? readString(error, "type") ?? readString(nestedError, "type");
  return {
    stopReason: signal?.aborted ? "aborted" : "error",
    errorMessage: stringifyField(errorMessage, 4096) ?? "Unknown provider error",
    ...(errorCode ? { errorCode: truncateUtf16Safe(errorCode, 256) } : {}),
    ...(errorType ? { errorType: truncateUtf16Safe(errorType, 256) } : {}),
    ...(body ? { errorBody: stringifyField(bodyValue, 500) } : {}),
  };
}

/** Projects one hostile provider throw into final, bounded assistant terminal fields. */
export function projectProviderError(
  error: unknown,
  signal?: AbortSignal,
): ProviderErrorProjection {
  try {
    const localSnapshot = projectDiagnosticValue(error);
    let snapshot = localSnapshot;
    try {
      snapshot = providerErrorRedactor?.(localSnapshot) ?? localSnapshot;
    } catch {
      // Package projection is independently safe when embedding-host strengthening fails.
    }
    return buildProjection(snapshot, signal);
  } catch {
    return {
      stopReason: signal?.aborted ? "aborted" : "error",
      errorMessage: "Unknown provider error",
    };
  }
}
