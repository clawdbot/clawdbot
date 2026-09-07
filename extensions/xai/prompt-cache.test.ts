import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { resolveXaiTransport } from "./provider-routing.js";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";

describe("xAI Responses prompt cache routing", () => {
  it.each([
    { baseUrl: "https://api.x.ai/v1", api: "openai-responses", key: "session-123" },
    { baseUrl: "https://api.x.ai/v1", api: "openai-completions", key: "session-123" },
    { baseUrl: "", api: "openai-completions", key: "session-123" },
    { baseUrl: "https://cli-chat-proxy.grok.com/v1", api: "openai-responses", key: "session-123" },
    { baseUrl: "https://proxy.example/v1", api: "openai-responses", key: undefined },
    {
      baseUrl: "https://api.x.ai/v1",
      api: "openai-responses",
      compat: { supportsPromptCacheKey: false },
      key: undefined,
    },
  ] as const)("preserves routing for $api at $baseUrl with $key", async (route) => {
    const normalized = applyXaiRuntimeModelCompat({
      id: "grok-4.3",
      name: "Grok",
      provider: "xai",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
      compat: "compat" in route ? route.compat : undefined,
      api: route.api,
      baseUrl: route.baseUrl,
    } satisfies Model);
    const model = { ...normalized, ...resolveXaiTransport(normalized) };
    let payload: unknown;
    const result = await streamSimple(
      model,
      { messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }] },
      {
        apiKey: "synthetic-unused-key",
        sessionId: "session-123",
        cacheRetention: "long",
        onPayload(value) {
          payload = value;
          throw new Error("captured before request");
        },
      },
    ).result();
    expect(result.errorMessage).toBe("captured before request");
    expect(payload).toMatchObject({ prompt_cache_key: route.key });
    expect(payload).not.toHaveProperty("prompt_cache_retention");
    expect(payload).not.toHaveProperty("prompt_cache_options");
  });
});
