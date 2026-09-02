/**
 * Shared transport-stream normalization helpers.
 *
 * Sanitizes provider payloads, merges metadata, and formats streamed assistant events.
 */
import type {
  AssistantMessage,
  Model,
  ProviderResponse,
  StreamOptions,
  Usage,
} from "@openclaw/llm-core";
import { asNonArrayRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  projectDiagnosticValue,
} from "../utils/diagnostics.js";
import { createAssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { projectProviderError, type ProviderErrorProjection } from "../utils/provider-error.js";
import { isTransientNetworkError } from "../utils/retryable-network-errors.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";

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
const MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE =
  "Provider completed tool call with malformed JSON arguments";
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

/** Admit only complete object-shaped terminal tool arguments; partial parsing is preview-only. */
export function parseTerminalToolCallArguments(
  value: unknown,
  errorMessage = MALFORMED_TOOL_CALL_TERMINAL_ERROR_MESSAGE,
): Record<string, unknown> {
  const parsed = parseJsonObjectPreservingUnsafeIntegers(value);
  if (!parsed) {
    throw new Error(errorMessage);
  }
  return parsed;
}

/** Validate a complete sibling set before mutating any call into executable state. */
export function finalizeTerminalToolCallArguments<T extends { arguments: Record<string, unknown> }>(
  calls: readonly T[],
  readArguments: (call: T) => unknown,
  errorMessage?: string,
): void {
  const validated = calls.map(
    (call) => [call, parseTerminalToolCallArguments(readArguments(call), errorMessage)] as const,
  );
  for (const [call, argumentsValue] of validated) {
    call.arguments = argumentsValue;
  }
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

export type ProviderAcceptance =
  | {
      kind: "http_response";
      status: number;
      headers: Record<string, string>;
    }
  | { kind: "provider_stream_opened" };

type ProviderAcceptanceObserver = (acceptance: ProviderAcceptance) => void;
type ProviderAcceptanceOptions = Pick<StreamOptions, "onResponse" | "signal">;
type ProviderStreamCancel = (reason: Error) => void | Promise<void>;

const providerAcceptanceObserver: unique symbol = Symbol("openclaw.providerAcceptanceObserver");

function readProviderAcceptanceObserver(options: unknown): ProviderAcceptanceObserver | undefined {
  if (options === null || typeof options !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, providerAcceptanceObserver);
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return isProviderAcceptanceObserver(value) ? value : undefined;
}

function isProviderAcceptanceObserver(value: unknown): value is ProviderAcceptanceObserver {
  return typeof value === "function";
}

function writeProviderAcceptanceObserver<T extends object>(
  options: T,
  observer: ProviderAcceptanceObserver,
): T {
  // Keep this enumerable so normal option spreads preserve the private per-call observer.
  Object.defineProperty(options, providerAcceptanceObserver, {
    configurable: true,
    enumerable: true,
    value: observer,
  });
  return options;
}

/** Attach an OpenClaw-internal provider acceptance observer to one model call. */
export function withProviderAcceptanceObserver<T extends object>(
  options: T,
  observer: ProviderAcceptanceObserver,
): T {
  const existing = readProviderAcceptanceObserver(options);
  return writeProviderAcceptanceObserver(
    options,
    existing
      ? (acceptance) => {
          observer(acceptance);
          existing(acceptance);
        }
      : observer,
  );
}

/** Preserve the private provider acceptance observer when a built-in wrapper rebuilds options. */
export function copyProviderAcceptanceObserver<T extends object>(source: unknown, target: T): T {
  const observer = readProviderAcceptanceObserver(source);
  return observer ? writeProviderAcceptanceObserver(target, observer) : target;
}

async function awaitProviderLifecycleCallback(
  callback: (() => void | Promise<void>) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw transportAbortError(signal);
  }
  if (!callback) {
    return;
  }
  const callbackPromise = Promise.resolve().then(callback);
  if (!signal) {
    await callbackPromise;
    return;
  }
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      callbackPromise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(transportAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
  if (signal.aborted) {
    throw transportAbortError(signal);
  }
}

function startProviderStreamCancellation(cancelStream: ProviderStreamCancel, error: unknown): void {
  const reason = error instanceof Error ? error : new Error(String(error));
  try {
    // The lifecycle failure remains authoritative. Cleanup must not delay or replace it.
    void Promise.resolve(cancelStream(reason)).catch(() => undefined);
  } catch {
    // A synchronous cleanup failure cannot replace the lifecycle failure either.
  }
}

async function awaitProviderLifecycleWithCleanup(params: {
  run: () => Promise<void>;
  cancelStream: ProviderStreamCancel;
}): Promise<void> {
  try {
    await params.run();
  } catch (error) {
    startProviderStreamCancellation(params.cancelStream, error);
    throw error;
  }
}

/** Report observed HTTP metadata; rejected responses use only onResponse. */
export async function notifyProviderHttpMetadata(params: {
  options?: ProviderAcceptanceOptions;
  response: ProviderResponse;
  model: Model;
  cancelStream: ProviderStreamCancel;
  signal?: AbortSignal;
}): Promise<void> {
  const observer = readProviderAcceptanceObserver(params.options);
  if (!observer && !params.options?.onResponse) {
    return;
  }
  const { status, headers } = params.response;
  const signal = params.signal ?? params.options?.signal;
  const accepted = status >= 200 && status < 300;
  await awaitProviderLifecycleWithCleanup({
    cancelStream: params.cancelStream,
    run: async () => {
      await awaitProviderLifecycleCallback(
        accepted && observer
          ? () => observer({ kind: "http_response", status, headers })
          : undefined,
        signal,
      );
      await awaitProviderLifecycleCallback(
        params.options?.onResponse
          ? () => params.options?.onResponse?.({ status, headers }, params.model)
          : undefined,
        signal,
      );
    },
  });
}

/** Report a real HTTP response before body consumption. */
export async function notifyProviderHttpResponse(params: {
  options?: ProviderAcceptanceOptions;
  response: Response;
  model: Model;
  cancelStream?: ProviderStreamCancel;
  signal?: AbortSignal;
}): Promise<void> {
  await notifyProviderHttpMetadata({
    options: params.options,
    response: {
      status: params.response.status,
      headers: headersToRecord(params.response.headers),
    },
    model: params.model,
    signal: params.signal,
    cancelStream: (reason) => {
      if (params.cancelStream) {
        startProviderStreamCancellation(params.cancelStream, reason);
      }
      return params.response.body?.cancel(reason);
    },
  });
}

/** Report an accepted SDK stream when the SDK does not expose HTTP metadata. */
export async function notifyProviderStreamOpened(params: {
  options?: Pick<StreamOptions, "signal">;
  cancelStream: ProviderStreamCancel;
  signal?: AbortSignal;
}): Promise<void> {
  const observer = readProviderAcceptanceObserver(params.options);
  if (!observer) {
    return;
  }
  await awaitProviderLifecycleWithCleanup({
    cancelStream: params.cancelStream,
    run: () =>
      awaitProviderLifecycleCallback(
        () => observer({ kind: "provider_stream_opened" }),
        params.signal ?? params.options?.signal,
      ),
  });
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
      try {
        await awaitProviderLifecycleCallback(params.hook, params.signal);
      } catch (error) {
        params.abort(error instanceof Error ? error : new Error(String(error)));
        throw error;
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

/** Assign terminal fields and record silent transport failures before partial-call cleanup. */
export function assignTransportErrorDetails(
  output: AssistantMessage,
  error: unknown,
  signal?: AbortSignal,
): ProviderErrorProjection {
  const projection = projectProviderError(error, signal);
  Object.assign(output, projection);
  if (
    projection.stopReason === "error" &&
    output.content.length === 0 &&
    isTransientNetworkError(projectDiagnosticValue(error)) &&
    !output.diagnostics?.some((diagnostic) => diagnostic.type === "provider_transport_failure")
  ) {
    // Recovery consumes this fact, not error-text guesses. Reuse the bounded,
    // redacted terminal message so diagnostics cannot expose the original throw.
    appendAssistantMessageDiagnostic(
      output,
      createAssistantMessageDiagnostic("provider_transport_failure", projection.errorMessage, {
        eventsEmitted: false,
        phase: "before_message_stream_start",
      }),
    );
  }
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
  const projection = assignTransportErrorDetails(output, error, signal);
  cleanup?.();
  stream.push({ type: "error", reason: projection.stopReason, error: output });
  stream.end();
}
