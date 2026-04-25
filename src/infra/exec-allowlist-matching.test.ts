import { describe, expect, it } from "vitest";
import { matchAllowlist, type ExecAllowlistEntry } from "./exec-approvals.js";

describe("exec allowlist matching", () => {
  const baseResolution = {
    rawExecutable: "rg",
    resolvedPath: "/opt/homebrew/bin/rg",
    executableName: "rg",
  };

  it("handles wildcard and path matching semantics", () => {
    const cases: Array<{ entries: ExecAllowlistEntry[]; expectedPattern: string | null }> = [
      { entries: [{ pattern: "RG" }], expectedPattern: null },
      { entries: [{ pattern: "not-rg" }], expectedPattern: null },
      { entries: [{ pattern: "/opt/**/rg" }], expectedPattern: "/opt/**/rg" },
      { entries: [{ pattern: "/opt/*/rg" }], expectedPattern: null },
    ];
    for (const { entries, expectedPattern } of cases) {
      const match = matchAllowlist(entries, baseResolution);
      expect(match?.pattern ?? null).toBe(expectedPattern);
    }
  });

  it("matches bare command-name patterns against PATH-resolved executable basenames", () => {
    expect(matchAllowlist([{ pattern: "rg" }], baseResolution)?.pattern).toBe("rg");
    expect(matchAllowlist([{ pattern: "r?" }], baseResolution)?.pattern).toBe("r?");
    expect(matchAllowlist([{ pattern: "homebrew" }], baseResolution)).toBeNull();
  });

  it("does not let bare command-name patterns match path-selected executables", () => {
    const relativeResolution = {
      rawExecutable: "./rg",
      resolvedPath: "/tmp/openclaw-workspace/rg",
      executableName: "rg",
    };
    const absoluteResolution = {
      rawExecutable: "/tmp/openclaw-workspace/rg",
      resolvedPath: "/tmp/openclaw-workspace/rg",
      executableName: "rg",
    };

    expect(matchAllowlist([{ pattern: "rg" }], relativeResolution)).toBeNull();
    expect(matchAllowlist([{ pattern: "rg" }], absoluteResolution)).toBeNull();
  });

  it("honors Windows argPattern checks for bare command-name matches", () => {
    const entries = [{ pattern: "rg", argPattern: "^--json$" }];

    expect(matchAllowlist(entries, baseResolution, ["rg", "--json"], "win32")?.pattern).toBe("rg");
    expect(matchAllowlist(entries, baseResolution, ["rg", "--files"], "win32")).toBeNull();
  });

  it("matches bare wildcard patterns against arbitrary resolved executables", () => {
    const cases = [
      baseResolution,
      {
        rawExecutable: "python3",
        resolvedPath: "/usr/bin/python3",
        executableName: "python3",
      },
    ] as const;
    for (const resolution of cases) {
      expect(matchAllowlist([{ pattern: "*" }], resolution)?.pattern).toBe("*");
    }
  });

  it("matches absolute paths containing regex metacharacters literally", () => {
    const plusPathCases = ["/usr/bin/g++", "/usr/bin/clang++"] as const;
    for (const candidatePath of plusPathCases) {
      const match = matchAllowlist([{ pattern: candidatePath }], {
        rawExecutable: candidatePath,
        resolvedPath: candidatePath,
        executableName: candidatePath.split("/").at(-1) ?? candidatePath,
      });
      expect(match?.pattern).toBe(candidatePath);
    }

    const literalCases = [
      {
        pattern: "/usr/bin/*++",
        resolution: {
          rawExecutable: "/usr/bin/g++",
          resolvedPath: "/usr/bin/g++",
          executableName: "g++",
        },
      },
      {
        pattern: "/opt/builds/tool[1](stable)",
        resolution: {
          rawExecutable: "/opt/builds/tool[1](stable)",
          resolvedPath: "/opt/builds/tool[1](stable)",
          executableName: "tool[1](stable)",
        },
      },
    ] as const;
    for (const { pattern, resolution } of literalCases) {
      expect(matchAllowlist([{ pattern }], resolution)?.pattern).toBe(pattern);
    }
  });
});
