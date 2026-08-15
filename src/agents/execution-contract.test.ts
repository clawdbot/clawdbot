// Covers provider/model gates for strict agentic execution-contract activation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";

describe("isStrictAgenticExecutionContractActive", () => {
  const supportedProvider = "openai";
  const unsupportedProvider = "anthropic";
  const emptyConfig: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
  };

  describe("supported provider + model detection", () => {
    it("auto-activates on bare gpt-5 model ids", () => {
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: supportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe(true);
    });

    it("auto-activates on the mock-openai qa lane", () => {
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: "mock-openai",
          modelId: "mock-openai/gpt-5.4",
        }),
      ).toBe(true);
    });

    it("auto-activates on gpt-5o and variants without a separator", () => {
      for (const modelId of ["gpt-5", "gpt-5o", "gpt-5o-mini"]) {
        expect(
          isStrictAgenticExecutionContractActive({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe(true);
      }
    });

    it("auto-activates on dot-separated variants", () => {
      for (const modelId of ["gpt-5.0", "gpt-5.4", "gpt-5.4-alt", "gpt-5.99"]) {
        expect(
          isStrictAgenticExecutionContractActive({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe(true);
      }
    });

    it("auto-activates on dash-separated variants", () => {
      for (const modelId of ["gpt-5-preview", "gpt-5-turbo", "gpt-5-2025-03"]) {
        expect(
          isStrictAgenticExecutionContractActive({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe(true);
      }
    });

    it("auto-activates on prefixed model ids (openai/gpt-5.4, openai:gpt-5.4)", () => {
      // Regression for the adversarial review finding: prefixed model ids
      // must strip the provider prefix before matching the regex.
      for (const modelId of [
        "openai/gpt-5.4",
        "openai:gpt-5.4",
        "openai/gpt-5o-mini",
        "openai/gpt-5.4",
        "openai:gpt-5.4",
        "  openai/gpt-5.4  ",
        " OPENAI:GPT-5.4 ",
      ]) {
        expect(
          isStrictAgenticExecutionContractActive({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe(true);
      }
    });

    it("is case-insensitive", () => {
      for (const modelId of ["GPT-5.4", "Gpt-5O", "OPENAI/GPT-5.4"]) {
        expect(
          isStrictAgenticExecutionContractActive({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe(true);
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
          isStrictAgenticExecutionContractActive({
            config: emptyConfig,
            provider: supportedProvider,
            modelId,
          }),
        ).toBe(false);
      }
    });

    it("collapses to default on unsupported providers even with gpt-5 model ids", () => {
      // Model naming alone is insufficient; unsupported providers must not
      // inherit OpenAI-specific strict-agentic handling by accident.
      expect(
        isStrictAgenticExecutionContractActive({
          config: emptyConfig,
          provider: unsupportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe(false);
    });
  });

  describe("explicit override behavior", () => {
    it("honors explicit strict-agentic on the supported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { default: true } },
          defaults: {
            embeddedAgent: {
              executionContract: "strict-agentic",
            },
          },
        },
      };
      expect(
        isStrictAgenticExecutionContractActive({
          config,
          provider: supportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe(true);
    });

    it("honors explicit default opt-out even on the supported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { default: true } },
          defaults: {
            embeddedAgent: {
              executionContract: "default",
            },
          },
        },
      };
      expect(
        isStrictAgenticExecutionContractActive({
          config,
          provider: supportedProvider,
          modelId: "gpt-5.4",
        }),
      ).toBe(false);
    });

    it("collapses explicit strict-agentic to default on an unsupported lane", () => {
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { default: true } },
          defaults: {
            embeddedAgent: {
              executionContract: "strict-agentic",
            },
          },
        },
      };
      expect(
        isStrictAgenticExecutionContractActive({
          config,
          provider: unsupportedProvider,
          modelId: "claude-opus-4-6",
        }),
      ).toBe(false);
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
