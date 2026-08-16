/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

import {
  createSseByteGuard,
  parseStreamingJson,
  type SseByteGuard,
} from "@openclaw/ai/internal/runtime";
import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { readResponseWithLimit } from "../../infra/http-body.js";
// Internal import for JSON parsing utility
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  ToolCall,
} from "../../llm/types.js";
import { EventStream } from "../../llm/utils/event-stream.js";

const PROXY_ERROR_BODY_MAX_BYTES = 16 * 1024 * 1024;
const PROXY_SSE_STREAM_MAX_BYTES = 16 * 1024 * 1024;
const PROXY_SSE_PENDING_BUFFER_MAX_BYTES = PROXY_SSE_STREAM_MAX_BYTES;
const PROXY_SSE_READ_IDLE_TIMEOUT_MS = 120_000;

type StreamingToolCall = ToolCall & { partialJson?: string };

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        }
        if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type");
      },
    );
  }
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number; contentSignature?: string }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      usage: AssistantMessage["usage"];
    }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      errorMessage?: string;
      usage: AssistantMessage["usage"];
    };

type ProxySerializableStreamOptions = Pick<
  SimpleStreamOptions,
  | "temperature"
  | "maxTokens"
  | "reasoning"
  | "cacheRetention"
  | "sessionId"
  | "promptCacheKey"
  | "metadata"
  | "transport"
  | "thinkingBudgets"
  | "maxRetryDelayMs"
  | "timeoutMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
  /** Local abort signal for the proxy request */
  signal?: AbortSignal;
  /** Auth token for the proxy server */
  authToken: string;
  /** Proxy server URL (e.g., "https://genai.example.com") */
  proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
  return {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    reasoning: options.reasoning,
    cacheRetention: options.cacheRetention,
    sessionId: options.sessionId,
    promptCacheKey: options.promptCacheKey,
    metadata: options.metadata,
    transport: options.transport,
    thinkingBudgets: options.thinkingBudgets,
    maxRetryDelayMs: options.maxRetryDelayMs,
    timeoutMs: options.timeoutMs,
  };
}

function sanitizeProxyModel(model: Model): Model {
  const { headers: _headers, ...safeModel } = model;
  return safeModel as Model;
}

function resolveProxyReadIdleTimeoutMs(timeoutMs: ProxyStreamOptions["timeoutMs"]): number {
  return resolvePositiveTimerTimeoutMs(timeoutMs, PROXY_SSE_READ_IDLE_TIMEOUT_MS);
}

type ProxyRequestAbort = {
  signal: AbortSignal;
  clear: () => void;
};

function createProxyRequestTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Proxy request timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function buildProxyRequestAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): ProxyRequestAbort {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(createProxyRequestTimeoutError(timeoutMs));
  }, timeoutMs);
  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal,
    clear: () => {
      clearTimeout(timeoutId);
    },
  };
}

function isProxyRequestTimeoutError(params: {
  error: unknown;
  callerSignal: AbortSignal | undefined;
  requestSignal: AbortSignal;
}): boolean {
  if (params.callerSignal?.aborted || !params.requestSignal.aborted) {
    return false;
  }
  if (!(params.error instanceof Error)) {
    return false;
  }
  return (
    params.error.name === "AbortError" ||
    params.error.name === "TimeoutError" ||
    params.error.message === "Request was aborted"
  );
}

