import { describe, expect, it } from "vitest";
import { shouldExcludeProviderFromDefaultHighSignalLiveSweep } from "./live-model-filter.js";

describe("shouldExcludeProviderFromDefaultHighSignalLiveSweep", () => {
  it("excludes dedicated harness providers from the default high-signal sweep", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: null,
      }),
    ).toBe(true);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai-codex",
        useExplicitModels: false,
        providerFilter: null,
      }),
    ).toBe(true);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex-cli",
        useExplicitModels: false,
        providerFilter: null,
      }),
    ).toBe(true);
  });

  it("keeps dedicated harness providers when explicitly requested by provider filter", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: new Set(["codex"]),
      }),
    ).toBe(false);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai-codex",
        useExplicitModels: false,
        providerFilter: new Set(["codex-cli"]),
      }),
    ).toBe(false);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai-codex",
        useExplicitModels: false,
        providerFilter: new Set(["openai"]),
      }),
    ).toBe(false);
  });

  it("keeps dedicated harness providers when the caller uses explicit model selection", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: true,
        providerFilter: null,
      }),
    ).toBe(false);
  });

  it("does not exclude ordinary providers", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai",
        useExplicitModels: false,
        providerFilter: null,
      }),
    ).toBe(false);
  });
});
