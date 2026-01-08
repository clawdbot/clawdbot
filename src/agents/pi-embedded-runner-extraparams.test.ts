import { describe, expect, it } from "vitest";
import { resolveExtraParams } from "./pi-embedded-runner.js";

/**
 * Tests for resolveExtraParams - the function that auto-enables GLM-4.x thinking mode.
 *
 * Z.AI Cloud API format: thinking: { type: "enabled", clear_thinking: boolean }
 * - GLM-4.7: Preserved thinking (clear_thinking: false) - reasoning kept across turns
 * - GLM-4.5/4.6: Interleaved thinking (clear_thinking: true) - reasoning cleared each turn
 *
 * @see https://docs.z.ai/guides/capabilities/thinking-mode
 */

describe("resolveExtraParams", () => {
  describe("GLM-4.7 preserved thinking (clear_thinking: false)", () => {
    it("auto-enables preserved thinking for zai/glm-4.7 with no config", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.7",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false, // Preserved thinking for GLM-4.7
        },
      });
    });

    it("auto-enables preserved thinking for zai/GLM-4.7 (case insensitive)", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "GLM-4.7",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });
  });

  describe("GLM-4.5/4.6 interleaved thinking (clear_thinking: true)", () => {
    it("auto-enables interleaved thinking for zai/glm-4.5", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.5",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: true, // Interleaved thinking for GLM-4.5
        },
      });
    });

    it("auto-enables interleaved thinking for zai/glm-4.6", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.6",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: true, // Interleaved thinking for GLM-4.6
        },
      });
    });

    it("auto-enables interleaved thinking for zai/glm-4-flash", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4-flash",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: true, // Non-4.7 gets interleaved
        },
      });
    });

    it("auto-enables interleaved thinking for zai/glm-4.5-air", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.5-air",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: true,
        },
      });
    });
  });

  describe("config overrides", () => {
    it("respects explicit thinking config from user (disable thinking)", () => {
      const result = resolveExtraParams({
        cfg: {
          agent: {
            models: {
              "zai/glm-4.7": {
                params: {
                  thinking: {
                    type: "disabled",
                  },
                },
              },
            },
          },
        },
        provider: "zai",
        modelId: "glm-4.7",
      });

      expect(result).toEqual({
        thinking: {
          type: "disabled",
        },
      });
    });

    it("preserves other params while adding thinking config", () => {
      const result = resolveExtraParams({
        cfg: {
          agent: {
            models: {
              "zai/glm-4.7": {
                params: {
                  temperature: 0.7,
                  max_tokens: 4096,
                },
              },
            },
          },
        },
        provider: "zai",
        modelId: "glm-4.7",
      });

      expect(result).toEqual({
        temperature: 0.7,
        max_tokens: 4096,
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });

    it("does not override explicit thinking config even if partial", () => {
      const result = resolveExtraParams({
        cfg: {
          agent: {
            models: {
              "zai/glm-4.7": {
                params: {
                  thinking: {
                    type: "enabled",
                    // User explicitly omitted clear_thinking
                  },
                },
              },
            },
          },
        },
        provider: "zai",
        modelId: "glm-4.7",
      });

      // Should use user's config exactly, not merge defaults
      expect(result).toEqual({
        thinking: {
          type: "enabled",
        },
      });
    });
  });

  describe("non-GLM models", () => {
    it("returns undefined for anthropic/claude with no config", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "anthropic",
        modelId: "claude-3-opus",
      });

      expect(result).toBeUndefined();
    });

    it("returns undefined for openai/gpt-4 with no config", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "openai",
        modelId: "gpt-4",
      });

      expect(result).toBeUndefined();
    });

    it("passes through params for non-GLM models without modification", () => {
      const result = resolveExtraParams({
        cfg: {
          agent: {
            models: {
              "openai/gpt-4": {
                params: {
                  logprobs: true,
                  top_logprobs: 5,
                },
              },
            },
          },
        },
        provider: "openai",
        modelId: "gpt-4",
      });

      expect(result).toEqual({
        logprobs: true,
        top_logprobs: 5,
      });
    });

    it("does not auto-enable thinking for non-zai provider even with glm-4 model id", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "openai",
        modelId: "glm-4.7", // Even if model ID contains glm-4
      });

      expect(result).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty config gracefully", () => {
      const result = resolveExtraParams({
        cfg: {},
        provider: "zai",
        modelId: "glm-4.7",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });

    it("handles config with empty models gracefully", () => {
      const result = resolveExtraParams({
        cfg: { agent: { models: {} } },
        provider: "zai",
        modelId: "glm-4.7",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });

    it("model alias lookup uses exact provider/model key", () => {
      const result = resolveExtraParams({
        cfg: {
          agent: {
            models: {
              "zai/glm-4.7": {
                alias: "smart",
                params: {
                  custom_param: "value",
                },
              },
            },
          },
        },
        provider: "zai",
        modelId: "glm-4.7",
      });

      expect(result).toEqual({
        custom_param: "value",
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });

    it("treats thinking: null as explicit config (no auto-enable)", () => {
      const result = resolveExtraParams({
        cfg: {
          agent: {
            models: {
              "zai/glm-4.7": {
                params: {
                  thinking: null,
                },
              },
            },
          },
        },
        provider: "zai",
        modelId: "glm-4.7",
      });

      // null is !== undefined, so we respect the explicit null config
      expect(result).toEqual({
        thinking: null,
      });
    });

    it("handles GLM-4.7 variants (glm-4.7-flash, glm-4.7-plus)", () => {
      // GLM-4.7-flash should get preserved thinking (contains "glm-4.7")
      const flashResult = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.7-flash",
      });

      expect(flashResult).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false, // Preserved thinking for GLM-4.7 variants
        },
      });

      // GLM-4.7-plus should also get preserved thinking
      const plusResult = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.7-plus",
      });

      expect(plusResult).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });
  });

  describe("thinkLevel parameter", () => {
    it("thinkLevel: 'off' disables auto-enable for GLM-4.x", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.7",
        thinkLevel: "off",
      });

      // Should NOT auto-enable thinking when user explicitly disabled it
      expect(result).toBeUndefined();
    });

    it("thinkLevel: 'off' still passes through explicit config", () => {
      const result = resolveExtraParams({
        cfg: {
          agent: {
            models: {
              "zai/glm-4.7": {
                params: {
                  custom_param: "value",
                },
              },
            },
          },
        },
        provider: "zai",
        modelId: "glm-4.7",
        thinkLevel: "off",
      });

      // Should pass through config params but NOT auto-add thinking
      expect(result).toEqual({
        custom_param: "value",
      });
    });

    it("thinkLevel: 'low' allows auto-enable", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.7",
        thinkLevel: "low",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });

    it("thinkLevel: 'high' allows auto-enable", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.5",
        thinkLevel: "high",
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: true,
        },
      });
    });

    it("thinkLevel: undefined (not specified) allows auto-enable", () => {
      const result = resolveExtraParams({
        cfg: undefined,
        provider: "zai",
        modelId: "glm-4.7",
        // thinkLevel not specified
      });

      expect(result).toEqual({
        thinking: {
          type: "enabled",
          clear_thinking: false,
        },
      });
    });
  });
});
