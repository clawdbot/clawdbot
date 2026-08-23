// Zai tests cover onboard plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { expectProviderOnboardPreservesPrimary } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";
import { applyZaiConfig, applyZaiProviderConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("zai onboard", () => {
  let defaultCfg: ReturnType<typeof applyZaiConfig>;
  let cnFlashCfg: ReturnType<typeof applyZaiConfig>;
  let cnFlashxCfg: ReturnType<typeof applyZaiConfig>;

  beforeAll(() => {
    defaultCfg = applyZaiConfig({});
    cnFlashCfg = applyZaiConfig({}, { endpoint: "coding-cn", modelId: "glm-4.7-flash" });
    cnFlashxCfg = applyZaiConfig({}, { endpoint: "coding-cn", modelId: "glm-4.7-flashx" });
  });

  it("adds zai provider with correct settings", () => {
    expect(defaultCfg.models?.providers?.zai?.baseUrl).toBe(ZAI_GLOBAL_BASE_URL);
    expect(defaultCfg.models?.providers?.zai?.api).toBe("openai-completions");
    const ids = defaultCfg.models?.providers?.zai?.models?.map((m) => m.id);
    expect(ids).toEqual(manifest.modelCatalog.providers.zai.models.map((model) => model.id));
    expect(
      defaultCfg.models?.providers?.zai?.models?.find((model) => model.id === "glm-5.2"),
    ).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    });
    expect(
      defaultCfg.models?.providers?.zai?.models?.find((model) => model.id === "glm-5.2"),
    ).not.toHaveProperty("baseUrl");
  });

  it("uses the manifest default and alias for a fresh general endpoint setup", () => {
    expect(resolveAgentModelPrimaryValue(defaultCfg.agents?.defaults?.model)).toBe("zai/glm-5.2");
    expect(defaultCfg.agents?.defaults?.models).toEqual({
      "zai/glm-5.2": { alias: "GLM" },
    });
  });

  it("resolves GLM-5.2 through the selected Coding Plan or custom endpoint", async () => {
    for (const [name, cfg, expectedBaseUrl] of [
      ["coding-cn", applyZaiConfig({}, { endpoint: "coding-cn" }), ZAI_CODING_CN_BASE_URL],
      [
        "custom",
        applyZaiConfig({
          models: {
            providers: {
              zai: {
                baseUrl: "https://proxy.example.test/zai",
                api: "openai-completions",
                models: [],
              },
            },
          },
        }),
        "https://proxy.example.test/zai",
      ],
    ] as const) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-zai-${name}-`));
      try {
        const modelsPath = path.join(dir, "models.json");
        await fs.writeFile(
          modelsPath,
          JSON.stringify({
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              zai: { ...cfg.models?.providers?.zai, apiKey: "test-key" },
            },
          }),
        );
        const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
        expect(registry.getError()).toBeUndefined();
        expect(registry.find("zai", "glm-5.2")?.baseUrl).toBe(expectedBaseUrl);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("supports CN endpoint for supported coding models", () => {
    for (const [modelId, cfg] of [
      ["glm-4.7-flash", cnFlashCfg],
      ["glm-4.7-flashx", cnFlashxCfg],
    ] as const) {
      expect(cfg.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_CN_BASE_URL);
      expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(`zai/${modelId}`);
    }
  });

  it("defaults general and Coding Plan endpoints to GLM-5.2", () => {
    const codingCfg = applyZaiConfig({}, { endpoint: "coding-global" });
    const existingCodingCfg = applyZaiConfig({
      models: {
        providers: {
          zai: {
            baseUrl: `${ZAI_CODING_GLOBAL_BASE_URL}/`,
            api: "openai-completions",
            models: [],
          },
        },
      },
    });

    expect(resolveAgentModelPrimaryValue(defaultCfg.agents?.defaults?.model)).toBe("zai/glm-5.2");
    expect(codingCfg.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_GLOBAL_BASE_URL);
    expect(resolveAgentModelPrimaryValue(codingCfg.agents?.defaults?.model)).toBe("zai/glm-5.2");
    expect(resolveAgentModelPrimaryValue(existingCodingCfg.agents?.defaults?.model)).toBe(
      "zai/glm-5.2",
    );
  });

  it("does not overwrite existing primary model in provider-only mode", () => {
    expectProviderOnboardPreservesPrimary({
      applyProviderConfig: applyZaiProviderConfig,
      primaryModelRef: "anthropic/claude-opus-4-5",
    });
  });
});
