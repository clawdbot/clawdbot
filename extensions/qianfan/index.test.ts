// Qianfan tests cover index plugin behavior.
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import qianfanPlugin from "./index.js";
import { applyQianfanConfig, QIANFAN_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function expectRecord<T>(value: T | null | undefined, label: string): NonNullable<T> {
  if (!value) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

describe("qianfan provider plugin", () => {
  it("registers Qianfan with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "qianfan-api-key",
    });

    expect(provider.id).toBe("qianfan");
    expect(provider.label).toBe("Qianfan");
    expect(provider.docsPath).toBe("/providers/qianfan");
    expect(provider.envVars).toEqual(["QIANFAN_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    const resolvedChoice = expectRecord(resolved, "Qianfan provider choice");
    expect({
      providerId: resolvedChoice.provider.id,
      methodId: resolvedChoice.method.id,
    }).toEqual({
      providerId: "qianfan",
      methodId: "api-key",
    });
  });

  it("builds the static Qianfan model catalog", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    const models = expectRecord(catalogProvider.models, "Qianfan catalog models");
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-v4-pro",
      "ernie-5.1",
      "ernie-5.0",
      "deepseek-v3.2",
      "ernie-5.0-thinking-preview",
    ]);
    const expectedModels = [
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        input: ["text"],
        contextWindow: 1000000,
        maxTokens: 393216,
        cost: {
          input: 1.771957,
          output: 3.543915,
          cacheRead: 0.147663,
          cacheWrite: 0,
        },
      },
      {
        id: "ernie-5.1",
        name: "ERNIE 5.1",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 65536,
        cost: {
          input: 0.590652,
          output: 2.657936,
          cacheRead: 0,
          cacheWrite: 0,
          tieredPricing: [
            {
              input: 0.590652,
              output: 2.657936,
              cacheRead: 0,
              cacheWrite: 0,
              range: [0, 32001] as [number, number],
            },
            {
              input: 0.885979,
              output: 3.248589,
              cacheRead: 0,
              cacheWrite: 0,
              range: [32001] as [number],
            },
          ],
        },
      },
      {
        id: "ernie-5.0",
        name: "ERNIE 5.0",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 65536,
        cost: {
          input: 0.885979,
          output: 3.543915,
          cacheRead: 0,
          cacheWrite: 0,
          tieredPricing: [
            {
              input: 0.885979,
              output: 3.543915,
              cacheRead: 0,
              cacheWrite: 0,
              range: [0, 32001] as [number, number],
            },
            {
              input: 1.476631,
              output: 5.906525,
              cacheRead: 0,
              cacheWrite: 0,
              range: [32001] as [number],
            },
          ],
        },
      },
      {
        id: "deepseek-v3.2",
        name: "DeepSeek V3.2",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 32768,
        cost: {
          input: 0.295326,
          output: 0.442989,
          cacheRead: 0.059065,
          cacheWrite: 0,
          tieredPricing: [
            {
              input: 0.295326,
              output: 0.442989,
              cacheRead: 0.059065,
              cacheWrite: 0,
              range: [0, 32001] as [number, number],
            },
            {
              input: 0.590652,
              output: 0.885979,
              cacheRead: 0.059065,
              cacheWrite: 0,
              range: [32001] as [number],
            },
          ],
        },
      },
      {
        id: "ernie-5.0-thinking-preview",
        name: "ERNIE-5.0-Thinking-Preview",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 65536,
        cost: {
          input: 0.885979,
          output: 3.543915,
          cacheRead: 0,
          cacheWrite: 0,
          tieredPricing: [
            {
              input: 0.885979,
              output: 3.543915,
              cacheRead: 0,
              cacheWrite: 0,
              range: [0, 32001] as [number, number],
            },
            {
              input: 1.476631,
              output: 5.906525,
              cacheRead: 0,
              cacheWrite: 0,
              range: [32001] as [number],
            },
          ],
        },
      },
    ] satisfies Array<Partial<(typeof models)[number]>>;
    for (const expected of expectedModels) {
      expect(
        expectRecord(
          models.find((model) => model.id === expected.id),
          `${expected.id} model`,
        ),
      ).toMatchObject(expected);
    }

    const manifestRows = manifest.modelCatalog.providers.qianfan.models as Array<
      Record<string, unknown>
    >;
    for (const [id, replacedBy] of [
      ["deepseek-v3.2", "deepseek-v4-pro"],
      ["ernie-5.0-thinking-preview", "ernie-5.0"],
    ]) {
      expect(manifestRows.find((model) => model.id === id)).toMatchObject({
        status: "deprecated",
        replacedBy,
      });
    }
  });

  it.each([
    { mode: undefined, modelIds: [] },
    { mode: "merge" as const, modelIds: [] },
    {
      mode: "replace" as const,
      modelIds: [
        "deepseek-v4-pro",
        "ernie-5.1",
        "ernie-5.0",
        "deepseek-v3.2",
        "ernie-5.0-thinking-preview",
      ],
    },
  ])(
    "sets Qianfan's default without persisting ordinary $mode catalog rows",
    ({ mode, modelIds }) => {
      const cfg = applyQianfanConfig({ models: { mode } });

      const agentsConfig = expectRecord(cfg.agents, "agents config");
      const agentDefaults = expectRecord(agentsConfig.defaults, "agent defaults");
      expect(resolveAgentModelPrimaryValue(agentDefaults.model)).toBe(QIANFAN_DEFAULT_MODEL_REF);
      expect(cfg.models?.providers?.qianfan?.models.map((model) => model.id)).toEqual(modelIds);
    },
  );
});
