import { vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelFetchOptions,
  type AiModelTransportEvent,
} from "../host.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
} from "../providers/openai-chatgpt-responses.js";
import { connectTestModelWebSocket } from "../providers/openai-chatgpt-responses.test-websocket.js";
import type { Context, Model } from "../types.js";

const initialHost = getAiTransportHost();

export const openAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

export const azureModel = {
  ...openAIModel,
  api: "azure-openai-responses",
  provider: "azure-openai-responses",
  baseUrl: "https://resource.openai.azure.com/openai/v1",
} satisfies Model<"azure-openai-responses">;

export const chatGptModel = {
  ...openAIModel,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.test/backend-api",
} satisfies Model<"openai-chatgpt-responses">;

export const context = {
  systemPrompt: "private prompt that must never enter transport accounting",
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
} satisfies Context;

export function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

type CompletedSseOptions = {
  eventHeaders?: Record<string, string>;
  httpModel?: string;
  model?: string;
  responseHeaders?: Record<string, string>;
};

export function completedSseEvent(responseId: string, options: CompletedSseOptions = {}) {
  return {
    type: "response.completed",
    ...(options.eventHeaders ? { headers: options.eventHeaders } : {}),
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      ...(options.model ? { model: options.model } : {}),
      ...(options.responseHeaders ? { headers: options.responseHeaders } : {}),
    },
  };
}

export function completedSseResponse(
  responseId = "resp_transport_accounting",
  options: CompletedSseOptions = {},
): Response {
  return new Response(`data: ${JSON.stringify(completedSseEvent(responseId, options))}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      ...(options.httpModel ? { "openai-model": options.httpModel } : {}),
    },
  });
}

export function truncatedSseResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_truncated",
      output_index: 0,
      content_index: 0,
      delta: "partial",
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export function stalledSseResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function abortErroredSseResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("upstream reset", "AbortError"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

export function waitForRequestAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error("expected request signal"));
      return;
    }
    const rejectAbort = () => reject(new DOMException("request aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

export function configureTransportObserver(
  events: AiModelTransportEvent[],
  buildNetworkFetch?: () => typeof fetch,
  buildAttestedFetch?: (options: AiModelFetchOptions) => typeof fetch,
): void {
  configureAiTransportHost({
    ...initialHost,
    connectModelWebSocket: connectTestModelWebSocket,
    ...(buildNetworkFetch || buildAttestedFetch
      ? {
          buildModelFetch: () => buildNetworkFetch?.(),
          buildModelFetchWithDispatchAttestation: (
            _model: Model,
            _timeoutMs: number | undefined,
            options: AiModelFetchOptions,
          ) => {
            const attestedFetch = buildAttestedFetch?.(options);
            if (attestedFetch) {
              return { fetch: attestedFetch, provenance: "dispatch_attested" as const };
            }
            const networkFetch = buildNetworkFetch?.();
            if (!networkFetch) {
              return undefined;
            }
            const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
              const dispatched = networkFetch(input, init);
              options?.onFetchInvocation?.();
              options?.onFetchDispatch?.();
              return await dispatched;
            };
            return { fetch: fetchImpl, provenance: "dispatch_attested" as const };
          },
        }
      : {}),
    observeModelTransportEvent: (event: AiModelTransportEvent) => events.push(event),
  });
}

export function configureAttestedTransportObserver(events: AiModelTransportEvent[]): void {
  configureTransportObserver(events, () => globalThis.fetch);
}

export function attemptEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "attempt" }> =>
      event.type === "attempt",
  );
}

export function invocationEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "invocation" }> =>
      event.type === "invocation",
  );
}

export function connectionEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "connection" }> =>
      event.type === "connection",
  );
}

export function fallbackEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "fallback" }> =>
      event.type === "fallback",
  );
}

export function providerFallbackEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "provider_fallback" }> =>
      event.type === "provider_fallback",
  );
}

export function coverageEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "coverage" }> =>
      event.type === "coverage",
  );
}

export function submissionEvents(events: AiModelTransportEvent[]) {
  return events.filter(
    (event): event is Extract<AiModelTransportEvent, { type: "submission" }> =>
      event.type === "submission",
  );
}

export function resetOpenAITransportAccountingTestState(): void {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(initialHost);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
