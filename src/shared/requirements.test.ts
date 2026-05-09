import { describe, expect, it } from "vitest";
import {
  buildConfigChecks,
  evaluateRequirements,
  evaluateRequirementsFromMetadata,
  evaluateRequirementsFromMetadataWithRemote,
  resolveMissingAnyBins,
  resolveMissingBins,
  resolveMissingEnv,
  resolveMissingOs,
} from "./requirements.js";

describe("requirements helpers", () => {
  it("resolveMissingBins respects local+remote", () => {
    expect(
      resolveMissingBins({
        required: ["a", "b", "c"],
        hasLocalBin: (bin) => bin === "a",
        hasRemoteBin: (bin) => bin === "b",
      }),
    ).toEqual(["c"]);
  });

  it("resolveMissingAnyBins requires at least one", () => {
    expect(
      resolveMissingAnyBins({
        required: [],
        hasLocalBin: () => false,
      }),
    ).toStrictEqual([]);
    expect(
      resolveMissingAnyBins({
        required: ["a", "b"],
        hasLocalBin: () => false,
        hasRemoteAnyBin: () => false,
      }),
    ).toEqual(["a", "b"]);
    expect(
      resolveMissingAnyBins({
        required: ["a", "b"],
        hasLocalBin: (bin) => bin === "b",
      }),
    ).toStrictEqual([]);
  });

  it("resolveMissingOs allows remote platform", () => {
    expect(resolveMissingOs({ required: [], localPlatform: "linux" })).toStrictEqual([]);
    expect(resolveMissingOs({ required: ["linux"], localPlatform: "linux" })).toStrictEqual([]);
    expect(
      resolveMissingOs({
        required: ["darwin"],
        localPlatform: "linux",
        remotePlatforms: ["darwin"],
      }),
    ).toStrictEqual([]);
    expect(resolveMissingOs({ required: ["darwin"], localPlatform: "linux" })).toEqual(["darwin"]);
  });

  it("resolveMissingEnv uses predicate", () => {
    expect(
      resolveMissingEnv({ required: ["A", "B"], isSatisfied: (name) => name === "B" }),
    ).toEqual(["A"]);
  });

  it("buildConfigChecks includes status", () => {
    expect(
      buildConfigChecks({
        required: ["a.b"],
        isSatisfied: (p) => p === "a.b",
      }),
    ).toEqual([{ path: "a.b", satisfied: true }]);
  });

  it("evaluateRequirementsFromMetadata derives required+missing", () => {
    const res = evaluateRequirementsFromMetadata({
      always: false,
      metadata: {
        requires: { bins: ["a"], anyBins: ["b"], env: ["E"], config: ["cfg.value"] },
        os: ["darwin"],
      },
      hasLocalBin: (bin) => bin === "a",
      localPlatform: "linux",
      isEnvSatisfied: (name) => name === "E",
      isConfigSatisfied: () => false,
    });

    expect(res.required.bins).toEqual(["a"]);
    expect(res.missing.config).toEqual(["cfg.value"]);
    expect(res.missing.os).toEqual(["darwin"]);
    expect(res.eligible).toBe(false);
  });

  it("evaluateRequirements reports config checks and all missing categories directly", () => {
    const res = evaluateRequirements({
      always: false,
      required: {
        bins: ["node"],
        anyBins: ["bun", "deno"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled", "gateway.enabled"],
        os: ["darwin"],
      },
      hasLocalBin: () => false,
      hasRemoteBin: (bin) => bin === "node",
      hasRemoteAnyBin: () => false,
      localPlatform: "linux",
      remotePlatforms: ["windows"],
      isEnvSatisfied: () => false,
      isConfigSatisfied: (path) => path === "gateway.enabled",
    });

    expect(res.missing).toEqual({
      bins: [],
      anyBins: ["bun", "deno"],
      env: ["OPENAI_API_KEY"],
      config: ["browser.enabled"],
      os: ["darwin"],
    });
    expect(res.configChecks).toEqual([
      { path: "browser.enabled", satisfied: false },
      { path: "gateway.enabled", satisfied: true },
    ]);
    expect(res.eligible).toBe(false);
  });

  it("clears missing requirements when always is true but preserves config checks", () => {
    const res = evaluateRequirements({
      always: true,
      required: {
        bins: ["node"],
        anyBins: ["bun"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
        os: ["darwin"],
      },
      hasLocalBin: () => false,
      localPlatform: "linux",
      isEnvSatisfied: () => false,
      isConfigSatisfied: () => false,
    });

    expect(res.missing).toEqual({ bins: [], anyBins: [], env: [], config: [], os: [] });
    expect(res.configChecks).toEqual([{ path: "browser.enabled", satisfied: false }]);
    expect(res.eligible).toBe(true);
  });

  it("evaluateRequirementsFromMetadataWithRemote wires remote predicates and platforms through", () => {
    const res = evaluateRequirementsFromMetadataWithRemote({
      always: false,
      metadata: {
        requires: { bins: ["node"], anyBins: ["bun"], env: ["OPENAI_API_KEY"] },
        os: ["darwin"],
      },
      remote: {
        hasBin: (bin) => bin === "node",
        hasAnyBin: (bins) => bins.includes("bun"),
        platforms: ["darwin"],
      },
      hasLocalBin: () => false,
      localPlatform: "linux",
      isEnvSatisfied: (name) => name === "OPENAI_API_KEY",
      isConfigSatisfied: () => true,
    });

    expect(res.required).toEqual({
      bins: ["node"],
      anyBins: ["bun"],
      env: ["OPENAI_API_KEY"],
      config: [],
      os: ["darwin"],
    });
    expect(res.missing).toEqual({ bins: [], anyBins: [], env: [], config: [], os: [] });
    expect(res.eligible).toBe(true);
  });

  it("evaluateRequirementsFromMetadata defaults missing metadata to empty requirements", () => {
    const res = evaluateRequirementsFromMetadata({
      always: false,
      hasLocalBin: () => false,
      localPlatform: "linux",
      isEnvSatisfied: () => false,
      isConfigSatisfied: () => false,
    });

    expect(res.required).toEqual({
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    });
    expect(res.missing).toEqual({
      bins: [],
      anyBins: [],
      env: [],
      config: [],
      os: [],
    });
    expect(res.configChecks).toStrictEqual([]);
    expect(res.eligible).toBe(true);
  });
});
