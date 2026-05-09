import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import qianfanPlugin from "./index.js";
import {
  applyQianfanConfig,
  applyQianfanProviderConfig,
  QIANFAN_DEFAULT_MODEL_REF,
} from "./onboard.js";

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
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    const models = expectRecord(catalogProvider.models, "Qianfan catalog models");
    expect(models.map((model) => model.id)).toEqual([
      "deepseek-v3.2",
      "ernie-5.0-thinking-preview",
    ]);
    expect(
      expectRecord(
        models.find((model) => model.id === "deepseek-v3.2"),
        "deepseek model",
      ),
    ).toEqual({
      name: "DEEPSEEK V3.2",
      id: "deepseek-v3.2",
      reasoning: true,
      input: ["text"],
      contextWindow: 98304,
      maxTokens: 32768,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
    expect(
      expectRecord(
        models.find((model) => model.id === "ernie-5.0-thinking-preview"),
        "ernie model",
      ),
    ).toEqual({
      name: "ERNIE-5.0-Thinking-Preview",
      id: "ernie-5.0-thinking-preview",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 119000,
      maxTokens: 64000,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
  });

  it("adds Qianfan provider defaults without changing primary model in provider-only mode", () => {
    const cfg = applyQianfanProviderConfig({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    });

    const modelsConfig = expectRecord(cfg.models, "models config");
    const providers = expectRecord(modelsConfig.providers, "model providers");
    const providerConfig = expectRecord(providers.qianfan, "Qianfan provider config");
    expect(providerConfig.api).toBe("openai-completions");
    expect(providerConfig.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    const providerModels = expectRecord(providerConfig.models, "Qianfan provider models");
    expect(providerModels.map((model) => model.id)).toEqual([
      "deepseek-v3.2",
      "ernie-5.0-thinking-preview",
    ]);
    const agentsConfig = expectRecord(cfg.agents, "agents config");
    const agentDefaults = expectRecord(agentsConfig.defaults, "agent defaults");
    const agentModelAliases = expectRecord(agentDefaults.models, "agent model aliases");
    const qianfanAlias = expectRecord(
      agentModelAliases[QIANFAN_DEFAULT_MODEL_REF],
      "Qianfan model alias",
    );
    expect(qianfanAlias.alias).toBe("QIANFAN");
    expect(resolveAgentModelPrimaryValue(agentDefaults.model)).toBe("anthropic/claude-opus-4-6");
  });

  it("sets Qianfan as the agent primary model in full onboarding mode", () => {
    const cfg = applyQianfanConfig({});

    const agentsConfig = expectRecord(cfg.agents, "agents config");
    const agentDefaults = expectRecord(agentsConfig.defaults, "agent defaults");
    expect(resolveAgentModelPrimaryValue(agentDefaults.model)).toBe(QIANFAN_DEFAULT_MODEL_REF);
  });
});
