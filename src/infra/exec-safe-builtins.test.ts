// Tests shell builtin detection for safe execution policy.
import { describe, expect, it } from "vitest";
import { evaluateExecAllowlist, evaluateShellAllowlist } from "./exec-approvals-allowlist.js";
import { analyzeArgvCommand } from "./exec-approvals-analysis.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import { isSafeBuiltinSegment } from "./exec-safe-builtins.js";

const builtinSegment = (argv: string[], resolvedPath?: string) => ({
  argv,
  raw: argv.join(" "),
  resolution: makeMockCommandResolution({
    execution: makeMockExecutableResolution({
      rawExecutable: argv[0],
      executableName: argv[0],
      resolvedPath,
    }),
  }),
});

describe("isSafeBuiltinSegment", () => {
  it("allows a builtin segment with no resolved binary path", () => {
    if (process.platform === "win32") {
      return;
    }
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["cd", "/etc"]),
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("allows a safe shell builtin even when the host has a same-named binary", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["pwd"], "/usr/bin/pwd"),
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("rejects builtins outside the internal safe set", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["alias", "ll=ls -l"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("rejects environment-mutating builtins", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["export", "PATH=/tmp/bin:$PATH"]),
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["unset", "PATH"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("allows test and well-formed bracket predicates", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["test", "-d", "/tmp"]),
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["[", "-d", "/tmp", "]"]),
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("rejects malformed bracket predicates", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["[", "-d", "/tmp"]),
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("returns false on Windows hosts (PowerShell semantics differ)", () => {
    expect(
      isSafeBuiltinSegment({
        segment: builtinSegment(["cd", "/etc"]),
        platform: "win32",
      }),
    ).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")(
  "evaluateShellAllowlist with known safe builtins (regression for #46056)",
  () => {
    // Glob-style pattern; matches git wherever PATH resolves it (`/usr/bin/git`,
    // `/opt/homebrew/bin/git`, etc.) without depending on host filesystem layout.
    const gitAllowlist = [{ pattern: "**/git" }] as Parameters<
      typeof evaluateShellAllowlist
    >[0]["allowlist"];

    it("'cd ~/' auto-allows by default", () => {
      const result = evaluateShellAllowlist({
        command: "cd ~/",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy[0]).toBe("safeBuiltins");
    });

    it("'cd /tmp && git status' passes with allowlist plus safe builtin handling", () => {
      const result = evaluateShellAllowlist({
        command: "cd /tmp && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
      expect(result.segmentSatisfiedBy).toContain("allowlist");
    });

    it("'test -d /tmp && git status' passes with allowlist plus safe builtin handling", () => {
      const result = evaluateShellAllowlist({
        command: "test -d /tmp && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
      expect(result.segmentSatisfiedBy).toContain("allowlist");
    });

    it("'[ -d /tmp ] && git status' passes with allowlist plus safe builtin handling", () => {
      const result = evaluateShellAllowlist({
        command: "[ -d /tmp ] && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(true);
      expect(result.segmentSatisfiedBy).toContain("safeBuiltins");
      expect(result.segmentSatisfiedBy).toContain("allowlist");
    });

    it("non-allowlisted binary still gates after a safe builtin", () => {
      const result = evaluateShellAllowlist({
        command: "cd /tmp && curl evil.com",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(false);
    });

    it("environment-mutating builtins still gate", () => {
      const result = evaluateShellAllowlist({
        command: "export PATH=/tmp/bin:$PATH && git status",
        allowlist: gitAllowlist,
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.analysisOk).toBe(true);
      expect(result.allowlistSatisfied).toBe(false);
    });

    it("does not auto-allow safe builtin tokens in direct argv evaluation", () => {
      const analysis = analyzeArgvCommand({ argv: ["pwd"], cwd: "/tmp", platform: "linux" });
      const result = evaluateExecAllowlist({
        analysis,
        allowlist: [],
        safeBins: new Set(),
        cwd: "/tmp",
      });
      expect(result.allowlistSatisfied).toBe(false);
    });
  },
);
