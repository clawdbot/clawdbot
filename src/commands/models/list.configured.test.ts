import { describe, expect, it, vi } from "vitest";

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: vi.fn(() => {
    throw new Error("runtime model normalization should not load for models list entries");
  }),
}));

import { resolveConfiguredEntries } from "./list.configured.js";

describe("resolveConfiguredEntries", () => {
  it("parses configured models without loading provider-runtime normalization", () => {
    const { entries } = resolveConfiguredEntries({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.4", fallbacks: ["codex/gpt-5.4-mini"] },
          models: {
            "codex/gpt-5.4": { alias: "Codex" },
            "codex/gpt-5.4-mini": {},
          },
        },
      },
      models: { providers: {} },
    });

    expect(entries.map((entry) => entry.key)).toEqual(["codex/gpt-5.4", "codex/gpt-5.4-mini"]);
    expect(entries[0]?.tags).toEqual(new Set(["default", "configured"]));
    expect(entries[0]?.aliases).toEqual(["Codex"]);
    expect(entries[1]?.tags).toEqual(new Set(["fallback#1", "configured"]));
  });
});