async function readProxyErrorData(
  response: Response,
  readIdleTimeoutMs: number,
): Promise<{ error?: string } | undefined> {
  const bytes = await readResponseWithLimit(response, PROXY_ERROR_BODY_MAX_BYTES, {
    onOverflow: ({ maxBytes }) => new Error(`Proxy error body exceeded ${maxBytes} bytes`),
    chunkTimeoutMs: readIdleTimeoutMs,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Proxy error body stalled: no data received for ${chunkTimeoutMs}ms`),
  });
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { error?: string };
}

async function readProxySseChunk(
  reader: Pick<SseByteGuard, "read" | "cancel">,
  readIdleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  return await new Promise((resolve, reject) => {
    const timeoutError = new Error(
      `Proxy SSE stream stalled: no data received for ${readIdleTimeoutMs}ms`,
    );
    timeoutId = setTimeout(() => {
      timedOut = true;
      void reader.cancel(timeoutError);
      reject(timeoutError);
    }, readIdleTimeoutMs);
    void reader.read().then(
      (result) => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        if (!timedOut) {
          resolve(result);
        }
      },
      (error: unknown) => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        if (!timedOut) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}

function assertProxySsePendingBufferWithinLimit(
  buffer: string,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  const size = new TextEncoder().encode(buffer).byteLength;
  if (size <= PROXY_SSE_PENDING_BUFFER_MAX_BYTES) {
    return;
  }
  const error = new Error(
    `Proxy SSE pending buffer exceeded ${PROXY_SSE_PENDING_BUFFER_MAX_BYTES} bytes`,
  );
  void reader.cancel(error).catch(() => undefined);
  throw error;
}

export function streamProxy(
  model: Model,
  context: Context,
  options: ProxyStreamOptions,
): ProxyMessageEventStream {
  const stream = new ProxyMessageEventStream();

  void (async () => {
    // Initialize the partial message that we'll build up from events
    const partial: AssistantMessage = {
      role: "assistant",
      stopReason: "stop",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const readIdleTimeoutMs = resolveProxyReadIdleTimeoutMs(options.timeoutMs);

    const abortHandler = () => {
      if (reader) {
        reader.cancel("Request aborted by user").catch(() => {});
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler);
    }

    try {
      const requestAbort = buildProxyRequestAbort(options.signal, readIdleTimeoutMs);
      const response = await fetch(`${options.proxyUrl}/api/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: sanitizeProxyModel(model),
          context,
          options: buildProxyRequestOptions(options),
        }),
        signal: requestAbort.signal,
      })
        .catch((error: unknown) => {
          if (
            isProxyRequestTimeoutError({
              error,
              callerSignal: options.signal,
              requestSignal: requestAbort.signal,
            })
          ) {
            throw new Error(`Proxy request timed out after ${readIdleTimeoutMs}ms`, {
              cause: error instanceof Error ? error : undefined,
            });
          }
          throw error;
        })
        .finally(() => {
          requestAbort.clear();
        });

      if (!response.ok) {
        let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
        try {
          const errorData = await readProxyErrorData(response, readIdleTimeoutMs);
          if (errorData?.error) {
            errorMessage = `Proxy error: ${errorData.error}`;
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Proxy error body")) {
            throw error;
          }
        }
        throw new Error(errorMessage);
      }

      reader = response.body!.getReader();
      const sseReader = createSseByteGuard(reader, {
        maxBytes: PROXY_SSE_STREAM_MAX_BYTES,
        onOverflow: ({ maxBytes }) => new Error(`Proxy SSE stream exceeded ${maxBytes} bytes`),
      });
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalEventSeen = false;

      const processSseLine = (line: string) => {
        if (!line.startsWith("data: ")) {
          return;
        }
        const data = line.slice(6).trim();
        if (!data) {
          return;
        }
        const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
        const event = processProxyEvent(proxyEvent, partial);
        if (!event) {
          return;
        }
        terminalEventSeen = event.type === "done" || event.type === "error";
        stream.push(event);
      };

      while (true) {
        const { done, value } = await readProxySseChunk(sseReader, readIdleTimeoutMs);
        if (done) {
          break;
        }

        if (options.signal?.aborted) {
          throw new Error("Request aborted by user");
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        assertProxySsePendingBufferWithinLimit(buffer, reader);

        for (const line of lines) {
          processSseLine(line);
        }
      }

      if (options.signal?.aborted) {
        throw new Error("Request aborted by user");
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        processSseLine(buffer);
      }
      if (!terminalEventSeen) {
        throw new Error("Proxy stream ended before terminal event");
      }

      stream.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const reason = options.signal?.aborted ? "aborted" : "error";
      partial.stopReason = reason;
      partial.errorMessage = errorMessage;
      stream.push({
        type: "error",
        reason,
        error: partial,
      });
      stream.end();
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        // Stream handling above already pushed the terminal proxy event;
        // cleanup failures must not replace it with a secondary release error.
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  })();

  return stream;
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
  proxyEvent: ProxyAssistantMessageEvent,
  partial: AssistantMessage,
): AssistantMessageEvent | undefined {
  switch (proxyEvent.type) {
    case "start":
      return { type: "start", partial };

    case "text_start":
      partial.content[proxyEvent.contentIndex] = {
        type: "text",
        text: "",
        ...(proxyEvent.contentSignature !== undefined
          ? { textSignature: proxyEvent.contentSignature }
          : {}),
      };
      return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

    case "text_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "text") {
        content.text += proxyEvent.delta;
        return {
          type: "text_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial,
        };
      }
      throw new Error("Received text_delta for non-text content");
    }

    case "text_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "text") {
        if (proxyEvent.contentSignature !== undefined) {
          content.textSignature = proxyEvent.contentSignature;
        }
        return {
          type: "text_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.text,
          partial,
        };
      }
      throw new Error("Received text_end for non-text content");
    }

    case "thinking_start":
      partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

    case "thinking_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "thinking") {
        content.thinking += proxyEvent.delta;
        return {
          type: "thinking_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial,
        };
      }
      throw new Error("Received thinking_delta for non-thinking content");
    }

    case "thinking_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "thinking") {
        content.thinkingSignature = proxyEvent.contentSignature;
        return {
          type: "thinking_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.thinking,
          partial,
        };
      }
      throw new Error("Received thinking_end for non-thinking content");
    }

    case "toolcall_start":
      partial.content[proxyEvent.contentIndex] = {
        type: "toolCall",
        id: proxyEvent.id,
        name: proxyEvent.toolName,
        arguments: {},
        partialJson: "",
      } satisfies ToolCall & { partialJson: string } as ToolCall;
      return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

    case "toolcall_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "toolCall") {
        const streamingContent = content as StreamingToolCall;
        streamingContent.partialJson = `${streamingContent.partialJson ?? ""}${proxyEvent.delta}`;
        content.arguments = parseStreamingJson(streamingContent.partialJson) || {};
        partial.content[proxyEvent.contentIndex] = { ...content }; // Trigger reactivity
        return {
          type: "toolcall_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial,
        };
      }
      throw new Error("Received toolcall_delta for non-toolCall content");
    }

    case "toolcall_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "toolCall") {
        delete (content as StreamingToolCall).partialJson;
        return {
          type: "toolcall_end",
          contentIndex: proxyEvent.contentIndex,
          toolCall: content,
          partial,
        };
      }
      return undefined;
    }

    case "done":
      partial.stopReason = proxyEvent.reason;
      partial.usage = proxyEvent.usage;
      return { type: "done", reason: proxyEvent.reason, message: partial };

    case "error":
      partial.stopReason = proxyEvent.reason;
      partial.errorMessage = proxyEvent.errorMessage;
      partial.usage = proxyEvent.usage;
      return { type: "error", reason: proxyEvent.reason, error: partial };

    default: {
      proxyEvent satisfies never;
      console.warn(`Unhandled proxy event type: ${(proxyEvent as { type?: string }).type}`);
      return undefined;
    }
  }
}
