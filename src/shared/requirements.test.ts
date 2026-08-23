// Requirement tests cover merging and formatting runtime requirements.
import { describe, expect, it } from "vitest";
import { evaluateRequirementsFromMetadataWithRemote } from "./requirements.js";

type EvaluationParams = Parameters<typeof evaluateRequirementsFromMetadataWithRemote>[0];

function evaluate(overrides: Partial<EvaluationParams> = {}) {
  return evaluateRequirementsFromMetadataWithRemote({
    always: false,
    hasLocalBin: () => false,
    localPlatform: "linux",
    isEnvSatisfied: () => false,
    isConfigSatisfied: () => false,
    ...overrides,
  });
}

describe("requirements evaluation", () => {
  it("resolves required bins across local and remote capabilities", () => {
    const result = evaluate({
      metadata: { requires: { bins: ["a", "b", "c"] } },
      hasLocalBin: (bin) => bin === "a",
      remote: { hasBin: (bin) => bin === "b" },
    });

    expect(result.missing.bins).toEqual(["c"]);
  });

  it("requires at least one any-bin locally or remotely", () => {
    const metadata = { requires: { anyBins: ["a", "b"] } };

    expect(evaluate({ metadata }).missing.anyBins).toEqual(["a", "b"]);
    expect(
      evaluate({
        metadata,
        hasLocalBin: (bin) => bin === "b",
      }).missing.anyBins,
    ).toStrictEqual([]);
    expect(
      evaluate({
        metadata,
        remote: { hasAnyBin: (bins) => bins.includes("b") },
      }).missing.anyBins,
    ).toStrictEqual([]);
  });

  it("normalizes macos and accepts local or remote platforms", () => {
    expect(evaluate({ metadata: { os: ["linux"] } }).missing.os).toStrictEqual([]);
    expect(
      evaluate({
        metadata: { os: ["macos"] },
        localPlatform: "darwin",
      }).missing.os,
    ).toStrictEqual([]);
    expect(
      evaluate({
        metadata: { os: ["macos"] },
        remote: { platforms: ["darwin"] },
      }).missing.os,
    ).toStrictEqual([]);
    expect(evaluate({ metadata: { os: ["darwin"] } }).missing.os).toEqual(["darwin"]);
  });

  it("reports missing environment and config requirements with config status", () => {
    const result = evaluate({
      metadata: {
        requires: {
          env: ["A", "B"],
          config: ["a.b", "c.d"],
        },
      },
      isEnvSatisfied: (name) => name === "B",
      isConfigSatisfied: (path) => path === "a.b",
    });

    expect(result.missing.env).toEqual(["A"]);
    expect(result.missing.config).toEqual(["c.d"]);
    expect(result.configChecks).toEqual([
      { path: "a.b", satisfied: true },
      { path: "c.d", satisfied: false },
    ]);
  });

  it("reports every missing category through the public wrapper", () => {
    const result = evaluate({
      metadata: {
        requires: {
          bins: ["node"],
          anyBins: ["bun", "deno"],
          env: ["OPENAI_API_KEY"],
          config: ["browser.enabled", "gateway.enabled"],
        },
        os: ["darwin"],
      },
      remote: {
        hasBin: (bin) => bin === "node",
        hasAnyBin: () => false,
        platforms: ["windows"],
      },
      isConfigSatisfied: (path) => path === "gateway.enabled",
    });

    expect(result.required).toEqual({
      bins: ["node"],
      anyBins: ["bun", "deno"],
      env: ["OPENAI_API_KEY"],
      config: ["browser.enabled", "gateway.enabled"],
      os: ["darwin"],
    });
    expect(result.missing).toEqual({
      bins: [],
      anyBins: ["bun", "deno"],
      env: ["OPENAI_API_KEY"],
      config: ["browser.enabled"],
      os: ["darwin"],
    });
    expect(result.configChecks).toEqual([
      { path: "browser.enabled", satisfied: false },
      { path: "gateway.enabled", satisfied: true },
    ]);
    expect(result.eligible).toBe(false);
  });

  it("clears missing requirements when always is true but preserves config checks", () => {
    const result = evaluate({
      always: true,
      metadata: {
        requires: {
          bins: ["node"],
          anyBins: ["bun"],
          env: ["OPENAI_API_KEY"],
          config: ["browser.enabled"],
        },
        os: ["darwin"],
      },
    });

    expect(result.missing).toEqual({ bins: [], anyBins: [], env: [], config: [], os: [] });
    expect(result.configChecks).toEqual([{ path: "browser.enabled", satisfied: false }]);
    expect(result.eligible).toBe(true);
  });

  it("defaults missing metadata to empty requirements", () => {
    const result = evaluate();

    expect(result.required).toEqual({
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    });
    expect(result.missing).toEqual({
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    });
    expect(result.configChecks).toStrictEqual([]);
    expect(result.eligible).toBe(true);
  });
});
