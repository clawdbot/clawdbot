/**
 * Regression coverage for live model sweep filtering.
 * Verifies provider exclusions, explicit filters, and high-signal model caps.
 */
import { describe, expect, it } from "vitest";
import {
  resolveHighSignalLiveModelLimit,
  shouldExcludeProviderFromDefaultHighSignalLiveSweep,
} from "./live-model-filter.js";

function resolveProviderOwners(provider: string): readonly string[] | undefined {
  if (provider === "openai") {
    return ["openai"];
  }
  if (provider === "codex" || provider === "codex-cli") {
    return ["codex"];
  }
  return undefined;
}

describe("shouldExcludeProviderFromDefaultHighSignalLiveSweep", () => {
  it("excludes dedicated harness providers from the default high-signal sweep", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(true);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex-cli",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(true);
  });

  it("keeps dedicated harness providers when explicitly requested by provider filter", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: new Set(["codex"]),
        resolveProviderOwners,
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

  it("does not exclude ordinary or legacy OpenAI provider ids", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(false);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(false);
  });
});

describe("resolveHighSignalLiveModelLimit", () => {
  it("accepts signed decimal max model limits", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "+3",
        useExplicitModels: false,
        defaultLimit: 5,
      }),
    ).toBe(3);
  });

  it("does not coerce partial max model limits", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "3models",
        useExplicitModels: false,
        defaultLimit: 5,
      }),
    ).toBe(0);
  });

  it("does not coerce non-decimal max model limits", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "0x3",
        useExplicitModels: false,
        defaultLimit: 5,
      }),
    ).toBe(0);
  });
});
