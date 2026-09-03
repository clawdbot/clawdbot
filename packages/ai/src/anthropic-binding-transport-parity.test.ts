import type { Context, Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  anthropicModel,
  context,
  anthropicEvents,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

async function captureAnthropicRequest(
  implementation: "provider" | "transport",
  options: {
    model?: Partial<Model<"anthropic-messages">>;
    apiKey?: string;
    reasoning?: "low" | "off";
    events?: readonly Record<string, unknown>[];
    context?: Context;
    thinkingOverride?: { type: "disabled" } | { type: "enabled"; budget_tokens: number };
    headers?: Record<string, string>;
  } = {},
) {
  const requests: Array<{ payload: Record<string, unknown>; headers: Headers }> = [];
  const warnings: string[] = [];
  const capabilities = getAiTransportHost().resolveProviderRequestCapabilities({});
  const fetchMock: typeof fetch = async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON Anthropic request body");
    }
    requests.push({
      payload: JSON.parse(init.body) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return createAnthropicResponse(options.events ?? anthropicEvents);
  };
  configureAiTransportHost({
    ...getAiTransportHost(),
    buildModelFetch: () => fetchMock,
    logWarn: (_subsystem, message) => warnings.push(message),
    resolveProviderRequestCapabilities: (input) => ({
      ...capabilities,
      endpointClass:
        new URL(input.baseUrl ?? "https://api.anthropic.com").hostname === "api.anthropic.com"
          ? "anthropic-public"
          : "custom",
    }),
  });
  const model = { ...anthropicModel, ...options.model };
  const streamOptions = {
    apiKey: options.apiKey ?? "sk-test",
    reasoning: options.reasoning ?? "low",
    headers: options.headers,
    onPayload: (payload: unknown) =>
      options.thinkingOverride
        ? { ...(payload as Record<string, unknown>), thinking: options.thinkingOverride }
        : undefined,
  } as const;
  const [{ streamSimpleAnthropic }, { createAnthropicMessagesTransportStreamFn }] =
    await Promise.all([
      import("./providers/anthropic.js"),
      import("./transports/anthropic-transport-stream.js"),
    ]);
  const requestContext = options.context ?? context;
  const stream =
    implementation === "provider"
      ? streamSimpleAnthropic(model, requestContext, streamOptions)
      : await Promise.resolve(
          createAnthropicMessagesTransportStreamFn()(model, requestContext, streamOptions),
        );
  const result = await stream.result();
  expect(result.stopReason).toBe("stop");
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) {
    throw new Error("Expected one Anthropic request");
  }
  return { ...request, warnings };
}

