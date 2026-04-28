import {
  codexPromptOverlayContext,
  GPT5_CONTRACT_MODEL_ID,
  NON_GPT5_CONTRACT_MODEL_ID,
  sharedGpt5PersonalityConfig,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { buildCodexProvider } from "./provider.js";

describe("Codex prompt overlay runtime contract", () => {
  it("adds the shared GPT-5 behavior contract to Codex GPT-5 provider runs", () => {
    const provider = buildCodexProvider();
    const contribution = provider.resolveSystemPromptContribution?.(
      codexPromptOverlayContext({ modelId: GPT5_CONTRACT_MODEL_ID }),
    );

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides?.interaction_style).toContain(
      "This is a live chat, not a memo.",
    );
  });

  it("respects shared GPT-5 prompt overlay config for Codex runs", () => {
    const provider = buildCodexProvider();
    const contribution = provider.resolveSystemPromptContribution?.(
      codexPromptOverlayContext({
        modelId: GPT5_CONTRACT_MODEL_ID,
        config: sharedGpt5PersonalityConfig("off"),
      }),
    );

    expect(contribution?.stablePrefix).toContain("<persona_latch>");
    expect(contribution?.sectionOverrides).toEqual({});
  });

  it("does not add the shared GPT-5 overlay to non-GPT-5 Codex provider runs", () => {
    const provider = buildCodexProvider();

    expect(
      provider.resolveSystemPromptContribution?.(
        codexPromptOverlayContext({ modelId: NON_GPT5_CONTRACT_MODEL_ID }),
      ),
    ).toBeUndefined();
  });
});
