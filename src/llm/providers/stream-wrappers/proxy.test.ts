// Proxy stream wrapper tests cover wrapper selection and provider passthrough.
import { buildOpenAICompletionsParams } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../../../packages/ai/src/utils/system-prompt-cache-boundary.js";
import { createOpenRouterSystemCacheWrapper, createOpenRouterWrapper } from "./proxy.js";

function runSystemCacheWrapper(model: Partial<Model<"openai-completions">>) {
  const payload = {
    messages: [{ role: "system", content: "system prompt" }],
  };
  const baseStreamFn: StreamFn = (resolvedModel, context, options) => {
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
    const baseStreamFn: StreamFn = (model, context, options) => {
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
    const baseStreamFn: StreamFn = (model, context, options) => {
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
    const baseStreamFn: StreamFn = (model, context, options) => {
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
    const baseStreamFn: StreamFn = (model, context, options) => {
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
    const baseStreamFn: StreamFn = (model, context, options) => {
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

  it.each([
    { cacheRetention: "none", requiresStringContent: false },
    { cacheRetention: "short", requiresStringContent: false },
    { cacheRetention: "long", requiresStringContent: false },
    { cacheRetention: "short", requiresStringContent: true },
  ] as const)(
    "composes managed requests with $cacheRetention retention and string-only=$requiresStringContent",
    ({ cacheRetention, requiresStringContent }) => {
      const model: Model<"openai-completions"> & {
        compat: { requiresStringContent: boolean };
      } = {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude",
        baseUrl: "https://openrouter.ai/api/v1",
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
      for (const stable of ["STABLE", ""]) {
        for (const hasUser of [true, false]) {
          void createOpenRouterSystemCacheWrapper(base, { cacheRetention })(model, {
            systemPrompt: `${stable}${SYSTEM_PROMPT_CACHE_BOUNDARY}VOLATILE`,
            messages: [
              ...(hasUser ? [{ role: "user" as const, content: "Question", timestamp: 1 }] : []),
              { role: "user", content: "Runtime", timestamp: 2, runtimeContextCarrier: true },
            ],
          });
          const wire = JSON.stringify(payload);
          expect(wire.match(/"cache_control":/g) ?? []).toHaveLength(
            cacheRetention === "none" || requiresStringContent
              ? 0
              : Number(Boolean(stable)) + Number(hasUser),
          );
          expect(wire).not.toContain('"text":"VOLATILE","cache_control"');
          expect(wire).not.toContain('"text":"Runtime","cache_control"');
          if (requiresStringContent) {
            expect(payload.messages).toEqual([
              { role: "system", content: `${stable}\nVOLATILE` },
              ...(hasUser ? [{ role: "user", content: "Question" }] : []),
              { role: "user", content: "Runtime" },
            ]);
          }
          expect(wire.includes('"ttl":"1h"')).toBe(
            cacheRetention === "long" && Boolean(stable || hasUser),
          );
        }
      }
    },
  );

  it("preserves native Anthropic Messages payloads", () => {
    const model: Model<"anthropic-messages"> = {
      api: "anthropic-messages",
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4-6",
      name: "Claude",
      baseUrl: "https://openrouter.ai/api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };
    const original = {
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "question" }] }],
    };
    const payload = structuredClone(original);
    const base: StreamFn = (resolvedModel, _context, options) => {
      options?.onPayload?.(payload, resolvedModel);
      return createAssistantMessageEventStream();
    };
    void createOpenRouterSystemCacheWrapper(base)(
      model,
      { messages: [] },
      { cacheRetention: "long" },
    );
    expect(payload).toEqual(original);
  });

  it("forwards OpenRouter Anthropic cacheRetention to the underlying transport", () => {
    const payload = {
      messages: [{ role: "system", content: "system prompt" }],
    };
    const calls: Array<{ cacheRetention?: unknown }> = [];
    const baseStreamFn: StreamFn = (resolvedModel, _context, options) => {
      calls.push({ cacheRetention: options?.cacheRetention });
      options?.onPayload?.(payload, resolvedModel);
      return createAssistantMessageEventStream();
    };

    const wrapped = createOpenRouterSystemCacheWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "anthropic/claude-sonnet-4.6",
      } as Model<"openai-completions">,
      { messages: [] },
      { cacheRetention: "long" },
    );

    expect(calls[0]).toEqual({ cacheRetention: "long" });
    expect(payload.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "system prompt",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
  });
});
