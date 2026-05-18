import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  evaluateRuntimeEligibility,
  evaluateRuntimeRequires,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  isTruthy,
  resolveConfigPath,
  resolveRuntimePlatform,
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
    expect(isTruthy(undefined)).toBe(false);
    expect(isTruthy(null)).toBe(false);
    expect(isTruthy(false)).toBe(false);
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy(1)).toBe(true);
    expect(isTruthy("   ")).toBe(false);
    expect(isTruthy(" ok ")).toBe(true);
    expect(isTruthy({})).toBe(true);
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

    expect(resolveConfigPath(config, "browser.enabled")).toBe(true);
    expect(resolveConfigPath(config, ".browser..nested.count.")).toBe(1);
    expect(resolveConfigPath(config, "browser.missing.value")).toBeUndefined();
    expect(resolveConfigPath("not-an-object", "browser.enabled")).toBeUndefined();
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

  it("returns the active runtime platform", () => {
    setPlatform("darwin");
    expect(resolveRuntimePlatform()).toBe("darwin");
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

describe("evaluateRuntimeRequires", () => {
  it("accepts remote bins and remote any-bin matches", () => {
    const result = evaluateRuntimeRequires({
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
      isConfigPathTruthy: (path) => path === "browser.enabled",
    });

    expect(result).toBe(true);
  });

  it("rejects when any required runtime check is still unsatisfied", () => {
    expect(
      evaluateRuntimeRequires({
        requires: { bins: ["node"] },
        hasBin: () => false,
        hasEnv: () => true,
        isConfigPathTruthy: () => true,
      }),
    ).toBe(false);

    expect(
      evaluateRuntimeRequires({
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
      isConfigPathTruthy: (path) => path === "browser.enabled",
    });
    expect(result).toBe(true);
  });
});
