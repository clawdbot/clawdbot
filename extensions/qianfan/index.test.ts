import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import qianfanPlugin from "./index.js";
import {
  applyQianfanConfig,
  applyQianfanProviderConfig,
  QIANFAN_DEFAULT_MODEL_REF,
} from "./onboard.js";

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
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("qianfan");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static Qianfan model catalog", async () => {
    const provider = await registerSingleProviderPlugin(qianfanPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://qianfan.baidubce.com/v2");
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "deepseek-v3.2",
      "ernie-5.0-thinking-preview",
    ]);
    expect(catalogProvider.models?.find((model) => model.id === "deepseek-v3.2")).toMatchObject({
      name: "DEEPSEEK V3.2",
      reasoning: true,
      input: ["text"],
      contextWindow: 98304,
      maxTokens: 32768,
    });
    expect(
      catalogProvider.models?.find((model) => model.id === "ernie-5.0-thinking-preview"),
    ).toMatchObject({
      name: "ERNIE-5.0-Thinking-Preview",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 119000,
      maxTokens: 64000,
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

    expect(cfg.models?.providers?.qianfan).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://qianfan.baidubce.com/v2",
    });
    expect(cfg.models?.providers?.qianfan?.models?.map((model) => model.id)).toEqual([
      "deepseek-v3.2",
      "ernie-5.0-thinking-preview",
    ]);
    expect(cfg.agents?.defaults?.models?.[QIANFAN_DEFAULT_MODEL_REF]?.alias).toBe("QIANFAN");
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      "anthropic/claude-opus-4-6",
    );
  });

  it("sets Qianfan as the agent primary model in full onboarding mode", () => {
    const cfg = applyQianfanConfig({});

    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      QIANFAN_DEFAULT_MODEL_REF,
    );
  });
});
