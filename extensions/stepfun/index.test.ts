// Stepfun tests cover index plugin behavior.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import stepfunPlugin from "./index.js";
import {
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  buildStepFunPlanProvider,
  buildStepFunProvider,
} from "./provider-catalog.js";

type StepFunManifest = {
  setup?: {
    providers?: Array<{
      id?: string;
      authMethods?: string[];
      envVars?: string[];
    }>;
  };
  providerAuthChoices?: Array<{
    provider?: string;
    method?: string;
    choiceId?: string;
  }>;
};

function readManifest(): StepFunManifest {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"));
}

describe("stepfun provider registration", () => {
  it("adds Step 3.7 Flash without changing existing defaults", () => {
    const standard = buildStepFunProvider();
    const plan = buildStepFunPlanProvider();
    const standardModel = standard.models?.find((model) => model.id === "step-3.7-flash");
    const planModel = plan.models?.find((model) => model.id === "step-3.7-flash");
    if (!standardModel) {
      throw new Error("StepFun Standard catalog did not provide Step 3.7 Flash");
    }

    expect(STEPFUN_DEFAULT_MODEL_REF).toBe("stepfun/step-3.5-flash");
    expect(STEPFUN_PLAN_DEFAULT_MODEL_REF).toBe("stepfun-plan/step-3.5-flash");
    expect(
      standard.models?.find((model) => model.id === "step-3.5-flash")?.compat
        ?.supportsReasoningEffort,
    ).not.toBe(true);
    expect(standardModel).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "high", max: "high" },
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        supportsReasoningEffort: true,
        supportsStrictMode: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
        maxTokensField: "max_tokens",
        reasoningEffortMap: expect.objectContaining({ off: "low", medium: "medium", max: "high" }),
      },
    });
    expect(planModel).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "high", max: "high" },
      contextWindow: 262144,
      maxTokens: 262144,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        supportsReasoningEffort: true,
        supportsStrictMode: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
        maxTokensField: "max_tokens",
        reasoningEffortMap: expect.objectContaining({ off: "low", medium: "medium", max: "high" }),
      },
    });

    const transportModel = {
      ...standardModel,
      provider: "stepfun",
      api: "openai-completions",
      baseUrl: standard.baseUrl,
    } as Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as Context;
    const offReasoning = standardModel.thinkingLevelMap?.off;
    expect(offReasoning).toBe("low");
    const lowPayload = buildOpenAICompletionsParams(transportModel, context, {
      reasoning: offReasoning,
      maxTokens: 128,
    } as never);
    expect(lowPayload.reasoning_effort).toBe("low");
    expect(lowPayload.max_tokens).toBe(128);
    expect(lowPayload).not.toHaveProperty("max_completion_tokens");
    expect(lowPayload).not.toHaveProperty("store");
    expect(lowPayload).not.toHaveProperty("stream_options");
    expect(lowPayload.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system", content: "system" })]),
    );
    expect(lowPayload.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "developer" })]),
    );
    expect(
      buildOpenAICompletionsParams(transportModel, context, { reasoning: "high" } as never)
        .reasoning_effort,
    ).toBe("high");
  });

  it("keeps manifest auth choices aligned with runtime provider methods", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: stepfunPlugin,
      id: "stepfun",
      name: "StepFun",
    });
    const manifest = readManifest();
    const runtimeChoices = ["stepfun", "stepfun-plan"].flatMap((providerId) => {
      const provider = requireRegisteredProvider(providers, providerId);
      return provider.auth.map((method) => ({
        provider: provider.id,
        method: method.id,
        choiceId: method.wizard?.choiceId,
      }));
    });

    const manifestChoices = manifest.providerAuthChoices?.map((choice) => ({
      provider: choice.provider,
      method: choice.method,
      choiceId: choice.choiceId,
    }));

    expect(runtimeChoices).toEqual(manifestChoices);
    expect(manifest.setup?.providers).toEqual([
      {
        id: "stepfun",
        envVars: ["STEPFUN_API_KEY"],
      },
      {
        id: "stepfun-plan",
        envVars: ["STEPFUN_API_KEY"],
      },
    ]);
  });
});
