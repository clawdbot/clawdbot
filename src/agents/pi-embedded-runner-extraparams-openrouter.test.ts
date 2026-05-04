import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExtraParamsPayloadCase } from "./pi-embedded-runner-extraparams.test-support.js";
import {
  applyExtraParamsToAgent,
  __testing as extraParamsTesting,
} from "./pi-embedded-runner/extra-params.js";
import {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  isProxyReasoningUnsupported,
} from "./pi-embedded-runner/proxy-stream-wrappers.js";

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: ({ context }) => context.extraParams,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => {
      if (params.provider !== "openrouter") {
        return params.context.streamFn;
      }

      const providerRouting =
        params.context.extraParams?.provider != null &&
        typeof params.context.extraParams.provider === "object"
          ? (params.context.extraParams.provider as Record<string, unknown>)
          : undefined;
      let streamFn = params.context.streamFn;
      if (providerRouting) {
        const underlying = streamFn;
        streamFn = (model, context, options) =>
          (underlying as StreamFn)(
            {
              ...model,
              compat: { ...model.compat, openRouterRouting: providerRouting },
            },
            context,
            options,
          );
      }

      const skipReasoningInjection =
        params.context.modelId === "auto" || isProxyReasoningUnsupported(params.context.modelId);
      const thinkingLevel = skipReasoningInjection ? undefined : params.context.thinkingLevel;
      return createOpenRouterSystemCacheWrapper(
        createOpenRouterWrapper(streamFn, thinkingLevel, params.context.extraParams),
      );
    },
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent OpenRouter reasoning", () => {
  it("does not inject reasoning when thinkingLevel is off (default) for OpenRouter", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "deepseek/deepseek-r1",
      thinkingLevel: "off",
      payload: { model: "deepseek/deepseek-r1" },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("forwards opt-in response cache params as OpenRouter headers", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            models: {
              "openrouter/auto": {
                params: {
                  responseCache: true,
                  responseCacheTtlSeconds: 600,
                },
              },
            },
          },
        },
      },
      "openrouter",
      "auto",
    );

    void agent.streamFn?.(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(calls[0]?.headers).toMatchObject({
      "X-OpenRouter-Cache": "true",
      "X-OpenRouter-Cache-TTL": "600",
    });
  });

  it("honors narrower camelCase response cache params over wider snake_case aliases", () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            params: {
              response_cache: false,
              response_cache_ttl_seconds: 60,
              response_cache_clear: false,
            },
            models: {
              "openrouter/auto": {
                params: {
                  responseCache: true,
                  responseCacheTtlSeconds: 600,
                  responseCacheClear: true,
                },
              },
            },
          },
        },
      },
      "openrouter",
      "auto",
    );

    void agent.streamFn?.(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(calls[0]?.headers).toMatchObject({
      "X-OpenRouter-Cache": "true",
      "X-OpenRouter-Cache-Clear": "true",
      "X-OpenRouter-Cache-TTL": "600",
    });
  });

  it("injects reasoning.effort when thinkingLevel is non-off for OpenRouter", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "openrouter/auto",
      thinkingLevel: "low",
    });

    expect(payload.reasoning).toEqual({ effort: "low" });
  });

  it("removes legacy reasoning_effort and keeps reasoning unset when thinkingLevel is off", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "openrouter/auto",
      thinkingLevel: "off",
      payload: { reasoning_effort: "high" },
    });

    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("reasoning");
  });

  it("does not inject effort when payload already has reasoning.max_tokens", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "openrouter/auto",
      thinkingLevel: "low",
      payload: { reasoning: { max_tokens: 256 } },
    });

    expect(payload).toEqual({ reasoning: { max_tokens: 256 } });
  });

  it("does not inject reasoning.effort for x-ai/grok models on OpenRouter (#32039)", () => {
    const payload = runExtraParamsPayloadCase({
      provider: "openrouter",
      modelId: "x-ai/grok-4.1-fast",
      thinkingLevel: "medium",
      payload: { reasoning_effort: "medium" },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
