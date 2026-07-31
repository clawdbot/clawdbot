// Config eval tests cover dynamic config loading and evaluation guards.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
} from "./config-eval.js";

const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;

function setPlatform(platform: NodeJS.Platform): void {
  mockProcessPlatform(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  if (originalPathExt === undefined) {
    delete process.env.PATHEXT;
  } else {
    process.env.PATHEXT = originalPathExt;
  }
});

describe("config-eval helpers", () => {
  it("normalizes truthy values across primitive types", () => {
    for (const [value, expected] of [
      [undefined, false],
      [null, false],
      [false, false],
      [true, true],
      [0, false],
      [1, true],
      ["   ", false],
      [" ok ", true],
      [{}, true],
    ] as const) {
      expect(isConfigPathTruthyWithDefaults({ value }, "value", {})).toBe(expected);
    }
  });

  it("resolves nested config paths and missing branches safely", () => {
    const config = {
      browser: {
        enabled: true,
        nested: {
          count: 1,
        },
      },
    };

    expect(isConfigPathTruthyWithDefaults(config, "browser.enabled", {})).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, ".browser..nested.count.", {})).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, "browser.missing.value", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults("not-an-object", "browser.enabled", {})).toBe(false);
  });

  it("blocks prototype keys while resolving config paths", () => {
    const config = {
      safe: {
        enabled: true,
      },
    };

    expect(isConfigPathTruthyWithDefaults(config, "safe.enabled", {})).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, "__proto__", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults(config, "constructor.name", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults(config, "prototype.polluted", {})).toBe(false);
  });

  it("uses defaults only when config paths are unresolved", () => {
    const config = {
      browser: {
        enabled: false,
      },
    };

    expect(
      isConfigPathTruthyWithDefaults(config, "browser.enabled", { "browser.enabled": true }),
    ).toBe(false);
    expect(
      isConfigPathTruthyWithDefaults(config, "browser.missing", { "browser.missing": true }),
    ).toBe(true);
    expect(isConfigPathTruthyWithDefaults(config, "browser.other", {})).toBe(false);
  });

  it("does not use inherited defaults for blocked config paths", () => {
    expect(isConfigPathTruthyWithDefaults({}, "constructor", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults({}, "__proto__.enabled", {})).toBe(false);
    expect(isConfigPathTruthyWithDefaults({}, "prototype.enabled", {})).toBe(false);
  });

  it("returns the active runtime platform", () => {
    setPlatform("darwin");
    expect(
      evaluateRuntimeEligibility({
        os: ["darwin"],
        hasBin: () => true,
        hasEnv: () => true,
        isConfigPathTruthy: () => true,
      }),
    ).toBe(true);
  });

  it("caches binary lookups until PATH changes", () => {
    setPlatform("linux");
    process.env.PATH = ["/missing/bin", "/found/bin"].join(path.delimiter);
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation((candidate) => {
      if (String(candidate) === path.join("/found/bin", "tool")) {
        return undefined;
      }
      throw new Error("missing");
    });

    expect(hasBinary("tool")).toBe(true);
    expect(hasBinary("tool")).toBe(true);
    expect(accessSpy).toHaveBeenCalledTimes(2);

    process.env.PATH = "/other/bin";
    accessSpy.mockClear();
    accessSpy.mockImplementation(() => {
      throw new Error("missing");
    });

    expect(hasBinary("tool")).toBe(false);
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });

  it("checks PATHEXT candidates on Windows", () => {
    setPlatform("win32");
    const toolsDir = path.join(path.sep, "tools");
    process.env.PATH = toolsDir;
    process.env.PATHEXT = ".EXE;.CMD";
    const plainCandidate = path.join(toolsDir, "tool");
    const exeCandidate = path.join(toolsDir, "tool.EXE");
    const cmdCandidate = path.join(toolsDir, "tool.CMD");
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation((candidate) => {
      if (String(candidate) === cmdCandidate) {
        return undefined;
      }
      throw new Error("missing");
    });

    expect(hasBinary("tool")).toBe(true);
    expect(accessSpy.mock.calls.map(([candidate]) => String(candidate))).toEqual([
      plainCandidate,
      exeCandidate,
      cmdCandidate,
    ]);
  });
});

describe("runtime requirements through eligibility", () => {
  it("accepts remote bins and remote any-bin matches", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "deno"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: () => false,
      hasRemoteBin: (bin) => bin === "node",
      hasAnyRemoteBin: (bins) => bins.includes("deno"),
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (pathValue) => pathValue === "browser.enabled",
    });

    expect(result).toBe(true);
  });

  it("rejects when any required runtime check is still unsatisfied", () => {
    expect(
      evaluateRuntimeEligibility({
        requires: { bins: ["node"] },
        hasBin: () => false,
        hasEnv: () => true,
        isConfigPathTruthy: () => true,
      }),
    ).toBe(false);

    expect(
      evaluateRuntimeEligibility({
        requires: { anyBins: ["bun", "node"] },
        hasBin: () => false,
        hasAnyRemoteBin: () => false,
        hasEnv: () => true,
        isConfigPathTruthy: () => true,
      }),
    ).toBe(false);
  });
});

describe("evaluateRuntimeEligibility", () => {
  it("rejects entries when required OS does not match local or remote", () => {
    const result = evaluateRuntimeEligibility({
      os: ["definitely-not-a-runtime-platform"],
      remotePlatforms: [],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("accepts entries when remote platform satisfies OS requirements", () => {
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("bypasses runtime requirements when always=true", () => {
    const result = evaluateRuntimeEligibility({
      always: true,
      requires: { env: ["OPENAI_API_KEY"] },
      hasBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
    });
    expect(result).toBe(true);
  });

  it("evaluates runtime requirements when always is false", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "node"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: (bin) => bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (pathLocal) => pathLocal === "browser.enabled",
    });
    expect(result).toBe(true);
  });
});
