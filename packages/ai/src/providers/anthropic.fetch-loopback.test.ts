import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  type AiModelFetchOptions,
  type AiModelTransportEvent,
  type AiTransportHost,
} from "../host.js";
import type { Context, Model } from "../types.js";
import { createAnthropicEndpointAuthority } from "./anthropic-stream-terminal.js";
import { streamAnthropic } from "./anthropic.js";

type CapturedRequest = {
  method: string;
  path: string;
  authorization?: string;
  apiKey?: string;
};

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
  it("requires message_stop when any endpoint invocation lacks authority", () => {
    const authority = createAnthropicEndpointAuthority({
      provider: "anthropic",
      resolveEndpointClass: (url) =>
        url === "https://compatible.example/v1/messages" ? "custom" : "",
    });

    authority.observeEndpointInvocation("https://unknown.example/v1/messages");
    authority.observeEndpointInvocation("https://compatible.example/v1/messages");

    expect(authority.snapshot()).toEqual({
      endpointClass: "custom",
      requiresMessageStop: true,
      traceState: "partial",
    });
  });

  it("routes every non-Cloudflare client branch through the host fetch", async () => {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
      });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "test rejection" },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const hostFetch = vi.fn<typeof fetch>((input, init) => globalThis.fetch(input, init));
    const buildModelFetch = vi.fn(() => hostFetch);
    configureAiTransportHost({ buildModelFetch });

    const cases = [
      {
        model: makeModel({ provider: "github-copilot", baseUrl }),
        apiKey: "copilot-token",
      },
      {
        model: makeModel({ provider: "microsoft-foundry", baseUrl, authHeader: true }),
        apiKey: "foundry-token",
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-oat01-oauth-token", // pragma: allowlist secret
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        model: makeModel({ provider: "kimi-coding", baseUrl }),
        apiKey: "kimi-api-key",
        thinkingEnabled: true,
      },
    ];

    try {
      for (const testCase of cases) {
        const result = await streamAnthropic(testCase.model, context, {
          apiKey: testCase.apiKey,
          maxRetries: 0,
          thinkingEnabled: testCase.thinkingEnabled,
        }).result();
        expect(result.stopReason).toBe("error");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(hostFetch).toHaveBeenCalledTimes(cases.length);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer copilot-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer foundry-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer sk-ant-oat01-oauth-token", // pragma: allowlist secret
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "kimi-api-key",
      },
    ]);
    expect(buildModelFetch).toHaveBeenLastCalledWith(
      cases.at(-1)?.model,
      undefined,
      expect.objectContaining({ sanitizeSse: false }),
    );
  });

  it("counts each SDK retry as an admitted fetch invocation", async () => {
    const events: AiModelTransportEvent[] = [];
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(503, {
          "content-type": "application/json",
          "retry-after-ms": "0",
        });
        response.end(JSON.stringify({ error: { message: "retry" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_retry",
              model: "claude-sonnet-4-6",
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          { type: "message_stop" },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const model = makeModel({ baseUrl: `http://127.0.0.1:${address.port}` });
    const buildModelFetchWithDispatchAttestation: NonNullable<
      AiTransportHost["buildModelFetchWithDispatchAttestation"]
    > = (_model, _timeout, options?: AiModelFetchOptions) => {
      return {
        fetch: async (input, init) => {
          observeTestEndpointInvocation(options, input, init);
          const response = globalThis.fetch(input, init);
          options?.onFetchDispatch?.();
          return await response;
        },
        provenance: "dispatch_attested",
      };
    };
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation,
      observeModelTransportEvent: (event) => events.push(event),
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 1,
        requestId: "call-sdk-retry",
      }).result();
      expect(result.stopReason).toBe("stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "invocation",
        callId: "call-sdk-retry",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial",
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-retry",
        ordinal: 1,
        reason: "initial",
        outcome: "failed",
        statusCode: 503,
      }),
      expect.objectContaining({
        type: "invocation",
        callId: "call-sdk-retry",
        ordinal: 2,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "retry",
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-retry",
        ordinal: 2,
        reason: "retry",
        outcome: "completed",
        statusCode: 200,
      }),
    ]);
  });

  it("does not claim zero submission when SDK payload preparation fails before fetch", async () => {
    const events: AiModelTransportEvent[] = [];
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => {
        const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
          observeTestEndpointInvocation(options, input, init);
          const response = hostFetch(input, init);
          options?.onFetchDispatch?.();
          return await response;
        };
        return { fetch: fetchImpl, provenance: "dispatch_attested" as const };
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      requestId: "call-sdk-preflight",
      onPayload: () => {
        throw new Error("blocked before network");
      },
    }).result();

    expect(result.stopReason).toBe("error");
    expect(hostFetch).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("keeps SDK dispatch provenance local when one fetch is reused", async () => {
    const events: AiModelTransportEvent[] = [];
    const sharedFetch = vi.fn<typeof fetch>();
    const buildAttestedModelFetch = vi
      .fn()
      .mockReturnValueOnce({
        fetch: sharedFetch,
        provenance: "dispatch_attested" as const,
      })
      .mockReturnValueOnce(undefined);
    configureAiTransportHost({
      buildModelFetch: () => sharedFetch,
      buildModelFetchWithDispatchAttestation: buildAttestedModelFetch,
      observeModelTransportEvent: (event) => events.push(event),
    });

    const attested = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      requestId: "call-sdk-attested-shared-fetch",
      onPayload: () => {
        throw new Error("blocked before network");
      },
    }).result();
    const bare = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      requestId: "call-sdk-bare-shared-fetch",
      onPayload: () => {
        throw new Error("blocked before network");
      },
    }).result();

    expect(attested.stopReason).toBe("error");
    expect(bare.stopReason).toBe("error");
    expect(sharedFetch).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("does not count a synchronous owned SDK fetch throw as an invocation", async () => {
    const events: AiModelTransportEvent[] = [];
    const hostFetch = vi.fn<typeof fetch>(() => {
      throw new Error("fetch invocation failed");
    });
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options?: AiModelFetchOptions) => (input, init) => {
        observeTestEndpointInvocation(options, input, init);
        const response = hostFetch(input, init);
        options?.onFetchDispatch?.();
        return response;
      },
      observeModelTransportEvent: (event) => events.push(event),
    });

    const result = await streamAnthropic(makeModel({}), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
      requestId: "call-sdk-sync-fetch-throw",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(hostFetch).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-sync-fetch-throw",
        scope: "transport_semantics",
        reason: "transport_submission_authority_partial",
      }),
      expect.objectContaining({
        type: "coverage",
        callId: "call-sdk-sync-fetch-throw",
        scope: "transport_semantics",
        reason: "transport_endpoint_authority_partial",
      }),
    ]);
  });

  it("records a failed owned SDK attempt when EOF arrives before message_stop", async () => {
    const events: AiModelTransportEvent[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        serializeSse([
          {
            type: "message_start",
            message: {
              id: "msg_incomplete",
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
            delta: { type: "text_delta", text: "partial" },
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const model = makeModel({ baseUrl: `http://127.0.0.1:${address.port}` });
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async (input, init) => {
          observeTestEndpointInvocation(options, input, init);
          const response = globalThis.fetch(input, init);
          options.onFetchDispatch?.();
          return await response;
        },
        provenance: "dispatch_attested",
      }),
      observeModelTransportEvent: (event) => events.push(event),
    });

    try {
      const result = await streamAnthropic(model, context, {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-incomplete",
      }).result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("ended before message_stop");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: "invocation",
        callId: "call-sdk-incomplete",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
      }),
      expect.objectContaining({
        type: "attempt",
        callId: "call-sdk-incomplete",
        outcome: "failed",
        statusCode: 200,
      }),
    ]);
  });

  it.each([
    {
      label: "rejects direct EOF after a mapped stop reason",
      endpointClass: "anthropic-public" as const,
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects official-endpoint EOF through a provider alias",
      endpointClass: "anthropic-public" as const,
      provider: "provider-alias",
      events: [
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts compatible EOF after a mapped stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_mapped_eof",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      expectedStopReason: "stop",
    },
    {
      label: "rejects boundary-aligned compatible EOF without terminal evidence",
      endpointClass: "custom" as const,
      events: [
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
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects compatible clean EOF for refusal-buffered models",
      endpointClass: "custom" as const,
      modelId: "claude-opus-5",
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_compatible_refusal_buffer_eof",
            model: "claude-opus-5",
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
          delta: { type: "text_delta", text: "must remain buffered" },
        },
        { type: "content_block_stop", index: 0 },
      ],
      expectedStopReason: "error",
    },
    {
      label: "accepts compatible standalone DONE",
      endpointClass: "custom" as const,
      events: [],
      rawBody: createStandaloneDoneBody(),
      expectedStopReason: "stop",
    },
    {
      label: "rejects official standalone DONE",
      endpointClass: "anthropic-public" as const,
      events: [],
      rawBody: createStandaloneDoneBody(),
      expectedStopReason: "error",
    },
    {
      label: "rejects compatible partial EOF without a stop reason",
      endpointClass: "custom" as const,
      events: [
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "partial" },
        },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects message_stop without a terminal message_delta",
      endpointClass: "anthropic-public" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_sdk_without_delta",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "message_stop" },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects a reused content block index on a compatible endpoint",
      endpointClass: "custom" as const,
      events: [
        {
          type: "message_start",
          message: {
            id: "msg_sdk_reused_block_index",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ],
      expectedStopReason: "error",
    },
    {
      label: "rejects a truncated model payload under an unknown event envelope",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_tail_prefix",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}event: vendor_ping\ndata: {"type":"content_block_delta"`,
      expectedStopReason: "error",
    },
    {
      label: "rejects a complete model payload under an unknown event envelope",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_unknown_envelope",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}event: vendor_ping\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hidden"}}\n\n`,
      expectedStopReason: "error",
    },
    {
      label: "ignores an identifiable truncated unlabelled ping",
      endpointClass: "custom" as const,
      events: [],
      rawBody: `${serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_sdk_ping_tail",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        },
      ])}data: {"type":"ping"`,
      expectedStopReason: "stop",
    },
    {
      label: "rejects an SSE envelope whose event name disagrees with its payload",
      endpointClass: "anthropic-public" as const,
      events: [],
      rawBody: 'event: message_start\ndata: {"type":"message_stop"}\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects an error envelope whose payload type disagrees",
      endpointClass: "custom" as const,
      events: [],
      rawBody: 'event: error\ndata: {"type":"message_stop"}\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects data-only Anthropic message frames",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'data: {"type":"message_start","message":{"id":"msg_data_only","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: [DONE]\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects a final bare event field that clears the event name",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'event: message_start\nevent\ndata: {"type":"message_start","message":{"id":"msg_bare_event","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\ndata: [DONE]\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects a double-space event name like the Anthropic SDK",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'event:  message_start\ndata: {"type":"message_start","message":{"id":"msg_double_space","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      expectedStopReason: "error",
    },
    {
      label: "rejects a trailing-space event name like the Anthropic SDK",
      endpointClass: "custom" as const,
      events: [],
      rawBody:
        'event: message_start \ndata: {"type":"message_start","message":{"id":"msg_trailing_space","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      expectedStopReason: "error",
    },
  ])(
    "$label",
    async ({ endpointClass, events, expectedStopReason, modelId, provider, rawBody }) => {
      const result = await runTerminalCompletenessCase({
        endpointClass,
        events,
        modelId,
        provider,
        rawBody,
      });

      expect(result.stopReason).toBe(expectedStopReason);
      if (expectedStopReason === "error") {
        expect(result.errorMessage).toContain("ended before message_stop");
      }
    },
  );
});
