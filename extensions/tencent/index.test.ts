// Tencent tests cover index plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  createRuntimeEnv,
  registerProviderPlugin,
  requireRegisteredProvider,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import tencentPlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type OpenAICompletionsModel = Model<"openai-completions">;

const registerTencentPlugin = () =>
  registerProviderPlugin({
    plugin: tencentPlugin,
    id: "tencent",
    name: "Tencent Cloud Provider",
  });

async function getTokenHubProvider() {
  const { providers } = await registerTencentPlugin();
  return requireRegisteredProvider(providers, "tencent-tokenhub");
}

async function getTokenPlanProvider() {
  const { providers } = await registerTencentPlugin();
  return requireRegisteredProvider(providers, "tencent-tokenplan");
}

function hyReasoningModel(params: {
  provider: "tencent-tokenhub" | "tencent-tokenplan";
  id: "hy3" | "hy3-preview";
  baseUrl: string;
  supportedReasoningEfforts?: string[];
}): OpenAICompletionsModel {
  return {
    provider: params.provider,
    id: params.id,
    name: params.id,
    api: "openai-completions",
    baseUrl: params.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 64_000,
    compat: {
      supportsUsageInStreaming: true,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: params.supportedReasoningEfforts ?? ["none", "high"],
    },
  } as OpenAICompletionsModel;
}

