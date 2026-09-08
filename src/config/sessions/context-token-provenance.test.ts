import { describe, expect, it } from "vitest";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import {
  resolveProjectedSessionContextTokens,
  resolveProjectedSessionContextBudgetStatus,
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

  it("falls back to the matching persisted resolution while current resolution is unavailable", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, contextTokensSource: "resolved-v1" },
        ...currentSelection,
        resolvedContextTokens: undefined,
      }),
    ).toBe(272_000);
  });

  it("rejects a legacy resolved row because its producer may have reused a fallback", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, contextTokensSource: "resolved" },
        ...currentSelection,
        resolvedContextTokens: undefined,
      }),
    ).toBeUndefined();
  });

  it("does not resurrect a removed runtime-configured cap while resolution is unavailable", () => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: { ...matchingRuntimeEntry, contextTokensSource: "runtime-configured" },
        ...currentSelection,
        resolvedContextTokens: undefined,
      }),
    ).toBeUndefined();
  });

  it.each([
    { name: "provider", patch: { modelProvider: "openrouter" } },
    { name: "model", patch: { model: "gpt-5.5" } },
    { name: "harness", patch: { agentHarnessId: "openclaw" } },
  ])("rejects a persisted resolution owned by a different $name", ({ patch }) => {
    expect(
      resolveProjectedSessionContextTokens({
        entry: {
          ...matchingRuntimeEntry,
          contextTokensSource: "resolved-v1",
          ...patch,
        },
        ...currentSelection,
        resolvedContextTokens: undefined,
      }),
    ).toBeUndefined();
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

describe("resolveProjectedSessionContextBudgetStatus", () => {
  const entry = { sessionId: "session-1", contextBudgetStatus: contextBudgetStatusFixture() };
  const selection = { provider: "ollama", model: "qwen3:8b", contextTokens: 200_000 };

  it.each([{ name: "matching cap", contextTokens: 200_000 }])(
    "keeps a last-run estimate with $name",
    ({ contextTokens }) => {
      expect(
        resolveProjectedSessionContextBudgetStatus({ entry, ...selection, contextTokens }),
      ).toEqual(entry.contextBudgetStatus);
    },
  );

  it.each([
    { name: "model", current: { model: "qwen3:4b" } },
    { name: "missing model", current: { model: undefined } },
    { name: "missing provider", current: { provider: undefined } },
    { name: "unknown cap", current: { contextTokens: undefined } },
    { name: "provider", current: { provider: "lmstudio" } },
    { name: "lower cap", current: { contextTokens: 100_000 } },
    { name: "higher cap", current: { contextTokens: 1_000_000 } },
  ])("rejects a budget after the $name changes", ({ current }) => {
    expect(
      resolveProjectedSessionContextBudgetStatus({ entry, ...selection, ...current }),
    ).toBeUndefined();
  });

  it.each([{ sessionId: "session-2" }, { liveModelSwitchPending: true }])(
    "rejects a stale session lifecycle %j",
    (patch) => {
      expect(
        resolveProjectedSessionContextBudgetStatus({ entry: { ...entry, ...patch }, ...selection }),
      ).toBeUndefined();
    },
  );

  it.each([undefined, "", " "])("rejects an unbound snapshot session ID %j", (sessionId) => {
    expect(
      resolveProjectedSessionContextBudgetStatus({
        entry: { ...entry, contextBudgetStatus: { ...entry.contextBudgetStatus, sessionId } },
        ...selection,
      }),
    ).toBeUndefined();
  });

  it("keeps a narrower budget owned by the serving runtime", () => {
    const runtimeEntry = {
      ...entry,
      modelProvider: "ollama",
      model: "qwen3:8b",
      agentHarnessId: "openclaw",
      contextTokens: 200_000,
      contextTokensSource: "runtime" as const,
    };
    const contextTokens = resolveProjectedSessionContextTokens({
      entry: runtimeEntry,
      ...selection,
      agentHarnessId: "openclaw",
      resolvedContextTokens: 262_144,
    });
    expect(contextTokens).toBe(200_000);
    expect(
      resolveProjectedSessionContextBudgetStatus({
        entry: runtimeEntry,
        ...selection,
        contextTokens,
      }),
    ).toEqual(entry.contextBudgetStatus);
  });
});
