import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { redactSensitiveText } from "../logging/redact.js";
import { truncateErrorDetail } from "./provider-http-errors.js";

type TransportUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type WritableTransportStream = {
  push(event: unknown): void;
  end(): void;
};

type TransportOutputShape = {
  stopReason: string;
  errorMessage?: string;
  errorCode?: string;
  errorType?: string;
  errorBody?: string;
};

const EMPTY_TOOL_RESULT_TEXT = "(no output)";
export function sanitizeTransportPayloadText(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

export function sanitizeNonEmptyTransportPayloadText(
  text: string,
  fallback = EMPTY_TOOL_RESULT_TEXT,
): string {
  const sanitized = sanitizeTransportPayloadText(text);
  return sanitized.trim().length > 0 ? sanitized : fallback;
}

export function coerceTransportToolCallArguments(argumentsValue: unknown): Record<string, unknown> {
  if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
    return argumentsValue as Record<string, unknown>;
  }
  if (typeof argumentsValue === "string") {
    try {
      const parsed = JSON.parse(argumentsValue);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve malformed strings in stored history, but send object-shaped payloads to
      // providers that require structured tool-call arguments.
    }
  }
  return {};
}

export function mergeTransportHeaders(
  ...headerSources: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeTransportMetadata<T extends Record<string, unknown>>(
  payload: T,
  metadata?: Record<string, string>,
): T {
  if (!metadata || Object.keys(metadata).length === 0) {
    return payload;
  }
  const existingMetadata =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, string>)
      : undefined;
  return {
    ...payload,
    metadata: {
      ...existingMetadata,
      ...metadata,
    },
  };
}

export function createEmptyTransportUsage(): TransportUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createWritableTransportEventStream() {
  const eventStream = createAssistantMessageEventStream();
  return {
    eventStream,
    stream: eventStream as unknown as WritableTransportStream,
  };
}

export function finalizeTransportStream(params: {
  stream: WritableTransportStream;
  output: TransportOutputShape;
  signal?: AbortSignal;
}): void {
  const { stream, output, signal } = params;
  if (signal?.aborted) {
    throw new Error("Request was aborted");
  }
  if (output.stopReason === "aborted" || output.stopReason === "error") {
    throw new Error("An unknown error occurred");
  }
  stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
  stream.end();
}

type TransportErrorDetails = {
  errorCode?: string;
  errorType?: string;
  errorBody?: string;
};

function readStringLikeProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return undefined;
}

function readObjectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function stringifyErrorBody(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function normalizeTransportErrorBody(value: unknown): string | undefined {
  const text = stringifyErrorBody(value);
  if (!text?.trim()) {
    return undefined;
  }
  return truncateErrorDetail(redactSensitiveText(text), 500);
}

export function extractTransportErrorDetails(error: unknown): TransportErrorDetails {
  const errorObject = error && typeof error === "object" ? error : undefined;
  const nestedError = readObjectProperty(errorObject, "error");
  const errorCode =
    readStringLikeProperty(errorObject, "errorCode") ??
    readStringLikeProperty(errorObject, "code") ??
    readStringLikeProperty(nestedError, "code");
  const errorType =
    readStringLikeProperty(errorObject, "errorType") ??
    readStringLikeProperty(errorObject, "type") ??
    readStringLikeProperty(nestedError, "type");
  const errorBody =
    normalizeTransportErrorBody(readStringLikeProperty(errorObject, "errorBody")) ??
    normalizeTransportErrorBody(readStringLikeProperty(errorObject, "body")) ??
    normalizeTransportErrorBody(readObjectProperty(errorObject, "body")) ??
    normalizeTransportErrorBody(nestedError);

  return {
    ...(errorCode ? { errorCode } : {}),
    ...(errorType ? { errorType } : {}),
    ...(errorBody ? { errorBody } : {}),
  };
}

export function assignTransportErrorDetails(
  output: TransportOutputShape,
  error: unknown,
  signal?: AbortSignal,
): void {
  output.stopReason = signal?.aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
  Object.assign(output, extractTransportErrorDetails(error));
}

export function failTransportStream(params: {
  stream: WritableTransportStream;
  output: TransportOutputShape;
  signal?: AbortSignal;
  error: unknown;
  cleanup?: () => void;
}): void {
  const { stream, output, signal, error, cleanup } = params;
  cleanup?.();
  assignTransportErrorDetails(output, error, signal);
  stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
  stream.end();
}
