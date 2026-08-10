import Anthropic from "@anthropic-ai/sdk";
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

function observeTestEndpointInvocation(
  options: AiModelFetchOptions | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
): void {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  options?.onFetchInvocation?.();
  options?.observeFetchDispatch?.({ url, init: init ?? {} });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  configureAiTransportHost({});
});

describe("Anthropic SDK endpoint authority and injected clients", () => {
  it.each(["hostless", "legacy"] as const)(
    "keeps %s fallback candidates usable with partial authority",
    async (hostMode) => {
      const events: AiModelTransportEvent[] = [];
      let capturedPayload: Record<string, unknown> | undefined;
      let capturedHeaders: Headers | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new TypeError("expected Anthropic SDK request body to be a string");
        }
        capturedPayload = JSON.parse(init.body) as Record<string, unknown>;
        capturedHeaders = new Headers(init?.headers);
        return new Response(
          serializeSse([
            {
              type: "message_start",
              message: {
                id: `msg_${hostMode}_fallback_candidate`,
                model: "claude-fable-5",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      });
      if (hostMode === "hostless") {
        vi.stubGlobal("fetch", fetchMock);
      }
      configureAiTransportHost({
        ...(hostMode === "legacy"
          ? {
              buildModelFetch:
                (_model: Model, _timeout: number | undefined, options?: AiModelFetchOptions) =>
                async (input: RequestInfo | URL, init?: RequestInit) => {
                  const response = fetchMock(input, init);
                  options?.onFetchDispatch?.();
                  return await response;
                },
            }
          : {}),
        observeModelTransportEvent: (event) => events.push(event),
        resolveProviderEndpointClass: () => "anthropic-public",
      });

      const result = await streamAnthropic(
        makeModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
        context,
        {
          apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
          maxRetries: 0,
          requestId: `call-${hostMode}-fallback-candidate`,
        },
      ).result();

      expect(result.stopReason, result.errorMessage).toBe("stop");
      expect(capturedPayload?.fallbacks).toBeUndefined();
      expect(capturedHeaders?.get("anthropic-beta") ?? "").not.toContain(
        "server-side-fallback-2026-07-01",
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "coverage",
            callId: `call-${hostMode}-fallback-candidate`,
            reason: "transport_endpoint_authority_partial",
          }),
        ]),
      );
      expect(events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: expect.stringMatching(/^(attempt|provider_fallback|submission)$/u),
          }),
        ]),
      );
    },
  );

  it("fails closed when the named blocking guard is advertised but invalid", async () => {
    const events: AiModelTransportEvent[] = [];
    configureAiTransportHost({
      buildModelFetchWithBlockingDispatchGuard: () => undefined,
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: () => "anthropic-public",
    });

    const result = await streamAnthropic(
      makeModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      context,
      {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId: "call-sdk-invalid-blocking-guard",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("blocking model fetch dispatch guard is unavailable");
    expect(events).toEqual([]);
  });

  it("keeps legacy SDK endpoint observations partial", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://compatible.example");
    const resolveProviderEndpointClass = vi.fn((baseUrl?: string) =>
      baseUrl?.startsWith("https://compatible.example/") ? "custom" : "anthropic-public",
    );
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options?: AiModelFetchOptions) => async (input, init) => {
        observeTestEndpointInvocation(options, input, init);
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
      resolveProviderEndpointClass,
    });

    const result = await streamAnthropic(makeModel({ baseUrl: undefined }), context, {
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      maxRetries: 0,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ended before message_stop");
    expect(resolveProviderEndpointClass).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/compatible\.example\//u),
    );
  });

  it("uses an injected SDK client's declared base URL immediately before create", async () => {
    const events: AiModelTransportEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          serializeSse([
            {
              type: "message_start",
              message: {
                id: "msg_injected_client",
                model: "claude-sonnet-4-6",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    const client = new Anthropic({
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      baseURL: "https://api.anthropic.com",
      fetch: fetchMock,
    });
    configureAiTransportHost({
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: (baseUrl) =>
        baseUrl?.replace(/\/+$/u, "") === "https://compatible.example"
          ? "custom"
          : "anthropic-public",
    });

    const result = await streamAnthropic(makeModel({}), context, {
      client,
      maxRetries: 0,
      requestId: "call-injected-client-authority",
      onPayload: (payload) => {
        client.baseURL = "https://compatible.example";
        return payload;
      },
    }).result();

    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/compatible\.example\//u),
      expect.anything(),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        callId: "call-injected-client-authority",
        reason: "transport_submission_authority_partial",
      }),
      expect.objectContaining({
        type: "coverage",
        callId: "call-injected-client-authority",
        reason: "transport_endpoint_authority_partial",
      }),
    ]);
  });

  it("requires message_stop when an injected compatible client has only provisional authority", async () => {
    const events: AiModelTransportEvent[] = [];
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          serializeSse([
            {
              type: "message_start",
              message: {
                id: "msg_injected_compatible_eof",
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
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    const client = new Anthropic({
      apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      baseURL: "https://compatible.example",
      fetch: fetchMock,
    });
    configureAiTransportHost({
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: () => "custom",
    });

    const result = await streamAnthropic(
      makeModel({ baseUrl: "https://compatible.example" }),
      context,
      {
        client,
        maxRetries: 0,
        requestId: "call-injected-compatible-eof",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ended before message_stop");
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        callId: "call-injected-compatible-eof",
        reason: "transport_submission_authority_partial",
      }),
      expect.objectContaining({
        type: "coverage",
        callId: "call-injected-compatible-eof",
        reason: "transport_endpoint_authority_partial",
      }),
    ]);
  });

  it("rejects an unterminated SDK SSE tail at an exact compatible endpoint", async () => {
    const events: AiModelTransportEvent[] = [];
    const body =
      serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_incomplete_tail",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
      ]) + 'event: message_stop\ndata: {"type":"message_stop"';
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async () => {
          const dispatch = { url: "https://compatible.example/v1/messages", init: {} };
          options.onFetchInvocation?.();
          options.observeFetchDispatch?.(dispatch);
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
        requestId: "call-sdk-incomplete-tail",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ended before message_stop");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "invocation",
          callId: "call-sdk-incomplete-tail",
          attemptOrdinal: 1,
          hopOrdinal: 1,
        }),
        expect.objectContaining({
          type: "attempt",
          callId: "call-sdk-incomplete-tail",
          outcome: "failed",
        }),
      ]),
    );
  });

  it("keeps SDK token-cache 401 refresh accounting explicitly partial", async () => {
    const events: AiModelTransportEvent[] = [];
    const credentials = vi.fn(async (options?: { forceRefresh?: boolean }) => ({
      token: options?.forceRefresh ? "refreshed-token" : "cached-token",
      expiresAt: null,
    }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"type":"authentication_error","message":"expired"}}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          serializeSse([
            {
              type: "message_start",
              message: {
                id: "msg_token_refresh",
                model: "claude-sonnet-4-6",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      );
    const client = new Anthropic({
      apiKey: null,
      authToken: null,
      baseURL: "https://compatible.example",
      credentials,
      fetch: fetchMock,
    });
    configureAiTransportHost({
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: () => "custom",
    });

    const result = await streamAnthropic(
      makeModel({ baseUrl: "https://compatible.example" }),
      context,
      {
        client,
        maxRetries: 1,
        requestId: "call-injected-token-refresh",
      },
    ).result();

    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentials).toHaveBeenNthCalledWith(1, undefined);
    expect(credentials).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        callId: "call-injected-token-refresh",
        reason: "transport_submission_authority_partial",
      }),
      expect.objectContaining({
        type: "coverage",
        callId: "call-injected-token-refresh",
        reason: "transport_endpoint_authority_partial",
      }),
    ]);
  });

  it("keeps legacy SDK callback authority partial on the fetch-build host snapshot", async () => {
    const resolveInitialEndpoint = vi.fn(() => "custom");
    configureAiTransportHost({
      buildModelFetch: (_model, _timeout, options?: AiModelFetchOptions) => {
        configureAiTransportHost({
          resolveProviderEndpointClass: () => "anthropic-public",
        });
        return async (input, init) => {
          observeTestEndpointInvocation(options, input, init);
          options?.onFetchDispatch?.();
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        };
      },
      resolveProviderEndpointClass: resolveInitialEndpoint,
    });

    const result = await streamAnthropic(
      makeModel({ baseUrl: "https://compatible.example" }),
      context,
      {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ended before message_stop");
    expect(resolveInitialEndpoint).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/compatible\.example\//u),
    );
  });

  it.each<{
    label: string;
    hops: [string, string];
    body: string;
  }>([
    {
      label: "custom to official",
      hops: ["https://compatible.example/v1/messages", "https://api.anthropic.com/v1/messages"],
      body: "data: [DONE]\n\n",
    },
    {
      label: "official to custom",
      hops: ["https://api.anthropic.com/v1/messages", "https://compatible.example/v1/messages"],
      body: serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_official_to_custom",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
      ]),
    },
    {
      label: "custom to different custom origin",
      hops: [
        "https://first-compatible.example/v1/messages",
        "https://second-compatible.example/v1/messages",
      ],
      body: serializeSse([
        {
          type: "message_start",
          message: {
            id: "msg_custom_cross_origin",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
      ]),
    },
  ])("requires strict authority across a $label redirect", async (testCase) => {
    const events: AiModelTransportEvent[] = [];
    const requestId = `call-sdk-redirect-${testCase.label.replaceAll(" ", "-")}`;
    configureAiTransportHost({
      buildModelFetchWithDispatchAttestation: (_model, _timeout, options) => ({
        fetch: async () => {
          options.onFetchInvocation?.();
          options.observeFetchDispatch?.({ url: testCase.hops[0], init: {} });
          options.onFetchDispatch?.();
          options.onFetchInvocation?.();
          options.observeFetchDispatch?.({ url: testCase.hops[1], init: {} });
          return new Response(testCase.body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
        provenance: "dispatch_attested",
      }),
      observeModelTransportEvent: (event) => events.push(event),
      resolveProviderEndpointClass: (url) =>
        url?.startsWith("https://api.anthropic.com") ? "anthropic-public" : "custom",
    });

    const result = await streamAnthropic(
      makeModel({ baseUrl: new URL(testCase.hops[0]).origin }),
      context,
      {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
        requestId,
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("ended before message_stop");
    const expectedCoverageReasons = ["transport_endpoint_authority_partial"];
    expect(events).toEqual(
      expect.arrayContaining(
        expectedCoverageReasons.map((reason) =>
          expect.objectContaining({
            type: "coverage",
            callId: requestId,
            reason,
          }),
        ),
      ),
    );
  });

  it("blocks a noncanonical fallback redirect even when the host classifies it as public", async () => {
    const observedPhysicalUrls: string[] = [];
    configureAiTransportHost({
      buildModelFetchWithBlockingDispatchGuard: (_model, _timeout, options) => ({
        fetch: async () => {
          const official = {
            url: "https://api.anthropic.com/v1/messages",
            init: {},
          };
          options.beforeFetchDispatch(official);
          options.onFetchInvocation?.();
          options.observeFetchDispatch?.(official);
          observedPhysicalUrls.push(official.url);
          options.onFetchDispatch?.();
          const custom = {
            url: "https://compatible.example/v1/messages",
            init: {},
          };
          options.beforeFetchDispatch(custom);
          throw new Error("unreachable custom egress");
        },
        provenance: "dispatch_attested",
      }),
      resolveProviderEndpointClass: () => "anthropic-public",
    });

    const result = await streamAnthropic(
      makeModel({ id: "claude-fable-5", name: "Claude Fable 5" }),
      context,
      {
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
        maxRetries: 0,
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(observedPhysicalUrls).toEqual(["https://api.anthropic.com/v1/messages"]);
  });
});
