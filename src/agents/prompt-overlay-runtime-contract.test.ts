import {
  GPT5_CONTRACT_MODEL_ID,
  GPT5_PREFIXED_CONTRACT_MODEL_ID,
  NON_GPT5_CONTRACT_MODEL_ID,
  NON_OPENAI_CONTRACT_PROVIDER_ID,
  CODEX_CONTRACT_PROVIDER_ID,
  OPENAI_CODEX_CONTRACT_PROVIDER_ID,
  OPENAI_CONTRACT_PROVIDER_ID,
  openAiPluginPersonalityConfig,
  sharedGpt5PersonalityConfig,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { resolveGpt5SystemPromptContribution } from "./gpt5-prompt-overlay.js";

describe("GPT-5 prompt overlay runtime contract", () => {
  it("adds the behavior contract and friendly style to OpenAI-family GPT-5 models by default", () => {
    const contribution = resolveGpt5SystemPromptContribution({
      providerId: OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "This is a live chat, not a memo.",
    );
  });

  it("lets the shared GPT-5 overlay config disable friendly style without removing the behavior contract", () => {
    const contribution = resolveGpt5SystemPromptContribution({
      providerId: NON_OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_PREFIXED_CONTRACT_MODEL_ID,
      config: sharedGpt5PersonalityConfig("off"),
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toEqual({});
  });

  it("scopes OpenAI plugin personality fallback to OpenAI-family GPT-5 providers", () => {
    const openAiContribution = resolveGpt5SystemPromptContribution({
      providerId: OPENAI_CODEX_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    });
    const nonOpenAiContribution = resolveGpt5SystemPromptContribution({
      providerId: NON_OPENAI_CONTRACT_PROVIDER_ID,
      modelId: GPT5_PREFIXED_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    });

    expect(openAiContribution?.stablePrefix).toContain("<persona_latch>");
    expect(openAiContribution?.sectionOverrides).toEqual({});
    expect(nonOpenAiContribution?.stablePrefix).toContain("<persona_latch>");
    expect(nonOpenAiContribution?.sectionOverrides?.interaction_style).toContain(
      "This is a live chat, not a memo.",
    );
  });

  it("keeps Codex virtual providers in the OpenAI-family personality fallback scope", () => {
    const contribution = resolveGpt5SystemPromptContribution({
      providerId: CODEX_CONTRACT_PROVIDER_ID,
      modelId: GPT5_CONTRACT_MODEL_ID,
      config: openAiPluginPersonalityConfig("off"),
    });

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toEqual({});
  });

  it("does not apply GPT-5 overlays to non-GPT-5 models", () => {
    expect(
      resolveGpt5SystemPromptContribution({
        providerId: OPENAI_CONTRACT_PROVIDER_ID,
        modelId: NON_GPT5_CONTRACT_MODEL_ID,
      }),
    ).toBeUndefined();
  });
});
