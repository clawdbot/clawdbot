import { describe, expect, it } from "vitest";
import {
  resolveProjectedSessionContextTokens,
  resolveTrustedSessionContextTokens,
} from "./context-token-provenance.js";

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

  it.each([
    { name: "provider", patch: { modelProvider: "openrouter" } },
    { name: "model", patch: { model: "gpt-5.5" } },
  ])("rejects a locked window owned by a different $name", ({ patch }) => {
    expect(
      resolveTrustedSessionContextTokens({
        entry: {
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          modelSelectionLocked: true,
          contextTokens: 272_000,
          ...patch,
        },
        ...currentSelection,
      }),
    ).toBeUndefined();
  });
});

describe("resolveProjectedSessionContextTokens", () => {
  const matchingRuntimeEntry = {
    modelProvider: "openai",
    model: "gpt-5.6-sol",
    agentHarnessId: "codex",
    contextTokens: 272_000,
    contextTokensSource: "runtime" as const,
  };

  it("uses an authored effective cap instead of older matching telemetry", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: matchingRuntimeEntry,
        ...currentSelection,
        resolvedContextTokens: 1_000_000,
        authoredContextTokens: 1_000_000,
      }),
    ).toBe(1_000_000);
  });

  it("keeps matching runtime telemetry below a higher native window", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: matchingRuntimeEntry,
        ...currentSelection,
        resolvedContextTokens: 1_000_000,
      }),
    ).toBe(272_000);
  });

  it("falls back to current resolution when producer provenance differs", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, agentHarnessId: "openclaw" },
        ...currentSelection,
        resolvedContextTokens: 1_000_000,
      }),
    ).toBe(1_000_000);
  });

  it("preserves a locked native window ahead of current configuration", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: {
          modelSelectionLocked: true,
          contextTokens: 1_000_000,
        },
        ...currentSelection,
        resolvedContextTokens: 272_000,
        authoredContextTokens: 272_000,
      }),
    ).toBe(1_000_000);
  });
});
