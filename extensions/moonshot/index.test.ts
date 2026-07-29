// Moonshot tests cover index plugin behavior.
import fs from "node:fs";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
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

  it("preserves responses-family replay behavior", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const policy = provider.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-responses",
      modelId: "kimi-k2.6",
    } as never);

    expect(policy).toEqual({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
    });
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
