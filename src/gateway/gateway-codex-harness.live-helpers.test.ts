import { describe, expect, it } from "vitest";
import {
  EXPECTED_CODEX_MODELS_COMMAND_TEXT,
  isExpectedCodexModelsCommandText,
} from "./gateway-codex-harness.live-helpers.js";

describe("gateway codex harness live helpers", () => {
  it("accepts the interactive model-selection summary emitted by current codex", () => {
    const text = [
      "`/codex models` opened an interactive model-selection prompt rather than printing a plain list.",
      "",
      "Visible options in this session:",
      "- `GPT-5.4`",
      "- `GPT-5.3-Codex` (listed as the existing model)",
      "",
      "Current active model is `codex/gpt-5.4`.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the configured-model fallback summary", () => {
    const text = [
      "Configured models in this session:",
      "- `codex/gpt-5.4`",
      "Current session model is `codex/gpt-5.4`.",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("rejects unrelated codex command output", () => {
    expect(isExpectedCodexModelsCommandText("Codex is healthy.")).toBe(false);
  });

  it("rejects generic current-status output that is not a model listing", () => {
    const text = [
      "Current: waiting for the Codex CLI to finish booting.",
      "Try again in a few seconds.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(false);
    expect(isExpectedCodexModelsCommandText(text)).toBe(false);
  });
});
