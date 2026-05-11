import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
} from "./proxy-stream-wrappers.js";

function runSystemCacheWrapper(model: Partial<Model<"openai-completions">>) {
  const payload = {
    messages: [{ role: "system", content: "system prompt" }],
  };
  const baseStreamFn: StreamFn = (resolvedModel, _context, options) => {
    options?.onPayload?.(payload, resolvedModel);
    return createAssistantMessageEventStream();
  };

  const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
  void wrapped(
    {
      api: "openai-completions",
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.6",
      ...model,
    } as Model<"openai-completions">,
    { messages: [] },
    {},
  );

  return payload;
}

describe("proxy stream wrappers", () => {
  it("adds OpenRouter attribution headers to stream options", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({
        headers: options?.headers,
      });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn);
    const model = {
      api: "openai-completions",
      provider: "openrouter",
      id: "openrouter/auto",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void wrapped(model, context, { headers: { "X-Custom": "1" } });

    expect(calls).toEqual([
      {
        headers: {
          "HTTP-Referer": "https://openclaw.ai",
          "X-OpenRouter-Title": "OpenClaw",
          "X-OpenRouter-Categories":
            "cli-agent,cloud-agent,programming-app,creative-writing,writing-assistant,general-chat,personal-agent",
          "X-Custom": "1",
        },
      },
    ]);
  });

  it("adds opt-in OpenRouter response caching headers", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn, undefined, {
      responseCache: true,
      responseCacheTtlSeconds: 900,
    });

    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/auto",
        baseUrl: "https://openrouter.ai/api/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(calls[0]?.headers?.["HTTP-Referer"]).toBe("https://openclaw.ai");
    expect(calls[0]?.headers?.["X-OpenRouter-Cache"]).toBe("true");
    expect(calls[0]?.headers?.["X-OpenRouter-Cache-TTL"]).toBe("900");
  });

  it("sends OpenRouter response cache disables for preset opt-outs", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn, undefined, {
      response_cache: false,
      response_cache_ttl_seconds: 600,
    });

    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/@preset/cached-tests",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(calls[0]?.headers?.["X-OpenRouter-Cache"]).toBe("false");
    expect(calls[0]?.headers).not.toHaveProperty("X-OpenRouter-Cache-TTL");
  });

  it("supports OpenRouter response cache refresh and TTL clamping", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn, undefined, {
      response_cache_clear: "true",
      response_cache_ttl: 999999,
    });

    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/auto",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(calls[0]?.headers?.["X-OpenRouter-Cache"]).toBe("true");
    expect(calls[0]?.headers?.["X-OpenRouter-Cache-Clear"]).toBe("true");
    expect(calls[0]?.headers?.["X-OpenRouter-Cache-TTL"]).toBe("86400");
  });

  it("does not add OpenRouter response caching headers to custom proxy routes", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterWrapper(baseStreamFn, undefined, {
      responseCache: true,
    });

    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/auto",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(calls[0]?.headers).toBeUndefined();
  });

  it("injects cache_control markers for declared OpenRouter Anthropic models on the default route", () => {
    const payload = runSystemCacheWrapper({});

    expect(payload.messages[0]?.content).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not inject cache_control markers for declared OpenRouter providers on custom proxy URLs", () => {
    const payload = runSystemCacheWrapper({
      baseUrl: "https://proxy.example.com/v1",
    });

    expect(payload.messages[0]?.content).toBe("system prompt");
  });

  it("does not inject Anthropic cache_control markers for automatic OpenRouter DeepSeek cache models", () => {
    const payload = runSystemCacheWrapper({
      id: "deepseek/deepseek-v3.2",
    });

    expect(payload.messages[0]?.content).toBe("system prompt");
  });

  it("injects cache_control markers for native OpenRouter hosts behind custom provider ids", () => {
    const payload = runSystemCacheWrapper({
      provider: "custom-openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(payload.messages[0]?.content).toEqual([
      { type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
    ]);
  });
});
