import { describe, expect, it } from "vitest";
import { resolveTrustedSessionContextTokens } from "./context-token-provenance.js";

const currentSelection = {
  provider: "openai",
  model: "gpt-5.6-sol",
  agentHarnessId: "codex",
};

describe("resolveTrustedSessionContextTokens", () => {
  it("trusts only runtime telemetry from the exact producing selection", () => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelProvider: "OpenAI",
          model: "GPT-5.6-SOL",
          agentHarnessId: "Codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        },
        ...currentSelection,
      }),
    ).toBe(272_000);
  });

  it.each([
    { name: "missing source", patch: { contextTokensSource: undefined } },
    { name: "resolved source", patch: { contextTokensSource: "resolved" as const } },
    {
      name: "runtime-configured source",
      patch: { contextTokensSource: "runtime-configured" as const },
    },
    { name: "missing harness", patch: { agentHarnessId: undefined } },
    { name: "different harness", patch: { agentHarnessId: "openclaw" } },
    { name: "different provider", patch: { modelProvider: "openrouter" } },
    { name: "different model", patch: { model: "gpt-5.5" } },
  ])("rejects $name", ({ patch }) => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          ...patch,
        },
        ...currentSelection,
      }),
    ).toBeUndefined();
  });

  it("preserves the native window owned by a locked legacy session", () => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelSelectionLocked: true,
          contextTokens: 272_000,
        },
        ...currentSelection,
      }),
    ).toBe(272_000);
  });
});