describe("Anthropic thinking-binding transport parity", () => {
  registerParityHostLifecycle();

  it.each([
    { name: "direct API-key adaptive", enabled: true },
    { name: "OAuth", apiKey: "sk-ant-oat01-synthetic", enabled: false },
    { name: "proxy", model: { baseUrl: "https://proxy.example/v1" }, enabled: false },
    { name: "Cloudflare", model: { provider: "cloudflare-ai-gateway" }, enabled: false },
    { name: "Copilot", model: { provider: "github-copilot" }, enabled: false },
    { name: "Foundry", model: { provider: "microsoft-foundry" }, enabled: false },
    { name: "Kimi", model: { provider: "kimi-coding" }, enabled: false },
    { name: "budget thinking", model: { id: "claude-sonnet-4-5" }, enabled: false },
    { name: "disabled thinking", reasoning: "off" as const, enabled: false },
    {
      name: "hook-disabled thinking",
      thinkingOverride: { type: "disabled" as const },
      enabled: false,
    },
    {
      name: "hook-budget thinking",
      thinkingOverride: { type: "enabled" as const, budget_tokens: 1024 },
      enabled: false,
    },
  ])("gates thinking-binding controls equally for $name", async ({ enabled, ...options }) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, options);
      expect(
        headers.get("anthropic-beta")?.includes("thinking-binding-controls-2026-08-01") ?? false,
      ).toBe(enabled);
      expect(payload.thinking).toEqual(
        enabled
          ? expect.objectContaining({ block_binding: { prefix_mismatch_behavior: "drop_block" } })
          : expect.not.objectContaining({ block_binding: expect.anything() }),
      );
    }
  });

  it("appends binding controls without losing caller beta headers in either path", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { headers } = await captureAnthropicRequest(implementation, {
        headers: { "Anthropic-Beta": "synthetic-beta" },
      });
      const betas = headers
        .get("anthropic-beta")
        ?.split(",")
        .map((beta) => beta.trim());
      expect(betas?.filter((beta) => beta === "synthetic-beta")).toHaveLength(1);
      expect(betas).toContain("thinking-binding-controls-2026-08-01");
    }
  });

  it("omits binding controls for an environment-selected proxy in both paths", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example/v1");
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        model: { baseUrl: undefined },
      });
      expect(payload.thinking).not.toHaveProperty("block_binding");
      expect(headers.get("anthropic-beta") ?? "").not.toContain("thinking-binding-controls");
    }
  });

  it("keeps append-only carriers as stable cache anchors through a tool loop in both paths", async () => {
    const messages: Context["messages"] = [
      { role: "user", content: "Question", timestamp: 1 },
      {
        role: "user",
        content: "Retained runtime context",
        timestamp: 2,
        runtimeContextCarrier: true,
      },
    ];
    for (const implementation of ["provider", "transport"] as const) {
      const first = await captureAnthropicRequest(implementation, {
        context: { ...context, messages },
      });
      const continued = await captureAnthropicRequest(implementation, {
        context: {
          ...context,
          messages: [
            ...messages,
            {
              role: "assistant",
              api: anthropicModel.api,
              provider: anthropicModel.provider,
              model: anthropicModel.id,
              timestamp: 3,
              stopReason: "toolUse",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              content: [
                { type: "thinking", thinking: "Think", thinkingSignature: "synthetic-signature" },
                { type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "value" } },
              ],
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "lookup",
              timestamp: 4,
              content: [{ type: "text", text: "Answer" }],
              isError: false,
            },
          ],
        },
      });
      const firstMessages = first.payload.messages as Array<Record<string, unknown>>;
      const continuedMessages = continued.payload.messages as Array<Record<string, unknown>>;
      expect(firstMessages[1]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "Retained runtime context", cache_control: { type: "ephemeral" } },
        ],
      });
      expect(JSON.stringify(continuedMessages.slice(0, 2))).toBe(JSON.stringify(firstMessages));
      expect(continuedMessages[2]?.role).toBe("assistant");
    }
  });

  it.each(["start", "delta", "both"] as const)(
    "reports dropped thinking once from message %s with bounded paths",
    async (location) => {
      const transformations = Array.from({ length: 7 }, (_, index) => ({
        type: "thinking_dropped",
        reason: index % 2 ? "model_binding_mismatch" : "prefix_binding_mismatch",
        path: `messages.${index}.content.0`,
      }));
      const events = anthropicEvents.map((event) => {
        if (event.type === "message_start" && location !== "delta") {
          return Object.assign({}, event, {
            message: Object.assign({}, event.message, { input_transformations: transformations }),
          });
        }
        if (event.type === "message_delta" && location !== "start") {
          return Object.assign({}, event, { message: { input_transformations: transformations } });
        }
        return event;
      });
      for (const implementation of ["provider", "transport"] as const) {
        const { warnings } = await captureAnthropicRequest(implementation, { events });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("replayed thinking dropped: 7 block(s)");
        expect(warnings[0]).toContain("prefix_binding_mismatch at messages.0.content.0");
        expect(warnings[0]).toContain("model_binding_mismatch at messages.1.content.0");
        expect(warnings[0]).toContain("messages.4.content.0");
        expect(warnings[0]).not.toContain("messages.5.content.0");
      }
    },
  );

  it("ignores unknown thinking transformations and replaces start telemetry at final delta", async () => {
    const events = anthropicEvents.map((event) => {
      if (event.type === "message_start") {
        return Object.assign({}, event, {
          message: Object.assign({}, event.message, {
            input_transformations: [
              {
                type: "thinking_dropped",
                reason: "prefix_binding_mismatch",
                path: "messages.1.content.0",
              },
            ],
          }),
        });
      }
      return event.type === "message_delta"
        ? Object.assign({}, event, {
            input_transformations: [
              { type: "future", reason: "prefix_binding_mismatch", path: "messages.1.content.0" },
              { type: "thinking_dropped", reason: "future", path: "messages.1.content.0" },
            ],
          })
        : event;
    });
    for (const implementation of ["provider", "transport"] as const) {
      expect((await captureAnthropicRequest(implementation, { events })).warnings).toEqual([]);
    }
  });
});
