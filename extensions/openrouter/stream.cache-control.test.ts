import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
// Plugin-boundary coverage: OpenRouter Anthropic cache_control via wrapOpenRouterProviderStream.
import { afterEach, describe, expect, it } from "vitest";
import { wrapOpenRouterProviderStream } from "./stream.js";

const ORIGINAL_CACHE_RETENTION_ENV = process.env.OPENCLAW_CACHE_RETENTION;

function restoreCacheRetentionEnv(): void {
  if (ORIGINAL_CACHE_RETENTION_ENV === undefined) {
    delete process.env.OPENCLAW_CACHE_RETENTION;
  } else {
    process.env.OPENCLAW_CACHE_RETENTION = ORIGINAL_CACHE_RETENTION_ENV;
  }
}

function captureViaRegisteredPluginStream(params: {
  model: Record<string, unknown>;
  payload: Record<string, unknown>;
  options?: Record<string, unknown>;
  extraParams?: Record<string, unknown>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (model, _context, options) => {
    const body = structuredClone(params.payload);
    options?.onPayload?.(body, model);
    captured = body;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = wrapOpenRouterProviderStream({
    streamFn: baseStreamFn,
    modelId: String(params.model.id ?? ""),
    thinkingLevel: undefined,
    extraParams: params.extraParams,
  } as never);

  if (!wrapped) {
    throw new Error("wrapOpenRouterProviderStream returned null/undefined");
  }

  void wrapped(params.model as never, { messages: [] } as never, (params.options ?? {}) as never);
  return captured;
}

describe("wrapOpenRouterProviderStream — Anthropic cache_control (plugin path)", () => {
  afterEach(restoreCacheRetentionEnv);

  it("stamps 1h TTL on verified default route under OPENCLAW_CACHE_RETENTION=long", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const captured = captureViaRegisteredPluginStream({
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
      },
      payload: {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
      },
    });

    expect(captured.messages).toEqual([
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "You are a helpful assistant.",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
      { role: "user", content: "Hello" },
    ]);
  });

  it("stamps 1h TTL on concrete openrouter.ai baseUrl under env long", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const captured = captureViaRegisteredPluginStream({
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      payload: {
        messages: [{ role: "system", content: "sys" }],
      },
    });
    const messages = captured.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("honors explicit cacheRetention long without env", () => {
    const captured = captureViaRegisteredPluginStream({
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-opus-4-6",
      },
      payload: {
        messages: [{ role: "system", content: "sys" }],
      },
      options: { cacheRetention: "long" },
    });
    const messages = captured.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
  });

  it("does not mark non-Anthropic models", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const initial = {
      messages: [{ role: "system", content: "sys" }],
    };
    const captured = captureViaRegisteredPluginStream({
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "google/gemini-2.5-pro",
      },
      payload: initial,
    });
    expect(captured).toEqual(initial);
  });

  it("does not mark custom proxy hosts (unverified route)", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const initial = {
      messages: [{ role: "system", content: "sys" }],
    };
    const captured = captureViaRegisteredPluginStream({
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
        baseUrl: "https://proxy.example.test/v1",
      },
      payload: initial,
    });
    expect(captured).toEqual(initial);
  });

  it("skips markers when cacheRetention is none", () => {
    process.env.OPENCLAW_CACHE_RETENTION = "long";
    const captured = captureViaRegisteredPluginStream({
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
      },
      payload: {
        messages: [{ role: "system", content: "sys" }],
      },
      options: { cacheRetention: "none" },
    });
    const messages = captured.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toBe("sys");
  });
});
