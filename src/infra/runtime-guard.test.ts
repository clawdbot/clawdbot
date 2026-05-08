import { describe, expect, it, vi } from "vitest";
import {
  assertSupportedRuntime,
  detectRuntime,
  isAtLeast,
  isSupportedNodeVersion,
  nodeVersionSatisfiesEngine,
  parseMinimumNodeEngine,
  parseSemver,
  type RuntimeDetails,
  runtimeSatisfies,
} from "./runtime-guard.js";

describe("runtime-guard", () => {
  it("parses semver with or without leading v", () => {
    expect(parseSemver("v22.1.3")).toEqual({ major: 22, minor: 1, patch: 3 });
    expect(parseSemver("1.3.0")).toEqual({ major: 1, minor: 3, patch: 0 });
    expect(parseSemver("22.16.0-beta.1")).toEqual({ major: 22, minor: 16, patch: 0 });
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

  it("validates runtime thresholds", () => {
    const nodeOk: RuntimeDetails = {
      kind: "node",
      version: "22.16.0",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
    };
    const nodeOld: RuntimeDetails = { ...nodeOk, version: "22.15.0" };
    const nodeTooOld: RuntimeDetails = { ...nodeOk, version: "21.9.0" };
    const unknown: RuntimeDetails = {
      kind: "unknown",
      version: null,
      execPath: null,
      pathEnv: "/usr/bin",
    };
    expect(runtimeSatisfies(nodeOk)).toBe(true);
    expect(runtimeSatisfies(nodeOld)).toBe(false);
    expect(runtimeSatisfies(nodeTooOld)).toBe(false);
    expect(runtimeSatisfies(unknown)).toBe(false);
    expect(isSupportedNodeVersion("22.16.0")).toBe(true);
    expect(isSupportedNodeVersion("22.15.9")).toBe(false);
    expect(isSupportedNodeVersion(null)).toBe(false);
  });

  it("parses simple minimum node engine ranges", () => {
    expect(parseMinimumNodeEngine(">=22.16.0")).toEqual({ major: 22, minor: 16, patch: 0 });
    expect(parseMinimumNodeEngine(" >=v24.0.0 ")).toEqual({ major: 24, minor: 0, patch: 0 });
    expect(parseMinimumNodeEngine("^22.16.0")).toBeNull();
  });

  it("checks node versions against simple engine ranges", () => {
    expect(nodeVersionSatisfiesEngine("22.16.0", ">=22.16.0")).toBe(true);
    expect(nodeVersionSatisfiesEngine("22.15.9", ">=22.16.0")).toBe(false);
    expect(nodeVersionSatisfiesEngine("24.0.0", ">=22.16.0")).toBe(true);
    expect(nodeVersionSatisfiesEngine("22.16.0", "^22.16.0")).toBeNull();
  });

  it("throws via exit when runtime is too old", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details: RuntimeDetails = {
      kind: "node",
      version: "20.0.0",
      execPath: "/usr/bin/node",
      pathEnv: "/usr/bin",
    };
    expect(() => assertSupportedRuntime(runtime, details)).toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("requires Node"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Detected: node 20.0.0"));
  });

  it("returns silently when runtime meets requirements", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const details: RuntimeDetails = {
      ...detectRuntime(),
      kind: "node",
      version: "22.16.0",
      execPath: "/usr/bin/node",
    };
    expect(() => assertSupportedRuntime(runtime, details)).not.toThrow();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports unknown runtimes with fallback labels", () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw new Error("exit");
      }),
    };
    const details: RuntimeDetails = {
      kind: "unknown",
      version: null,
      execPath: null,
      pathEnv: "(not set)",
    };

    expect(() => assertSupportedRuntime(runtime, details)).toThrow("exit");
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Detected: unknown runtime (exec: unknown)."),
    );
  });
});