function captureTencentPayload(params: {
  provider: Pick<Awaited<ReturnType<typeof getTokenHubProvider>>, "wrapStreamFn">;
  model: OpenAICompletionsModel;
  reasoning: string;
}) {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (_model, context, options) => {
    const payload = buildOpenAICompletionsParams(
      _model as OpenAICompletionsModel,
      context,
      options as Parameters<typeof buildOpenAICompletionsParams>[2],
    );
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = params.provider.wrapStreamFn?.({
    streamFn: baseStreamFn,
    provider: params.model.provider,
    modelId: params.model.id,
    model: params.model,
    thinkingLevel: "high",
  });
  if (!wrapped) {
    throw new Error("expected Tencent provider stream wrapper");
  }
  void wrapped(
    params.model,
    { messages: [] } as never,
    {
      reasoning: params.reasoning,
    } as never,
  );
  return captured;
}

describe("tencent provider plugin", () => {
  it.each([
    ["tencent-tokenhub", "Tencent TokenHub", "TOKENHUB_API_KEY", "tokenhub-api-key"],
    ["tencent-tokenplan", "Tencent TokenPlan", "TOKENPLAN_API_KEY", "tokenplan-api-key"],
  ])("registers %s api-key auth metadata", async (providerId, label, envVar, choiceId) => {
    const { providers } = await registerTencentPlugin();
    const provider = requireRegisteredProvider(providers, providerId);
    const resolved = resolveProviderPluginChoice({ providers, choice: choiceId });

    expect(providers.map((entry) => entry.id)).toEqual(["tencent-tokenhub", "tencent-tokenplan"]);
    expect(provider).toMatchObject({
      id: providerId,
      label,
      docsPath: "/providers/tencent",
      envVars: [envVar],
      catalog: { order: "simple" },
      staticCatalog: { order: "simple" },
    });
    expect(provider.auth).toHaveLength(1);
    expect(resolved?.provider.id).toBe(providerId);
    expect(resolved?.method).toMatchObject({
      id: "api-key",
      label,
      hint: `Hy via ${label} Gateway`,
      kind: "api_key",
      starterModel: `${providerId}/hy3`,
      wizard: {
        choiceId,
        choiceLabel: label,
        groupId: "tencent",
        groupLabel: "Tencent Cloud",
        groupHint: label,
      },
    });
  });

  it.each(
    (
      [
        {
          providerId: "tencent-tokenhub",
          choiceId: "tokenhub-api-key",
          flagValue: "tokenhub-test-key",
          envVar: "TOKENHUB_API_KEY",
          aliases: {
            "tencent-tokenhub/hy3": { alias: "Hy3 (TokenHub)" },
            "tencent-tokenhub/hy3-preview": { alias: "Hy3 preview (TokenHub)" },
          },
        },
        {
          providerId: "tencent-tokenplan",
          choiceId: "tokenplan-api-key",
          flagValue: "tokenplan-test-key",
          envVar: "TOKENPLAN_API_KEY",
          aliases: { "tencent-tokenplan/hy3": { alias: "Hy3 (TokenPlan)" } },
        },
      ] as const
    ).flatMap((provider) =>
      ([undefined, "replace"] as const).map((mode) => Object.assign({}, provider, { mode })),
    ),
  )(
    "configures only $providerId through its registered auth method in $mode mode",
    async ({ providerId, choiceId, flagValue, envVar, aliases, mode }) => {
      const { providers } = await registerTencentPlugin();
      const provider = requireRegisteredProvider(providers, providerId);
      const resolveApiKey = vi.fn(async () => ({
        key: "stored-test-key",
        source: "profile" as const,
      }));
      const toApiKeyCredential = vi.fn(() => null);
      const method = provider.auth[0];
      if (!method?.runNonInteractive) {
        throw new Error("expected Tencent noninteractive auth method");
      }
      const config = await method.runNonInteractive({
        authChoice: choiceId,
        config: { models: { mode } },
        baseConfig: { models: { mode } },
        opts: { tokenhubApiKey: "tokenhub-test-key", tokenplanApiKey: "tokenplan-test-key" },
        runtime: createRuntimeEnv(),
        resolveApiKey,
        toApiKeyCredential,
      });

      expect(resolveApiKey).toHaveBeenCalledExactlyOnceWith({
        provider: providerId,
        flagValue,
        flagName: `--${choiceId}`,
        envVar,
      });
      expect(toApiKeyCredential).not.toHaveBeenCalled();
      expect(Object.keys(config?.models?.providers ?? {})).toEqual([providerId]);
      expect(config?.models?.providers?.[providerId]?.models.map((model) => model.id)).toEqual(
        mode === "replace"
          ? manifest.modelCatalog.providers[providerId].models.map((model) => model.id)
          : [],
      );
      expect(config?.agents?.defaults?.model).toEqual({ primary: `${providerId}/hy3` });
      expect(config?.agents?.defaults?.models).toEqual(aliases);
    },
  );

  it.each(["tencent-tokenhub", "tencent-tokenplan"])(
    "isolates %s static and augmented catalog results",
    async (providerId) => {
      const { providers } = await registerTencentPlugin();
      const provider = requireRegisteredProvider(providers, providerId);
      const first = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
      const expected = structuredClone(first);
      const model = first.models[0];
      if (!model) {
        throw new Error("expected Tencent static model");
      }
      model.input.push("image");
      model.cost.input = 999;
      expect(await runSingleProviderCatalog({ catalog: provider.staticCatalog })).toEqual(expected);

      const context = { env: {}, entries: [] };
      const augmented = await provider.augmentModelCatalog?.(context);
      expect(augmented?.map((entry) => entry.id)).toEqual(expected.models.map((entry) => entry.id));
      if (!augmented?.[0]?.input) {
        throw new Error("expected Tencent model input modalities");
      }
      const expectedAugmented = structuredClone(augmented);
      augmented[0].input.push("image");
      expect(await provider.augmentModelCatalog?.(context)).toEqual(expectedAugmented);
    },
  );

  it("builds the static Tencent TokenHub model catalog with reasoning flags", async () => {
    const provider = await getTokenHubProvider();
    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://tokenhub.tencentmaas.com/v1");

    const modelIds = catalogProvider.models?.map((m) => m.id);
    expect(modelIds).toContain("hy3");
    expect(modelIds).toContain("hy3-preview");

    const hy3 = catalogProvider.models?.find((m) => m.id === "hy3");
    expect(hy3?.reasoning).toBe(true);
    expect(hy3?.maxTokens).toBe(128_000);
    expect(hy3?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3?.compat?.supportedReasoningEfforts).toEqual(["none", "low", "high"]);

    const hy3Preview = catalogProvider.models?.find((m) => m.id === "hy3-preview");
    expect(hy3Preview?.reasoning).toBe(true);
    expect(hy3Preview?.maxTokens).toBe(128_000);
    expect(hy3Preview?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3Preview?.compat?.supportedReasoningEfforts).toEqual(["none", "low", "high"]);

    const manifestRows = manifest.modelCatalog.providers["tencent-tokenhub"].models as Array<
      Record<string, unknown>
    >;
    expect(manifestRows.find((model) => model.id === "hy3-preview")).toMatchObject({
      status: "deprecated",
      replacedBy: "hy3",
    });
  });

  it("builds the static Tencent TokenPlan model catalog with reasoning flags", async () => {
    const provider = await getTokenPlanProvider();
    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");

    const modelIds = catalogProvider.models?.map((m) => m.id);
    expect(modelIds).toEqual(["hy3"]);

    const hy3 = catalogProvider.models?.find((m) => m.id === "hy3");
    expect(hy3?.reasoning).toBe(true);
    expect(hy3?.maxTokens).toBe(128_000);
    expect(hy3?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3?.compat?.supportedReasoningEfforts).toEqual(["none", "low", "high"]);
  });

  it("injects reasoning_effort into TokenPlan hy3 chat-completions payload", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenplan",
      id: "hy3",
      baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, {
      reasoning: "high",
    } as never);

    expect(payload.model).toBe("hy3");
    expect(payload.reasoning_effort).toBe("high");
  });

  it("emits reasoning_effort=high when high effort is requested for TokenHub hy3", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, {
      reasoning: "high",
    } as never);

    expect(payload.reasoning_effort).toBe("high");
  });

  it("emits reasoning_effort=none when none effort is requested for TokenHub hy3", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, {
      reasoning: "none",
    } as never);

    expect(payload.reasoning_effort).toBe("none");
  });

  it("defaults hy3-preview reasoning_effort to high when no effort is provided", async () => {
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3-preview",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
      supportedReasoningEfforts: ["none", "low", "high"],
    });
    const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as Context;

    const payload = buildOpenAICompletionsParams(model, context, undefined);

    expect(payload.reasoning_effort).toBe("high");
  });

  it("preserves low reasoning_effort for TokenHub hy3-preview", async () => {
    const provider = await getTokenHubProvider();
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3-preview",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
      supportedReasoningEfforts: ["none", "low", "high"],
    });

    const payload = captureTencentPayload({
      provider,
      model,
      reasoning: "low",
    });

    expect(payload?.reasoning_effort).toBe("low");
  });

  it("keeps TokenHub hy3 explicit high and none reasoning_effort unchanged", async () => {
    const provider = await getTokenHubProvider();
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
    });

    const highPayload = captureTencentPayload({
      provider,
      model,
      reasoning: "high",
    });
    const nonePayload = captureTencentPayload({
      provider,
      model,
      reasoning: "none",
    });

    expect(highPayload?.reasoning_effort).toBe("high");
    expect(nonePayload?.reasoning_effort).toBe("none");
  });

  it("keeps minimal reasoning enabled for TokenHub and TokenPlan hy3", async () => {
    const tokenHubProvider = await getTokenHubProvider();
    const tokenPlanProvider = await getTokenPlanProvider();
    const tokenHubModel = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
    });
    const tokenPlanModel = hyReasoningModel({
      provider: "tencent-tokenplan",
      id: "hy3",
      baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    });

    const tokenHubPayload = captureTencentPayload({
      provider: tokenHubProvider,
      model: tokenHubModel,
      reasoning: "minimal",
    });
    const tokenPlanPayload = captureTencentPayload({
      provider: tokenPlanProvider,
      model: tokenPlanModel,
      reasoning: "minimal",
    });

    expect(tokenHubPayload?.reasoning_effort).toBe("high");
    expect(tokenPlanPayload?.reasoning_effort).toBe("high");
  });

  it("keeps TokenHub hy3-preview unsupported efforts on the model fallback path", async () => {
    const provider = await getTokenHubProvider();
    const model = hyReasoningModel({
      provider: "tencent-tokenhub",
      id: "hy3-preview",
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
      supportedReasoningEfforts: ["none", "low", "high"],
    });

    const minimalPayload = captureTencentPayload({
      provider,
      model,
      reasoning: "minimal",
    });
    const mediumPayload = captureTencentPayload({
      provider,
      model,
      reasoning: "medium",
    });

    expect(minimalPayload?.reasoning_effort).toBe("low");
    expect(mediumPayload?.reasoning_effort).toBe("low");
  });
});
