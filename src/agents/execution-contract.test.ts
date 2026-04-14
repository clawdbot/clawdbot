import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isStrictAgenticExecutionContractActive,
  resolveEffectiveExecutionContract,
} from "./execution-contract.js";

describe("resolveEffectiveExecutionContract", () => {
  const supportedProvider = "openai";
  const unsupportedProvider = "anthropic";
  const emptyConfig: OpenClawConfig = {};

  describe("supported provider + model detection", () => {
    it("auto-activates on bare gpt-5 model ids", () => {
      expect(
        resolveEffectiveExecutionContract({
          config: emptyConfig,
          provider: supportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe("strict-agentic");
    });

    it("auto-activates on the mock-openai qa lane", () => {
      expect(
        resolveEffectiveExecutionContract({
          config: emptyConfig,
          provider: "mock-openai",
          modelId: "mock-openai/gpt-5.4",
        }),
      ).toBe("strict-agentic");
    });

    it("auto-activates on gpt-5o and variants without a separator", () => {
      for (const modelId of ["gpt-5", "gpt-5o", "gpt-5o-mini"]) {
        expect(
          resolveEffectiveExecutionContract({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe("strict-agentic");
      }
    });

    it("auto-activates on dot-separated variants", () => {
      for (const modelId of ["gpt-5.0", "gpt-5.4", "gpt-5.4-alt", "gpt-5.99"]) {
        expect(
          resolveEffectiveExecutionContract({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe("strict-agentic");
      }
    });

    it("auto-activates on dash-separated variants", () => {
      for (const modelId of ["gpt-5-preview", "gpt-5-turbo", "gpt-5-2025-03"]) {
        expect(
          resolveEffectiveExecutionContract({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe("strict-agentic");
      }
    });

    it("auto-activates on prefixed model ids (openai/gpt-5.4, openai:gpt-5.4)", () => {
      // Regression for the adversarial review finding: prefixed model ids
      // must strip the provider prefix before matching the regex.
      for (const modelId of [
        "openai/gpt-5.4",
        "openai:gpt-5.4",
        "openai/gpt-5o-mini",
        "openai-codex/gpt-5.4",
        "openai-codex:gpt-5.4",
        "  openai/gpt-5.4  ",
        " OPENAI:GPT-5.4 ",
      ]) {
        expect(
          resolveEffectiveExecutionContract({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe("strict-agentic");
      }
    });

    it("is case-insensitive", () => {
      for (const modelId of ["GPT-5.4", "Gpt-5O", "OPENAI/GPT-5.4"]) {
        expect(
          resolveEffectiveExecutionContract({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe("strict-agentic");
      }
    });

    it("does not match non-gpt-5 family ids", () => {
      for (const modelId of [
        "gpt-4.5",
        "gpt-4o",
        "gpt-6",
        "gpt-50",
        "claude-opus-4-6",
        "llama-3-70b",
        "mistral-large",
      ]) {
        expect(
          resolveEffectiveExecutionContract({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe("default");
      }
    });

    it("collapses to default on unsupported providers even with gpt-5 model ids", () => {
      expect(
        resolveEffectiveExecutionContract({
          config: emptyConfig,
          provider: unsupportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe("default");
    });
  });

  describe("explicit override behavior", () => {
    it("honors explicit strict-agentic on the supported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "strict-agentic",
            },
          },
        },
      };
      expect(
        resolveEffectiveExecutionContract({
          config,
          provider: supportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe("strict-agentic");
    });

    it("honors explicit default opt-out even on the supported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "default",
            },
          },
        },
      };
      expect(
        resolveEffectiveExecutionContract({
          config,
          provider: supportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe("default");
    });

    it("collapses explicit strict-agentic to default on an unsupported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            embeddedPi: {
              executionContract: "strict-agentic",
            },
          },
        },
      };
      expect(
        resolveEffectiveExecutionContract({
          config,
          provider: unsupportedProvider,
          modelId: "claude-opus-4-6",
        }),
      ).toBe("default");
    });
  });

  describe("active flag helper", () => {
    it("returns true when the effective contract is strict-agentic", () => {
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: supportedProvider,
          modelId: "openai/gpt-5.4",
        }),
      ).toBe(true);
    });

    it("returns false when the effective contract is default", () => {
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: supportedProvider,
          modelId: "gpt-4.5",
        }),
      ).toBe(false);
    });
  });
});
