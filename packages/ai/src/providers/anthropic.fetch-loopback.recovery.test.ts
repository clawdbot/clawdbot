import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  type AiModelFetchOptions,
  type AiModelTransportEvent,
} from "../host.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

function makeModel(overrides: Partial<Model<"anthropic-messages">>) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

function serializeSse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function createStandaloneDoneBody(done = "[DONE]"): string {
  return `${serializeSse([
    {
      type: "message_start",
      message: {
        id: "msg_standalone_done",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    },
  ])}data: ${done}\n\n`;
}

function createOpenRawSseResponse(params: {
  body: string;
  onCancel: () => void;
  rejectCancel?: boolean;
}): Response {
  const encoded = new TextEncoder().encode(params.body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        params.onCancel();
        if (params.rejectCancel) {
          throw new Error("cancel failed");
        }
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function observeTestEndpointInvocation(
  options: AiModelFetchOptions | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): void {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  options?.observeFetchDispatch?.({ url, init: init ?? {} });
}

async function runTerminalCompletenessCase(params: {
  enableBlockingGuard?: boolean;
  endpointClass: "anthropic-public" | "custom";
  events: Record<string, unknown>[];
  modelId?: string;
  onPayload?: NonNullable<Parameters<typeof streamAnthropic>[2]>["onPayload"];
  provider?: string;
  rawBody?: string;
  requestId?: string;
  transportEvents?: AiModelTransportEvent[];
}) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(params.rawBody ?? serializeSse(params.events));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const model = makeModel({
    baseUrl: `http://127.0.0.1:${address.port}`,
    ...(params.modelId ? { id: params.modelId } : {}),
    provider: params.provider ?? "anthropic",
  });
  const buildAttestedFetch = (
    _model: Model,
    _timeout: number | undefined,
    options: AiModelFetchOptions | undefined,
  ) => ({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      observeTestEndpointInvocation(options, input, init);
      const response = globalThis.fetch(input, init);
      options?.onFetchDispatch?.();
      return await response;
    },
    provenance: "dispatch_attested" as const,
  });
  configureAiTransportHost({
    buildModelFetchWithDispatchAttestation: buildAttestedFetch,
    ...(params.enableBlockingGuard
      ? { buildModelFetchWithBlockingDispatchGuard: buildAttestedFetch }
      : {}),
    ...(params.transportEvents
      ? {
          observeModelTransportEvent: (event) => params.transportEvents?.push(event),
        }
      : {}),
    resolveProviderEndpointClass: () => params.endpointClass,
  });

  try {
    return await streamAnthropic(model, context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
      ...(params.onPayload ? { onPayload: params.onPayload } : {}),
      ...(params.requestId ? { requestId: params.requestId } : {}),
    }).result();
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  configureAiTransportHost({});
});

