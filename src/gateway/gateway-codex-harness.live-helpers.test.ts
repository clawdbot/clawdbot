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

  it("accepts sandbox namespace failures with current-session model fallback", () => {
    const text = [
      "I can’t enumerate `/codex models` from this sandbox because the local `codex` CLI fails to start here with a user-namespace restriction (`bwrap: No permissions to create a new namespace`).",
      "",
      "What I can confirm from the current session is that it’s running on `codex/gpt-5.4`.",
    ].join("\n");

    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts missing codex CLI fallback output", () => {
    const text = [
      "`codex` is not installed on the shell PATH in this environment.",
      "",
      "Command result:",
      "```text",
      "/bin/bash: line 1: codex: command not found",
      "```",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
  });

  it("accepts sandbox escalation rejection for codex models", () => {
    const texts = [
      "I couldn’t list them because `codex models` requires running outside the sandbox here, and that approval was rejected.",
      "I couldn’t list them because the local `codex models` command requires elevated execution in this environment, and that request was rejected.",
      "I couldn’t list them because the local `codex models` command requires host permissions here, and that escalation was rejected.",
      "I couldn’t run `codex models` because the sandboxed attempt failed and the required elevated retry was not approved.",
    ];

    for (const text of texts) {
      expect(isExpectedCodexModelsCommandText(text)).toBe(true);
    }
  });

  it("accepts the interactive TUI current-model summary", () => {
    const text = [
      "`codex models` didn’t return a plain list in this environment; it dropped into the interactive TUI instead.",
      "",
      "What I could confirm from that session is:",
      "- Codex CLI version: `v0.118.0`",
      "- Current selected model: `local-default-model`",
      "- The UI indicates `/model` is the command to change models",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(true);
  });

  it("accepts the local Codex model-cache summary", () => {
    const text = [
      "Available models in this Codex install, from the local cache fetched on `2026-04-18`, are:",
      "",
      "- `gpt-5.4`",
      "- `local-default-model`",
      "- `gpt-5.4-mini`",
      "",
      "This session is currently running `codex/gpt-5.4` with `low` reasoning according to `/codex status`.",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
    expect(isExpectedCodexModelsCommandText(text)).toBe(false);
  });

  it("accepts the sandboxed CLI failure active-model summary", () => {
    const text = [
      "I couldn’t inspect the CLI model list because sandboxed `codex --help` failed on a namespace restriction, and the escalated retry was rejected.",
      "",
      "What I can confirm from the current session is:",
      "- Active model: `codex/gpt-5.4`",
    ].join("\n");

    expect(
      EXPECTED_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText)),
    ).toBe(true);
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
