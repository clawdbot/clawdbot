// Deepinfra tests cover onboard plugin behavior.
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  type OpenClawConfig,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPINFRA_BASE_URL } from "./media-models.js";
import { applyDeepInfraConfig } from "./onboard.js";
import { DEEPINFRA_DEFAULT_MODEL_REF, DEEPINFRA_MODEL_CATALOG } from "./provider-models.js";

const { resolveEnvApiKey } = providerAuth;

const emptyCfg: OpenClawConfig = {};

describe("DeepInfra provider config", () => {
  describe("constants", () => {
    it("DEEPINFRA_BASE_URL points to deepinfra openai endpoint", () => {
      expect(DEEPINFRA_BASE_URL).toBe("https://api.deepinfra.com/v1/openai");
    });

    it("DEEPINFRA_DEFAULT_MODEL_REF includes provider prefix", () => {
      expect(DEEPINFRA_DEFAULT_MODEL_REF).toBe("deepinfra/deepseek-ai/DeepSeek-V4-Flash");
    });
  });

  describe("applyDeepInfraConfig", () => {
    it.each([
      { label: "custom", cost: { input: 7, output: 8, cacheRead: 0.7, cacheWrite: 0.8 } },
      { label: "zero", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ])(
      "preserves authored $label costs and alias-only setup without pinning a catalog",
      ({ cost }) => {
        const ref = "deepinfra/fixture/authored";
        const model = { ...DEEPINFRA_MODEL_CATALOG[0]!, id: "fixture/authored", cost };
        const config: OpenClawConfig = {
          models: { providers: { deepinfra: { baseUrl: DEEPINFRA_BASE_URL, models: [model] } } },
          agents: {
            defaults: { model: { primary: ref }, models: { [ref]: { alias: "Authored" } } },
          },
        };
        const result = applyDeepInfraConfig(config, ref);
        expect(result.models).toEqual(config.models);
        expect(result.agents?.defaults).toEqual(config.agents?.defaults);
        expect(applyDeepInfraConfig({}).models?.providers?.deepinfra).toBeUndefined();
      },
    );

    it("sets the provided model ref as the primary default", () => {
      const result = applyDeepInfraConfig(emptyCfg, DEEPINFRA_DEFAULT_MODEL_REF);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
        DEEPINFRA_DEFAULT_MODEL_REF,
      );
    });

    it("sets the DeepInfra alias on the provided ref", () => {
      const result = applyDeepInfraConfig(emptyCfg, DEEPINFRA_DEFAULT_MODEL_REF);
      const agentModel = result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF];
      expect(agentModel?.alias).toBe("DeepInfra");
    });

    it("honors a fallback ref when discovery picked a non-default model", () => {
      const fallbackRef = "deepinfra/other/awesome-model";
      const result = applyDeepInfraConfig(emptyCfg, fallbackRef);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(fallbackRef);
      expect(result.agents?.defaults?.models?.[fallbackRef]?.alias).toBe("DeepInfra");
    });

    it("preserves an existing alias on the selected model", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [DEEPINFRA_DEFAULT_MODEL_REF]: { alias: "My Custom Alias" },
            },
          },
        },
      };
      const result = applyDeepInfraConfig(cfg, DEEPINFRA_DEFAULT_MODEL_REF);
      expect(result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF]?.alias).toBe(
        "My Custom Alias",
      );
    });
  });

  describe("env var resolution", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("resolves DEEPINFRA_API_KEY from env", () => {
      const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
      process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";

      try {
        const result = resolveEnvApiKey("deepinfra");
        expect(result?.apiKey).toBe("test-deepinfra-key");
        expect(result?.source.endsWith("DEEPINFRA_API_KEY")).toBe(true);
      } finally {
        envSnapshot.restore();
      }
    });

    it("returns null when DEEPINFRA_API_KEY is not set", () => {
      const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
      delete process.env.DEEPINFRA_API_KEY;

      try {
        const result = resolveEnvApiKey("deepinfra");
        expect(result).toBeNull();
      } finally {
        envSnapshot.restore();
      }
    });
  });
});
