import { getModels } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { registerProviderPlugin } from "../../test/helpers/plugins/provider-registration.js";
import { expectPassthroughReplayPolicy } from "../../test/helpers/provider-replay-policy.ts";
import plugin from "./index.js";

describe("opencode-go provider plugin", () => {
  it("registers image media understanding through the OpenCode Go plugin", async () => {
    const { mediaProviders } = await registerProviderPlugin({
      plugin,
      id: "opencode-go",
      name: "OpenCode Go Provider",
    });

    expect(mediaProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opencode-go",
          capabilities: ["image"],
          defaultModels: { image: "kimi-k2.6" },
          describeImage: expect.any(Function),
          describeImages: expect.any(Function),
        }),
      ]),
    );
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode-go",
      modelId: "qwen3-coder",
    });
  });

  it("keeps OpenCode Go catalog coverage aligned with upstream", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    expect(provider.catalog).toBeUndefined();

    const models = new Map(getModels("opencode-go").map((model) => [model.id, model]));
    expect([...models.keys()]).toEqual([
      "glm-5",
      "glm-5.1",
      "kimi-k2.5",
      "kimi-k2.6",
      "mimo-v2-omni",
      "mimo-v2-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m2.5",
      "minimax-m2.7",
      "qwen3.5-plus",
      "qwen3.6-plus",
    ]);
    const supplemental = await provider.augmentModelCatalog?.({
      entries: [...models.values()].map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
      })),
    } as never);
    expect(supplemental).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "opencode-go",
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
        }),
        expect.objectContaining({
          provider: "opencode-go",
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
        }),
      ]),
    );

    expect(models.get("kimi-k2.6")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 65_536,
    });
    expect(models.get("minimax-m2.7")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
      reasoning: true,
      contextWindow: 204_800,
      maxTokens: 131_072,
    });
    expect(models.get("mimo-v2-pro")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text"],
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 128_000,
    });
    expect(models.get("mimo-v2-omni")).toMatchObject({
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 128_000,
    });
    expect(
      provider.resolveDynamicModel?.({
        modelId: "deepseek-v4-pro",
      } as never),
    ).toMatchObject({
      id: "deepseek-v4-pro",
      api: "openai-completions",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    });
  });

  it("disables invalid DeepSeek V4 reasoning_effort off payloads on OpenCode Go", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedPayloads: Record<string, unknown>[] = [];
    const baseStreamFn = (_model: unknown, _context: unknown, options: unknown) => {
      const payload = {
        model: "deepseek-v4-flash",
        reasoning_effort: "off",
        reasoning: "off",
      };
      (options as { onPayload?: (payload: Record<string, unknown>) => void })?.onPayload?.(payload);
      capturedPayloads.push(payload);
      return {} as never;
    };

    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn as never,
      providerId: "opencode-go",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "off",
    } as never);

    expect(streamFn).toBeTypeOf("function");
    await streamFn?.(
      { provider: "opencode-go", id: "deepseek-v4-flash" } as never,
      {} as never,
      {},
    );

    expect(capturedPayloads).toEqual([
      {
        model: "deepseek-v4-flash",
        thinking: { type: "disabled" },
      },
    ]);
  });

  it("canonicalizes stale OpenCode Go base URLs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeConfig?.({
        provider: "opencode-go",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/go/v1/",
          models: [],
        },
      } as never),
    ).toMatchObject({
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(
      provider.normalizeResolvedModel?.({
        provider: "opencode-go",
        model: {
          provider: "opencode-go",
          id: "kimi-k2.5",
          name: "Kimi K2.5",
          api: "openai-completions",
          baseUrl: "https://opencode.ai/go/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262_144,
          maxTokens: 65_536,
        },
      } as never),
    ).toMatchObject({
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "opencode-go",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/go/v1",
      } as never),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(
      provider.normalizeTransport?.({
        provider: "opencode-go",
        api: "anthropic-messages",
        baseUrl: "https://opencode.ai/go",
      } as never),
    ).toEqual({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    });
  });
});