describe("Anthropic SDK host fetch wiring", () => {
  it("preserves multiline repaired text indentation like the Anthropic SDK", async () => {
    const rawBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_multiline","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"C:\\q\ndata:   second"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    ].join("");

    const result = await runTerminalCompletenessCase({
      endpointClass: "custom",
      events: [],
      rawBody,
    });

    expect(result.content).toEqual([{ type: "text", text: "C:\\q\n  second" }]);
  });

  it("recovers compatible orphan text deltas with unverified terminal coverage", async () => {
    const transportEvents: AiModelTransportEvent[] = [];
    const result = await runTerminalCompletenessCase({
      endpointClass: "custom",
      requestId: "call-sdk-orphan-text",
      transportEvents,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_sdk_orphan_text",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "recovered" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ],
    });

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "coverage",
          callId: "call-sdk-orphan-text",
          reason: "transport_terminal_unverified",
        }),
      ]),
    );
  });

  it.each([
    { label: "truncated JSON", data: '{"type":' },
    {
      label: "a malformed escape that JSON repair could normalize",
      data: '{"type":"vendor_ping","path":"C:\\q"}',
    },
  ])("ignores $label under an unknown vendor envelope", async ({ data }) => {
    const rawBody = `${serializeSse([
      {
        type: "message_start",
        message: {
          id: "msg_sdk_unknown_malformed",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ])}event: vendor_ping\ndata: ${data}\n\n${serializeSse([
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ])}`;

    const result = await runTerminalCompletenessCase({
      endpointClass: "custom",
      events: [],
      rawBody,
    });

    expect(result.stopReason).toBe("stop");
  });

  it("rejects compatible clean EOF after an otherwise complete content block", async () => {
    const events: AiModelTransportEvent[] = [];
    const body = serializeSse([
      {
        type: "message_start",
        message: {
          id: "msg_compatible_eof",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "complete" },
      },
      { type: "content_block_stop", index: 0 },
    ]);
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async (input, init) => {
          observeTestEndpointInvocation(options, input, init);
          options.onFetchDispatch?.();
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
        provenance: "dispatch_attested",
      }),
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: () => "custom",
    });

    const result = await streamAnthropic(
      makeModel({ baseUrl: "https://compatible.example" }),
      context,
      {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-compatible-clean-eof",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ended before message_stop");
    expect(events).toEqual([
      expect.objectContaining({
        type: "invocation",
        callId: "call-sdk-compatible-clean-eof",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-compatible-clean-eof",
        outcome: "failed",
      }),
    ]);
  });

  it.each([
    { endpointClass: "custom" as const, expectedOutcome: "completed", expectedStop: "stop" },
    {
      endpointClass: "anthropic-public" as const,
      expectedOutcome: "failed",
      expectedStop: "error",
    },
  ])(
    "cancels open SDK DONE streams and records $expectedOutcome accounting",
    async ({ endpointClass, expectedOutcome, expectedStop }) => {
      const events: AiModelTransportEvent[] = [];
      const onCancel = vi.fn();
      configureAiTransportHost({
        buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
          fetch: async (input, init) => {
            observeTestEndpointInvocation(options, input, init);
            options.onFetchDispatch?.();
            return createOpenRawSseResponse({
              body: `${createStandaloneDoneBody()}event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ignored"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
              onCancel,
            });
          },
          provenance: "dispatch_attested",
        }),
        observeModelTransportEvent: (event) => events.push(event),
        resolveProviderEndpointClass: () => endpointClass,
      });

      const result = await streamAnthropic(makeModel({}), context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: `call-sdk-done-${endpointClass}`,
      }).result();

      expect(result.stopReason).toBe(expectedStop);
      expect(onCancel).toHaveBeenCalledOnce();
      expect(events).toEqual([
        expect.objectContaining({
          type: "invocation",
          callId: `call-sdk-done-${endpointClass}`,
          ordinal: 1,
          attemptOrdinal: 1,
          hopOrdinal: 1,
        }),
        expect.objectContaining({
          type: "attempt",
          callId: `call-sdk-done-${endpointClass}`,
          outcome: expectedOutcome,
          statusCode: 200,
        }),
      ]);
    },
  );

  it("does not let SDK stream cancellation failure override compatible DONE", async () => {
    const onCancel = vi.fn();
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async (input, init) => {
          observeTestEndpointInvocation(options, input, init);
          options.onFetchDispatch?.();
          return createOpenRawSseResponse({
            body: createStandaloneDoneBody(),
            onCancel,
            rejectCancel: true,
          });
        },
        provenance: "dispatch_attested",
      }),
      resolveProviderEndpointClass: () => "custom",
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "success",
      stopReason: "end_turn",
      stopDetails: undefined,
      expectedStopReason: "stop",
      expectedOutcome: "completed",
    },
    {
      label: "refusal",
      stopReason: "refusal",
      stopDetails: {
        type: "refusal",
        category: "cyber",
        explanation: "This request is not allowed.",
      },
      expectedStopReason: "error",
      expectedOutcome: "failed",
    },
  ])(
    "records owned SDK no-boundary fallback $label as one attempt and one transition",
    async ({ expectedOutcome, expectedStopReason, label, stopDetails, stopReason }) => {
      const events: AiModelTransportEvent[] = [];
      let requestCount = 0;
      const server = createServer((_request, response) => {
        requestCount += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          serializeSse([
            {
              type: "message_start",
              message: {
                id: `msg_fallback_${label}`,
                model: "claude-opus-5",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: {
                stop_reason: stopReason,
                ...(stopDetails ? { stop_details: stopDetails } : {}),
              },
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                iterations: [
                  {
                    type: "fallback_message",
                    model: "claude-opus-5",
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_creation: null,
                  },
                ],
              },
            },
            { type: "message_stop" },
          ]),
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address() as AddressInfo;
      const loopbackUrl = `http://127.0.0.1:${address.port}/v1/messages`;
      const buildFallbackFetch = (
        _model: Model,
        _timeout: number | undefined,
        options?: AiModelFetchOptions & {
          beforeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
        },
      ): typeof fetch => {
        return async (input, init) => {
          const dispatch = {
            url: typeof input === "string" || input instanceof URL ? String(input) : input.url,
            init: init ?? {},
          };
          options?.beforeFetchDispatch?.(dispatch);
          observeTestEndpointInvocation(options, input, init);
          const response = globalThis.fetch(loopbackUrl, init);
          options?.onFetchDispatch?.();
          return await response;
        };
      };
      configureAiTransportHost({
        buildModelFetch: buildFallbackFetch,
        buildModelFetchWithBlockingDispatchGuard: (...args) => ({
          fetch: buildFallbackFetch(...args),
          provenance: "dispatch_attested",
        }),
        observeModelTransportEvent: (event) => events.push(event),
        resolveProviderEndpointClass: (baseUrl) =>
          baseUrl?.startsWith("https://api.anthropic.com") ? "anthropic-public" : "custom",
      });
      const requestId = `call-sdk-fallback-${label}`;

      try {
        const result = await streamAnthropic(
          makeModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
          context,
          {
            apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
            maxRetries: 0,
            requestId,
          },
        ).result();
        expect(result.stopReason).toBe(expectedStopReason);
        expect(result.responseModel).toBe("claude-opus-5");
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }

      expect(requestCount).toBe(1);
      expect(events).toEqual([
        expect.objectContaining({
          type: "invocation",
          callId: requestId,
          ordinal: 1,
          attemptOrdinal: 1,
          hopOrdinal: 1,
        }),
        expect.objectContaining({
          type: "provider_fallback",
          callId: requestId,
          fromModel: "claude-fable-5",
          toModel: "claude-opus-5",
        }),
        expect.objectContaining({
          type: "attempt",
          callId: requestId,
          ordinal: 1,
          outcome: expectedOutcome,
          statusCode: 200,
        }),
      ]);
    },
  );

  it("retains a content-confirmed SDK fallback identity without repricing an incomplete stream", async () => {
    const events: AiModelTransportEvent[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_sdk_incomplete_fallback",
              model: "claude-fable-5",
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "fallback",
              from: { model: "claude-fable-5" },
              to: { model: "claude-opus-5" },
            },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "partial" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              iterations: [{ type: "fallback_message", model: "claude-opus-5" }],
            },
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const loopbackUrl = `http://127.0.0.1:${address.port}/v1/messages`;
    const buildFallbackFetch = (
      _model: Model,
      _timeout: number | undefined,
      options?: AiModelFetchOptions & {
        beforeFetchDispatch?: (params: { url: string; init: RequestInit }) => void;
      },
    ): typeof fetch => {
      return async (input, init) => {
        const dispatch = {
          url: typeof input === "string" || input instanceof URL ? String(input) : input.url,
          init: init ?? {},
        };
        options?.beforeFetchDispatch?.(dispatch);
        observeTestEndpointInvocation(options, input, init);
        const response = globalThis.fetch(loopbackUrl, init);
        options?.onFetchDispatch?.();
        return await response;
      };
    };
    configureAiTransportHost({
      buildModelFetch: buildFallbackFetch,
      buildModelFetchWithBlockingDispatchGuard: (...args) => ({
        fetch: buildFallbackFetch(...args),
        provenance: "dispatch_attested",
      }),
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: (baseUrl) =>
        baseUrl?.startsWith("https://api.anthropic.com") ? "anthropic-public" : "custom",
    });
    const model = makeModel({
      id: "claude-fable-5",
      name: "Claude Fable 5",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-incomplete-fallback",
      }).result();
      expect(result.stopReason).toBe("error");
      expect(result.responseModel).toBe("claude-opus-5");
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          type: "provider_fallback",
          details: {
            provider: "anthropic",
            fromModel: "claude-fable-5",
            toModel: "claude-opus-5",
          },
        }),
      ]);
      expect(result.usage.cost.total).toBeCloseTo(0.00015, 10);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "invocation",
        callId: "call-sdk-incomplete-fallback",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
      }),
      expect.objectContaining({
        type: "provider_fallback",
        callId: "call-sdk-incomplete-fallback",
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-incomplete-fallback",
        outcome: "failed",
      }),
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-incomplete-fallback",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });
});
