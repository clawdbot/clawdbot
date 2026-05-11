import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveEnvApiKey } from "openclaw/plugin-sdk/provider-auth-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it, vi } from "vitest";
import {
  buildKilocodeModelDefinition,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MODEL_ID,
} from "./api.js";
import {
  applyKilocodeProviderConfig,
  applyKilocodeConfig,
  KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_MODEL_REF,
} from "./onboard.js";

const emptyCfg: OpenClawConfig = {};
const KILOCODE_MODEL_IDS = ["kilo/auto"];

function requireKilocodeProvider(cfg: OpenClawConfig) {
  const provider = cfg.models?.providers?.kilocode;
  if (!provider) {
    throw new Error("expected Kilocode provider config");
  }
  return provider;
}

describe("Kilo Gateway provider config", () => {
  describe("constants", () => {
    it("KILOCODE_BASE_URL points to kilo openrouter endpoint", () => {
      expect(KILOCODE_BASE_URL).toBe("https://api.kilo.ai/api/gateway/");
    });

    it("KILOCODE_DEFAULT_MODEL_REF includes provider prefix", () => {
      expect(KILOCODE_DEFAULT_MODEL_REF).toBe("kilocode/kilo/auto");
    });

    it("KILOCODE_DEFAULT_MODEL_ID is kilo/auto", () => {
      expect(KILOCODE_DEFAULT_MODEL_ID).toBe("kilo/auto");
    });
  });

  describe("buildKilocodeModelDefinition", () => {
    it("returns correct model shape", () => {
      const model = buildKilocodeModelDefinition();
      expect(model.id).toBe(KILOCODE_DEFAULT_MODEL_ID);
      expect(model.name).toBe("Kilo Auto");
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(["text", "image"]);
      expect(model.contextWindow).toBe(KILOCODE_DEFAULT_CONTEXT_WINDOW);
      expect(model.maxTokens).toBe(KILOCODE_DEFAULT_MAX_TOKENS);
      expect(model.cost).toEqual(KILOCODE_DEFAULT_COST);
    });
  });

  describe("applyKilocodeProviderConfig", () => {
    it("registers kilocode provider with correct baseUrl and api", () => {
      const result = applyKilocodeProviderConfig(emptyCfg);
      const provider = requireKilocodeProvider(result);
      expect(provider.baseUrl).toBe(KILOCODE_BASE_URL);
      expect(provider.api).toBe("openai-completions");
    });

    it("includes the default model in the provider model list", () => {
      const result = applyKilocodeProviderConfig(emptyCfg);
      const provider = result.models?.providers?.kilocode;
      const models = provider?.models;
      expect(Array.isArray(models)).toBe(true);
      const modelIds = models?.map((m) => m.id) ?? [];
      expect(modelIds).toContain(KILOCODE_DEFAULT_MODEL_ID);
    });

    it("surfaces the full Kilo model catalog", () => {
      const result = applyKilocodeProviderConfig(emptyCfg);
      const provider = result.models?.providers?.kilocode;
      const modelIds = provider?.models?.map((m) => m.id) ?? [];
      for (const modelId of KILOCODE_MODEL_IDS) {
        expect(modelIds).toContain(modelId);
      }
    });

    it("appends missing catalog models to existing Kilo provider config", () => {
      const result = applyKilocodeProviderConfig({
        models: {
          providers: {
            kilocode: {
              baseUrl: KILOCODE_BASE_URL,
              api: "openai-completions",
              models: [buildKilocodeModelDefinition()],
            },
          },
        },
      });
      const modelIds = result.models?.providers?.kilocode?.models?.map((m) => m.id) ?? [];
      for (const modelId of KILOCODE_MODEL_IDS) {
        expect(modelIds).toContain(modelId);
      }
    });

    it("sets Kilo Gateway alias in agent default models", () => {
      const result = applyKilocodeProviderConfig(emptyCfg);
      const agentModel = result.agents?.defaults?.models?.[KILOCODE_DEFAULT_MODEL_REF];
      expect(agentModel).toEqual({ alias: "Kilo Gateway" });
    });

    it("preserves existing alias if already set", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [KILOCODE_DEFAULT_MODEL_REF]: { alias: "My Custom Alias" },
            },
          },
        },
      };
      const result = applyKilocodeProviderConfig(cfg);
      const agentModel = result.agents?.defaults?.models?.[KILOCODE_DEFAULT_MODEL_REF];
      expect(agentModel?.alias).toBe("My Custom Alias");
    });

    it("does not change the default model selection", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5" },
          },
        },
      };
      const result = applyKilocodeProviderConfig(cfg);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5");
    });
  });

  describe("applyKilocodeConfig", () => {
    it("sets kilocode as the default model", () => {
      const result = applyKilocodeConfig(emptyCfg);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
        KILOCODE_DEFAULT_MODEL_REF,
      );
      const provider = requireKilocodeProvider(result);
      expect(provider.baseUrl).toBe(KILOCODE_BASE_URL);
    });
  });

  describe("env var resolution", () => {
    it("resolves KILOCODE_API_KEY from env", () => {
      vi.stubEnv("KILOCODE_API_KEY", "test-kilo-key");

      try {
        const result = resolveEnvApiKey("kilocode");
        expect(result).toEqual({
          apiKey: "test-kilo-key",
          source: "env: KILOCODE_API_KEY",
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("returns null when KILOCODE_API_KEY is not set", () => {
      vi.stubEnv("KILOCODE_API_KEY", "");

      try {
        const result = resolveEnvApiKey("kilocode");
        expect(result).toBeNull();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
