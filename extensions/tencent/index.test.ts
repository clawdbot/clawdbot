// Tencent tests cover index plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import tencentPlugin from "./index.js";

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
  it("registers Tencent TokenHub api-key auth metadata", async () => {
    const { providers } = await registerTencentPlugin();
    const provider = requireRegisteredProvider(providers, "tencent-tokenhub");
    const resolved = resolveProviderPluginChoice({
      providers,
      choice: "tokenhub-api-key",
    });

    expect(provider.id).toBe("tencent-tokenhub");
    expect(provider.label).toBe("Tencent TokenHub");
    expect(provider.envVars).toEqual(["TOKENHUB_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Tencent TokenHub api-key auth choice");
    }
    expect(resolved.provider.id).toBe("tencent-tokenhub");
    expect(resolved.method.id).toBe("api-key");
  });

  it("registers Tencent TokenPlan api-key auth metadata", async () => {
    const { providers } = await registerTencentPlugin();
    const provider = requireRegisteredProvider(providers, "tencent-tokenplan");
    const resolved = resolveProviderPluginChoice({
      providers,
      choice: "tokenplan-api-key",
    });

    expect(provider.id).toBe("tencent-tokenplan");
    expect(provider.label).toBe("Tencent TokenPlan");
    expect(provider.envVars).toEqual(["TOKENPLAN_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Tencent TokenPlan api-key auth choice");
    }
    expect(resolved.provider.id).toBe("tencent-tokenplan");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the static Tencent TokenHub model catalog with reasoning flags", async () => {
    const provider = await getTokenHubProvider();
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://tokenhub.tencentmaas.com/v1");

    const modelIds = catalogProvider.models?.map((m) => m.id);
    expect(modelIds).toContain("hy3");
    expect(modelIds).toContain("hy3-preview");

    const hy3 = catalogProvider.models?.find((m) => m.id === "hy3");
    expect(hy3?.reasoning).toBe(true);
    expect(hy3?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3?.compat?.supportedReasoningEfforts).toEqual(["none", "high"]);

    const hy3Preview = catalogProvider.models?.find((m) => m.id === "hy3-preview");
    expect(hy3Preview?.reasoning).toBe(true);
    expect(hy3Preview?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3Preview?.compat?.supportedReasoningEfforts).toEqual(["none", "low", "high"]);
  });

  it("builds the static Tencent TokenPlan model catalog with reasoning flags", async () => {
    const provider = await getTokenPlanProvider();
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");

    const modelIds = catalogProvider.models?.map((m) => m.id);
    expect(modelIds).toEqual(["hy3"]);

    const hy3 = catalogProvider.models?.find((m) => m.id === "hy3");
    expect(hy3?.reasoning).toBe(true);
    expect(hy3?.compat?.supportsReasoningEffort).toBe(true);
    expect(hy3?.compat?.supportedReasoningEfforts).toEqual(["none", "high"]);
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
