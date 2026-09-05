// Moonshot tests cover index plugin behavior.
import fs from "node:fs";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { MOONSHOT_BASE_URL, MOONSHOT_CN_BASE_URL } from "./provider-catalog.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

type MoonshotManifest = {
  providerAuthAliases?: Record<string, string>;
  setup?: {
    providers?: Array<{
      id?: string;
      envVars?: string[];
    }>;
  };
};

function readManifest(): MoonshotManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as MoonshotManifest;
}

describe("moonshot provider plugin", () => {
  it.each([
    ["international", "moonshot", "kimi-k3", "openai-completions", MOONSHOT_BASE_URL, true],
    [
      "international slash",
      "moonshot",
      "kimi-k3",
      "openai-completions",
      `${MOONSHOT_BASE_URL}/`,
      true,
    ],
    ["China", "moonshot", "kimi-k3", "openai-completions", MOONSHOT_CN_BASE_URL, true],
    ["China slash", "moonshot", "kimi-k3", "openai-completions", `${MOONSHOT_CN_BASE_URL}/`, true],
    ["K2.7", "moonshot", "kimi-k2.7-code", "openai-completions", MOONSHOT_BASE_URL, false],
    ["K2.6", "moonshot", "kimi-k2.6", "openai-completions", MOONSHOT_BASE_URL, false],
    ["model alias", "moonshot", "moonshot/kimi-k3", "openai-completions", MOONSHOT_BASE_URL, false],
    ["unknown model", "moonshot", "kimi-k3-latest", "openai-completions", MOONSHOT_BASE_URL, false],
    ["Responses", "moonshot", "kimi-k3", "openai-responses", MOONSHOT_BASE_URL, false],
    ["proxy", "moonshot", "kimi-k3", "openai-completions", "https://proxy.example/v1", false],
    ["query", "moonshot", "kimi-k3", "openai-completions", `${MOONSHOT_BASE_URL}?x=1`, false],
    ["fragment", "moonshot", "kimi-k3", "openai-completions", `${MOONSHOT_BASE_URL}#x`, false],
    [
      "userinfo",
      "moonshot",
      "kimi-k3",
      "openai-completions",
      "https://u@api.moonshot.ai/v1",
      false,
    ],
    [
      "different path",
      "moonshot",
      "kimi-k3",
      "openai-completions",
      "https://api.moonshot.ai/v1/chat",
      false,
    ],
    ["HTTP", "moonshot", "kimi-k3", "openai-completions", "http://api.moonshot.ai/v1", false],
    ["provider alias", "moonshotai", "kimi-k3", "openai-completions", MOONSHOT_BASE_URL, false],
  ] as const)(
    "enables native video only for the exact %s route",
    async (_name, providerId, modelId, api, baseUrl, expected) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const model = {
        id: modelId,
        name: modelId,
        provider: providerId,
        api,
        baseUrl,
        reasoning: true,
        input: ["text", "image", "video"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 1_000_000,
      } as unknown as Model;
      const normalized = provider.normalizeResolvedModel?.({
        provider: providerId,
        modelId,
        model,
      } as never);

      expect(((normalized ?? model).input as string[]).includes("video")).toBe(expected);
    },
  );

  it("mirrors Kimi web-search env credentials in manifest metadata", () => {
    const manifestEnvVars =
      readManifest().setup?.providers?.find((provider) => provider.id === "moonshot")?.envVars ??
      [];

    expect([...manifestEnvVars].toSorted()).toStrictEqual(
      [...createKimiWebSearchProvider().envVars].toSorted(),
    );
  });

  it("declares shipped Moonshot provider aliases in runtime and manifest metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.aliases).toEqual(["moonshotai", "moonshot-ai"]);
    expect(readManifest().providerAuthAliases).toEqual({
      moonshotai: "moonshot",
      "moonshot-ai": "moonshot",
    });
  });

  it("rewrites duplicate tool-call ids with OpenAI-style ids for Moonshot replay", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const policy = provider.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-completions",
      modelId: "kimi-k2.6",
    } as never);

    expect(policy).toEqual({
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      duplicateToolCallIdStyle: "openai",
    });
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });

  it("wires moonshot-thinking stream hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedStream = createCapturedThinkingConfigStream();

    const wrapped = provider.wrapStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "off",
      streamFn: capturedStream.streamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "moonshot",
        id: "kimi-k2.6",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedStream.getCapturedPayload()).toEqual({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });
  });

  it.each(["kimi-k2.7-code", "kimi-k2.7-code-highspeed"])(
    "keeps %s thinking always on without sending a thinking field",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const capturedStream = createCapturedThinkingConfigStream();

      const wrapped = provider.wrapSimpleCompletionStreamFn?.({
        provider: "moonshot",
        modelId,
        thinkingLevel: "off",
        streamFn: capturedStream.streamFn,
      } as never);

      void wrapped?.(
        {
          api: "openai-completions",
          provider: "moonshot",
          id: modelId,
        } as Model<"openai-completions">,
        { messages: [] } as Context,
        {},
      );

      expect(capturedStream.getCapturedPayload()).toEqual({
        config: { thinkingConfig: { thinkingBudget: -1 } },
      });
      expect(
        provider.wrapSimpleCompletionStreamFn?.({
          provider: "moonshot",
          modelId: "kimi-k2.6",
          streamFn: capturedStream.streamFn,
        } as never),
      ).toBe(capturedStream.streamFn);
      expect(
        provider.resolveThinkingProfile?.({
          provider: "moonshot",
          modelId,
          reasoning: true,
        } as never),
      ).toEqual({
        levels: [{ id: "low", label: "on" }],
        defaultLevel: "low",
        preserveWhenCatalogReasoningFalse: true,
      });
      expect(
        provider.isModernModelRef?.({
          provider: "moonshot",
          modelId,
        }),
      ).toBe(true);
      expect(
        provider.isModernModelRef?.({
          provider: "moonshot",
          modelId: "kimi-k2.6",
        }),
      ).toBe(false);
    },
  );

  it("exposes Kimi K3 as an always-max-thinking modern model", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capturedStream = createCapturedThinkingConfigStream();

    const wrapped = provider.wrapSimpleCompletionStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k3",
      thinkingLevel: "off",
      streamFn: capturedStream.streamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        provider: "moonshot",
        id: "kimi-k3",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedStream.getCapturedPayload()).toEqual({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      reasoning_effort: "max",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "moonshot",
        modelId: "kimi-k3",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [{ id: "max", label: "max" }],
      defaultLevel: "max",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(provider.isModernModelRef?.({ provider: "moonshot", modelId: "kimi-k3" })).toBe(true);
  });
});
