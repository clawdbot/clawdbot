import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";
import {
  buildOpenrouterProvider,
  isOpenRouterProxyReasoningUnsupportedModel,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("openrouter provider hooks", () => {
  it("registers OpenRouter speech alongside model and media providers", async () => {
    const { providers, speechProviders, mediaProviders, imageProviders, videoProviders } =
      await registerProviderPlugin({
        plugin: openrouterPlugin,
        id: "openrouter",
        name: "OpenRouter Provider",
      });

    expect(providers).toEqual([expect.objectContaining({ id: "openrouter" })]);
    expect(speechProviders).toEqual([expect.objectContaining({ id: "openrouter" })]);
    expect(mediaProviders).toEqual([expect.objectContaining({ id: "openrouter" })]);
    expect(imageProviders).toEqual([expect.objectContaining({ id: "openrouter" })]);
    expect(videoProviders).toEqual([expect.objectContaining({ id: "openrouter" })]);
  });

  it("includes Kimi K2.6 in the bundled catalog", () => {
    expect(buildOpenrouterProvider().models?.map((model) => model.id)).toContain(
      "moonshotai/kimi-k2.6",
    );
  });

  it("does not include retired stealth models in the bundled catalog", () => {
    expect(buildOpenrouterProvider().models?.map((model) => model.id)).not.toEqual(
      expect.arrayContaining(["openrouter/hunter-alpha", "openrouter/healer-alpha"]),
    );
  });

  it("keeps stale Hunter Alpha configs out of OpenRouter proxy reasoning", () => {
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/hunter-alpha")).toBe(true);
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/hunter-alpha:free")).toBe(true);
    expect(isOpenRouterProxyReasoningUnsupportedModel("openrouter/healer-alpha")).toBe(false);
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin: openrouterPlugin,
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
    });
  });

  it("owns native reasoning output mode", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe("native");
  });

  it("advertises xhigh thinking for OpenRouter-routed DeepSeek V4 models", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const expectedV4Levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
        } as never)
        ?.levels.map((level) => level.id),
    ).toEqual(expectedV4Levels);
    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-flash",
      } as never)?.defaultLevel,
    ).toBe("high");
    expect(
      provider.supportsXHighThinking?.({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-pro",
      } as never),
    ).toBe(true);
    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
      } as never),
    ).toBe(undefined);
  });

  it("exposes DeepSeek V4 thinking levels through the lightweight policy artifact", () => {
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "openrouter/deepseek/deepseek-v4-pro",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
      }),
    ).toBe(undefined);
  });

  it("canonicalizes stale OpenRouter /v1 config and runtime metadata", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "openrouter",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1/",
          models: [],
        },
      } as never),
    ).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        model: {
          provider: "openrouter",
          id: "openai/gpt-5.4",
          name: "openai/gpt-5.4",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      } as never),
    ).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
    });

    expect(
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        model: {
          provider: "openrouter",
          id: "openrouter/hunter-alpha",
          name: "Hunter Alpha",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        },
      } as never),
    ).toMatchObject({
      reasoning: false,
    });

    expect(
      provider.normalizeTransport?.({
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const baseStreamFn = vi.fn(
      (..._args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>) =>
        ({ async *[Symbol.asyncIterator]() {} }) as never,
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openai/gpt-5.4",
      extraParams: {
        provider: {
          order: ["moonshot"],
        },
      },
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openai/gpt-5.4",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const firstCall = baseStreamFn.mock.calls[0];
    const firstModel = firstCall?.[0];
    expect(firstModel).toMatchObject({
      compat: {
        openRouterRouting: {
          order: ["moonshot"],
        },
      },
    });
  });

  it("does not inject OpenRouter reasoning for Hunter Alpha", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>
      ): ReturnType<import("@mariozechner/pi-agent-core").StreamFn> => {
        void args[2]?.onPayload?.({}, args[0]);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/hunter-alpha",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/hunter-alpha",
        compat: {},
      } as never,
      { messages: [] } as never,
      {
        onPayload: (payload: unknown) => {
          capturedPayload = payload as Record<string, unknown>;
          return payload;
        },
      } as never,
    );

    expect(capturedPayload).toEqual({});
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("fills DeepSeek V4 reasoning_content for OpenRouter replay turns", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>
      ): ReturnType<import("@mariozechner/pi-agent-core").StreamFn> => {
        const payload = {
          messages: [
            { role: "user", content: "read file" },
            { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
            { role: "tool", content: "ok" },
            { role: "assistant", content: "done" },
          ],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      streamFn: baseStreamFn,
      thinkingLevel: "xhigh",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "deepseek/deepseek-v4-flash",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      messages: [
        { role: "user", content: "read file" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function" }],
          reasoning_content: "",
        },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "done", reasoning_content: "" },
      ],
    });
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("recognizes full OpenRouter DeepSeek V4 refs but skips custom proxy routes", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>
      ): ReturnType<import("@mariozechner/pi-agent-core").StreamFn> => {
        const payload = {
          messages: [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] }],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        payloads.push(payload);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const fullRef = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "openrouter/deepseek/deepseek-v4-pro",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void fullRef?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "openrouter/deepseek/deepseek-v4-pro",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    const customRoute = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void customRoute?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "deepseek/deepseek-v4-pro",
        baseUrl: "https://proxy.example.com/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(payloads[0]?.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [{ id: "call_1", type: "function" }],
        reasoning_content: "",
      },
    ]);
    expect(payloads[1]?.messages).toEqual([
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
    ]);
  });

  it("strips OpenRouter-routed Anthropic assistant prefill when reasoning is enabled", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>
      ): ReturnType<import("@mariozechner/pi-agent-core").StreamFn> => {
        const payload = {
          messages: [
            { role: "user", content: "Return JSON." },
            { role: "assistant", content: "{" },
          ],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        capturedPayload = payload;
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.6",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrapped?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "anthropic/claude-opus-4.6",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(capturedPayload).toMatchObject({
      messages: [{ role: "user", content: "Return JSON." }],
      reasoning: { effort: "high" },
    });
    expect(baseStreamFn).toHaveBeenCalledOnce();
  });

  it("keeps OpenRouter Anthropic prefill when reasoning is disabled or the route is custom", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn = vi.fn(
      (
        ...args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>
      ): ReturnType<import("@mariozechner/pi-agent-core").StreamFn> => {
        const payload = {
          messages: [
            { role: "user", content: "Return JSON." },
            { role: "assistant", content: "{" },
          ],
        };
        void args[2]?.onPayload?.(payload, args[0]);
        payloads.push(payload);
        return { async *[Symbol.asyncIterator]() {} } as never;
      },
    );

    const disabled = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.6",
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);
    void disabled?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "anthropic/claude-opus-4.6",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    const customRoute = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.6",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);
    void customRoute?.(
      {
        provider: "openrouter",
        api: "openai-completions",
        id: "anthropic/claude-opus-4.6",
        baseUrl: "https://proxy.example.com/v1",
        compat: {},
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.messages).toHaveLength(2);
    expect(payloads[0]).not.toHaveProperty("reasoning");
    expect(payloads[1]?.messages).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ reasoning: { effort: "high" } });
  });
});
