/**
 * Shared transport-stream normalization helpers.
 *
 * Sanitizes provider payloads, merges metadata, and formats streamed assistant events.
 */
import type { AssistantMessage, Usage } from "@openclaw/llm-core";
import { asNonArrayRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { projectProviderError, type ProviderErrorProjection } from "../utils/provider-error.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

type ContextUsage = NonNullable<Usage["contextUsage"]>;

type TransportUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextUsage?: ContextUsage;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type WritableTransportStream = Pick<
  ReturnType<typeof createAssistantMessageEventStream>,
  "push" | "end"
>;

const EMPTY_TOOL_RESULT_TEXT = "(no output)";
export function sanitizeTransportPayloadText(text: string): string {
  if (typeof text !== "string") {
    return "";
  }
  return sanitizeSurrogates(text);
}

export function sanitizeNonEmptyTransportPayloadText(
  text: string,
  fallback = EMPTY_TOOL_RESULT_TEXT,
): string {
  const sanitized = sanitizeTransportPayloadText(text);
  return sanitized.trim().length > 0 ? sanitized : fallback;
}

export function coerceTransportToolCallArguments(argumentsValue: unknown): Record<string, unknown> {
  const argumentsRecord = asOptionalRecord(argumentsValue);
  if (argumentsRecord) {
    return argumentsRecord;
  }
  if (typeof argumentsValue === "string") {
    try {
      return asNonArrayRecord(JSON.parse(argumentsValue));
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
  const existingMetadata = asOptionalRecord(payload.metadata) as Record<string, string> | undefined;
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
    stream: eventStream,
  };
}

/**
 * Abort error to surface for an aborted `signal`.
 *
 * Rethrows the caller's abort reason only when it carries a `code`, so that code
 * survives into `errorCode` on the persisted assistant message and consumers can
 * recognize an abort's origin without matching error text. A default
 * `abort()` reason is an uncoded DOMException that carries nothing the synthetic
 * error does not, so it keeps the "Request was aborted" text every transport
 * already emits rather than churning it.
 */
export function transportAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error && typeof (reason as { code?: unknown }).code === "string"
    ? reason
    : new Error("Request was aborted");
}

/** Run a provider-response hook before start/body consumption inside the first-event deadline. */
export function withProviderResponseHook<T = never>(params: {
  stream?: AsyncIterable<T>;
  signal: AbortSignal;
  abort: (reason: Error) => void;
  hook?: () => void | Promise<void>;
  onReady?: () => void;
}): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      let onAbort: (() => void) | undefined;
      try {
        if (params.signal.aborted) {
          throw transportAbortError(params.signal);
        }
        if (params.hook) {
          await Promise.race([
            Promise.resolve().then(params.hook),
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(transportAbortError(params.signal));
              params.signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
        }
      } catch (error) {
        params.abort(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        if (onAbort) {
          params.signal.removeEventListener("abort", onAbort);
        }
      }
      if (params.signal.aborted) {
        throw transportAbortError(params.signal);
      }
      params.onReady?.();
      if (params.stream) {
        yield* params.stream;
      }
    },
  };
}

export function finalizeTransportStream(params: {
  stream: WritableTransportStream;
  output: AssistantMessage;
  signal?: AbortSignal;
}): void {
  const { stream, output, signal } = params;
  if (signal?.aborted) {
    throw transportAbortError(signal);
  }
  if (output.stopReason === "aborted" || output.stopReason === "error") {
    throw new Error(output.errorMessage ?? "An unknown error occurred");
  }
  stream.push({ type: "done", reason: output.stopReason, message: output });
  stream.end();
}

/** @deprecated Use projectProviderError. v2026.7.2-beta.5 compatibility; remove after 2026.10. */
export function assignTransportErrorDetails(
  output: AssistantMessage,
  error: unknown,
  signal?: AbortSignal,
): ProviderErrorProjection {
  const projection = projectProviderError(error, signal);
  Object.assign(output, projection);
  return projection;
}

export function failTransportStream(params: {
  stream: WritableTransportStream;
  output: AssistantMessage;
  signal?: AbortSignal;
  error: unknown;
  cleanup?: () => void;
}): void {
  const { stream, output, signal, error, cleanup } = params;
  cleanup?.();
  const projection = assignTransportErrorDetails(output, error, signal);
  stream.push({ type: "error", reason: projection.stopReason, error: output });
  stream.end();
}
