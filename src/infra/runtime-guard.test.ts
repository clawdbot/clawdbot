// Covers runtime detection and version support checks.
import { describe, expect, it, vi } from "vitest";
import {
  assertSupportedRuntime,
  isAtLeast,
  isSupportedNodeVersion,
  nodeVersionSatisfiesEngine,
  parseSemver,
} from "./runtime-guard.js";

describe("runtime-guard", () => {
  it("parses semver with or without leading v", () => {
    expect(parseSemver("v22.1.3")).toEqual({ major: 22, minor: 1, patch: 3 });
    expect(parseSemver("1.3.0")).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(parseSemver("22.22.3-beta.1")).toEqual({ major: 22, minor: 22, patch: 3 });
    expect(parseSemver("invalid")).toBeNull();
  });

  it("compares versions correctly", () => {
    expect(isAtLeast({ major: 22, minor: 16, patch: 0 }, { major: 22, minor: 16, patch: 0 })).toBe(
      true,
    );
    expect(isAtLeast({ major: 22, minor: 17, patch: 0 }, { major: 22, minor: 16, patch: 0 })).toBe(
      true,
    );
    expect(isAtLeast({ major: 22, minor: 15, patch: 0 }, { major: 22, minor: 16, patch: 0 })).toBe(
      false,
    );
    expect(isAtLeast({ major: 21, minor: 9, patch: 0 }, { major: 22, minor: 16, patch: 0 })).toBe(
      false,
    );
  });

  it("checks node versions against simple engine ranges", () => {
    expect(nodeVersionSatisfiesEngine("22.22.3", ">=22.22.3")).toBe(true);
    expect(nodeVersionSatisfiesEngine("22.22.2", ">=22.22.3")).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.15.0", ">=22.22.3")).toBe(true);
    expect(nodeVersionSatisfiesEngine("22.22.3", "^22.22.3")).toBeNull();
  });

  it("checks node versions against the supported engine range", () => {
    const engine = ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0";
    expect(nodeVersionSatisfiesEngine("22.22.3", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine("22.22.2", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("23.11.0", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.14.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.15.0", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine("25.8.1", engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("25.9.0", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine("26.0.0", engine)).toBe(true);
    expect(nodeVersionSatisfiesEngine(null, engine)).toBe(false);
    expect(nodeVersionSatisfiesEngine("unknown", engine)).toBe(false);
  });

  it.each([
    ["22.22.3", true],
    ["22.22.2", false],
    ["23.11.0", false],
    ["24.14.1", false],
    ["24.15.0", true],
    ["25.8.1", false],
    ["25.9.0", true],
    ["26.0.0", true],
    [null, false],
  ] as const)("classifies supported Node version %s", (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });

  it("throws via exit when runtime is too old", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details = {
      kind: "node" as const,
      version: "20.0.0",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
    };
    expect(() => assertSupportedRuntime(runtime, details)).toThrow("exit");
    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw requires Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0.",
        "Detected: node 20.0.0 (exec: /usr/bin/node).",
        "PATH searched: /usr/bin",
        "Install Node: https://nodejs.org/en/download",
        "Upgrade Node and re-run openclaw.",
      ].join("\n"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("returns silently when runtime meets requirements", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const details = {
      kind: "node" as const,
      version: "22.22.3",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
    };
    expect(assertSupportedRuntime(runtime, details)).toBeUndefined();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects Bun because it does not provide node:sqlite", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details = {
      kind: "bun" as const,
      version: "1.3.14",
      execPath: "/usr/bin/bun",
      pathEnv: "/usr/bin",
    };

    expect(() => assertSupportedRuntime(runtime, details)).toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw cannot run under Bun because the runtime does not provide node:sqlite.",
        "Detected: bun 1.3.14 (exec: /usr/bin/bun).",
        "PATH searched: /usr/bin",
        "Install Node: https://nodejs.org/en/download",
        "Run OpenClaw with Node; Bun remains supported for installs and package scripts.",
      ].join("\n"),
    );
  });

  it("reports unknown runtimes with fallback labels", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details = {
      kind: "unknown" as const,
      version: null,
      execPath: null,
      pathEnv: "(not set)",
    };

    expect(() => assertSupportedRuntime(runtime, details)).toThrow("exit");
    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      [
        "openclaw requires Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0.",
        "Detected: unknown runtime (exec: unknown).",
        "PATH searched: (not set)",
        "Install Node: https://nodejs.org/en/download",
        "Upgrade Node and re-run openclaw.",
      ].join("\n"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
