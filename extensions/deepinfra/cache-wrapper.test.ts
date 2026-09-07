// Deepinfra tests cover cache wrapper plugin behavior.
import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createDeepInfraAnthropicCacheWrapper } from "./cache-wrapper.js";

type StreamFn = Parameters<typeof createDeepInfraAnthropicCacheWrapper>[0];

function capturePayload(params: {
  modelId: string;
  api?: "openai-completions" | "anthropic-messages";
  initialPayload: Record<string, unknown>;
  cacheRetention?: "none" | "short" | "long";
}): {
  captured: Record<string, unknown>;
  baseCalls: number;
  baseCacheRetention: unknown;
} {
  let captured: Record<string, unknown> = {};
  let baseCalls = 0;
  let baseCacheRetention: unknown;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    baseCalls += 1;
    baseCacheRetention = options?.cacheRetention;
    const payload = structuredClone(params.initialPayload);
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createDeepInfraAnthropicCacheWrapper(baseStreamFn, {
    cacheRetention: params.cacheRetention,
  });
  void wrapped(
    {
      api: params.api ?? "openai-completions",
      provider: "deepinfra",
      id: params.modelId,
      reasoning: false,
    } as Parameters<StreamFn>[0],
    { messages: [] } as Parameters<StreamFn>[1],
    {} as never,
  );

  return { captured, baseCalls, baseCacheRetention };
}

describe("createDeepInfraAnthropicCacheWrapper", () => {
  it("injects ephemeral cache_control markers on the system message for anthropic/* models", () => {
    const { captured, baseCalls } = capturePayload({
      modelId: "anthropic/claude-sonnet-4-6",
      initialPayload: {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hi" },
        ],
      },
    });

    expect(baseCalls).toBe(1);
    expect(captured.messages).toEqual([
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "You are a helpful assistant.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  it("tags the last block of an array-shaped system message", () => {
    const { captured } = capturePayload({
      modelId: "anthropic/claude-haiku-4-5",
      initialPayload: {
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "Block one" },
              { type: "text", text: "Block two" },
            ],
          },
          { role: "user", content: "Hi" },
        ],
      },
    });

    const messages = captured.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Block one" },
      {
        type: "text",
        text: "Block two",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("matches the anthropic/ prefix case-insensitively", () => {
    const { captured } = capturePayload({
      modelId: "Anthropic/Claude-Sonnet-4-6",
      initialPayload: {
        messages: [{ role: "system", content: "sys" }],
      },
    });

    const messages = captured.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
  });

  it.each(["none", "short", "long"] as const)(
    "honors configured %s retention without inventing TTL support",
    (cacheRetention) => {
      const { captured } = capturePayload({
        modelId: "anthropic/claude-sonnet-4-6",
        cacheRetention,
        initialPayload: {
          messages: [
            { role: "system", content: "system" },
            { role: "user", content: "question" },
          ],
        },
      });
      expect(JSON.stringify(captured).match(/"cache_control":/g) ?? []).toHaveLength(
        cacheRetention === "none" ? 0 : 2,
      );
      expect(JSON.stringify(captured)).not.toContain('"ttl"');
    },
  );

  it.each([
    { cacheRetention: "none", requiresStringContent: false },
    { cacheRetention: "short", requiresStringContent: true },
  ] as const)(
    "composes managed requests with $cacheRetention retention and string-only=$requiresStringContent",
    ({ cacheRetention, requiresStringContent }) => {
      const model: Model<"openai-completions"> & {
        compat: { requiresStringContent: boolean };
      } = {
        api: "openai-completions",
        provider: "deepinfra",
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        compat: { requiresStringContent },
      };
      let payload: Record<string, unknown> = {};
      const base: StreamFn = (resolvedModel, context, options) => {
        payload = buildOpenAICompletionsParams(resolvedModel, context, {
          cacheRetention: options?.cacheRetention,
        });
        options?.onPayload?.(payload, resolvedModel);
        return createAssistantMessageEventStream();
      };
      void createDeepInfraAnthropicCacheWrapper(base, { cacheRetention })(model, {
        systemPrompt: "STABLE",
        messages: [{ role: "user", content: "Question", timestamp: 1 }],
      });
      expect(JSON.stringify(payload)).not.toContain("cache_control");
      expect(payload.messages).toEqual([
        { role: "system", content: "STABLE" },
        { role: "user", content: "Question" },
      ]);
    },
  );

  it("preserves native Anthropic Messages payloads and options", () => {
    const initialPayload = {
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
    };
    const { captured, baseCacheRetention } = capturePayload({
      modelId: "anthropic/claude-sonnet-4-6",
      api: "anthropic-messages",
      cacheRetention: "long",
      initialPayload,
    });
    expect(captured).toEqual(initialPayload);
    expect(baseCacheRetention).toBeUndefined();
  });

  it("does not mutate payloads for non-anthropic model ids", () => {
    const initialPayload = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "Hi" },
      ],
    };
    const { captured, baseCalls, baseCacheRetention } = capturePayload({
      modelId: "deepseek-ai/DeepSeek-V4-Flash",
      initialPayload,
    });

    expect(baseCalls).toBe(1);
    expect(captured).toEqual(initialPayload);
    expect(baseCacheRetention).toBeUndefined();
  });
});
