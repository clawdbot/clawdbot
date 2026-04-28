import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  type OpenClawConfig,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDeepInfraProviderConfig,
  applyDeepInfraConfig,
  DEEPINFRA_BASE_URL,
  DEEPINFRA_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { DEEPINFRA_DEFAULT_MODEL_ID } from "./provider-models.js";

const { resolveEnvApiKey } = providerAuth;

const emptyCfg: OpenClawConfig = {};

describe("DeepInfra provider config", () => {
  describe("constants", () => {
    it("DEEPINFRA_BASE_URL points to deepinfra openai endpoint", () => {
      expect(DEEPINFRA_BASE_URL).toBe("https://api.deepinfra.com/v1/openai");
    });

    it("DEEPINFRA_DEFAULT_MODEL_REF includes provider prefix", () => {
      expect(DEEPINFRA_DEFAULT_MODEL_REF).toBe("deepinfra/deepseek-ai/DeepSeek-V3.2");
    });

    it("DEEPINFRA_DEFAULT_MODEL_ID is deepseek-ai/DeepSeek-V3.2", () => {
      expect(DEEPINFRA_DEFAULT_MODEL_ID).toBe("deepseek-ai/DeepSeek-V3.2");
    });
  });

  describe("applyDeepInfraProviderConfig", () => {
    it("does not set provider models (discovery populates them at runtime)", () => {
      const result = applyDeepInfraProviderConfig(emptyCfg, DEEPINFRA_DEFAULT_MODEL_REF);
      expect(result.models?.providers?.deepinfra).toBeUndefined();
    });

    it("sets DeepInfra alias on the provided model ref", () => {
      const result = applyDeepInfraProviderConfig(emptyCfg, DEEPINFRA_DEFAULT_MODEL_REF);
      const agentModel = result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF];
      expect(agentModel).toBeDefined();
      expect(agentModel?.alias).toBe("DeepInfra");
    });

    it("attaches the alias to a non-default model ref when provided", () => {
      const fallbackRef = "deepinfra/other/awesome-model";
      const result = applyDeepInfraProviderConfig(emptyCfg, fallbackRef);
      expect(result.agents?.defaults?.models?.[fallbackRef]?.alias).toBe("DeepInfra");
      expect(result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF]).toBeUndefined();
    });

    it("preserves existing alias if already set", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [DEEPINFRA_DEFAULT_MODEL_REF]: { alias: "My Custom Alias" },
            },
          },
        },
      };
      const result = applyDeepInfraProviderConfig(cfg, DEEPINFRA_DEFAULT_MODEL_REF);
      const agentModel = result.agents?.defaults?.models?.[DEEPINFRA_DEFAULT_MODEL_REF];
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
      const result = applyDeepInfraProviderConfig(cfg, DEEPINFRA_DEFAULT_MODEL_REF);
      expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5");
    });
  });

  describe("applyDeepInfraConfig", () => {
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
        expect(result).not.toBeNull();
        expect(result?.apiKey).toBe("test-deepinfra-key");
        expect(result?.source).toContain("DEEPINFRA_API_KEY");
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

    it("resolves the deepinfra api key via resolveApiKeyForProvider", async () => {
      const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
      const envSnapshot = captureEnv(["DEEPINFRA_API_KEY"]);
      process.env.DEEPINFRA_API_KEY = "deepinfra-provider-test-key";

      const spy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
        apiKey: "deepinfra-provider-test-key",
        source: "env: DEEPINFRA_API_KEY",
        mode: "api-key",
      });

      try {
        const auth = await providerAuth.resolveApiKeyForProvider({
          provider: "deepinfra",
          agentDir,
        });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ provider: "deepinfra" }));
        expect(auth.apiKey).toBe("deepinfra-provider-test-key");
        expect(auth.mode).toBe("api-key");
        expect(auth.source).toContain("DEEPINFRA_API_KEY");
      } finally {
        envSnapshot.restore();
      }
    });
  });
});
