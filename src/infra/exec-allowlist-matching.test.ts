// Covers exec allowlist pattern matching.
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

  it.each(["linux", "darwin", "win32"])(
    "honors argPattern checks for bare command-name matches on %s",
    (platform) => {
      const entries = [{ pattern: "rg", argPattern: "^--json$" }];

      expect(matchAllowlist(entries, baseResolution, ["rg", "--json"], platform)?.pattern).toBe(
        "rg",
      );
      expect(matchAllowlist(entries, baseResolution, ["rg", "--files"], platform)).toBeNull();
    },
  );

  describe("argPattern path matches", () => {
    const resolution = {
      rawExecutable: "python3",
      resolvedPath: "/usr/bin/python3",
      resolvedRealPath: "/usr/bin/python3",
      executableName: "python3",
    };

    it("matches path-only entries regardless of argv", () => {
      const entry = { pattern: "/usr/bin/python3" };
      const entries: ExecAllowlistEntry[] = [entry];

      expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBe(entry);
      expect(matchAllowlist(entries, resolution, ["python3", "b.py"])).toBe(entry);
      expect(matchAllowlist(entries, resolution, ["python3"])).toBe(entry);
    });

    it("ignores legacy generated path-only allow-always entries", () => {
      const legacyGenerated = { pattern: "/usr/bin/python3", source: "allow-always" as const };
      const manual = { pattern: "/usr/bin/python3" };

      expect(matchAllowlist([legacyGenerated], resolution, ["python3", "b.py"])).toBeNull();
      expect(matchAllowlist([manual], resolution, ["python3", "b.py"])).toBe(manual);
    });

    it("matches argPattern entries with regex", () => {
      const entry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const entries: ExecAllowlistEntry[] = [entry];

      expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBe(entry);
      expect(matchAllowlist(entries, resolution, ["python3", "b.py"])).toBeNull();
      expect(matchAllowlist(entries, resolution, ["python3", "a.py", "--verbose"])).toBeNull();
    });

    it("does not discard redirect-shaped direct argv literals", () => {
      const restricted = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
      const explicit = {
        pattern: "/usr/bin/python3",
        argPattern: "^a\\.py 2>/dev/null$",
      };
      const argv = ["python3", "a.py", "2>/dev/null"];

      expect(matchAllowlist([restricted], resolution, argv)).toBeNull();
      expect(matchAllowlist([explicit], resolution, argv)).toBe(explicit);
    });

    it.each(["linux", "darwin", "win32"])(
      "prefers argPattern matches over path-only matches on %s",
      (platform) => {
        const pathOnlyEntry = { pattern: "/usr/bin/python3" };
        const argPatternEntry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
        const entries: ExecAllowlistEntry[] = [pathOnlyEntry, argPatternEntry];

        const match = matchAllowlist(entries, resolution, ["python3", "a.py"], platform);

        expect(match).toBe(argPatternEntry);
      },
    );

    it.each(["linux", "darwin", "win32"])(
      "falls back to path-only matches when argPattern does not match on %s",
      (platform) => {
        const pathOnlyEntry = { pattern: "/usr/bin/python3" };
        const argPatternEntry = { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" };
        const entries: ExecAllowlistEntry[] = [pathOnlyEntry, argPatternEntry];

        const match = matchAllowlist(entries, resolution, ["python3", "b.py"], platform);

        expect(match).toBe(pathOnlyEntry);
      },
    );

    it.each(["linux", "darwin", "win32"])(
      "requires argv before matching argPattern entries on %s",
      (platform) => {
        const restrictedEntries: ExecAllowlistEntry[] = [
          { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" },
        ];
        const mixedEntries: ExecAllowlistEntry[] = [
          { pattern: "/usr/bin/python3", argPattern: "^a\\.py$" },
          { pattern: "/usr/bin/python3" },
        ];

        expect(matchAllowlist(restrictedEntries, resolution, undefined, platform)).toBeNull();
        expect(matchAllowlist(mixedEntries, resolution, undefined, platform)).toBe(mixedEntries[1]);
      },
    );

    it("handles invalid regex gracefully", () => {
      const entries: ExecAllowlistEntry[] = [
        { pattern: "/usr/bin/python3", argPattern: "[invalid" },
      ];

      expect(matchAllowlist(entries, resolution, ["python3", "a.py"])).toBeNull();
    });

    it("rejects split-arg bypasses against single-arg auto-generated argPattern", () => {
      const entry = { pattern: "/usr/bin/python3", argPattern: "^hello world\x00$" };
      const entries: ExecAllowlistEntry[] = [entry];

      expect(matchAllowlist(entries, resolution, ["python3", "hello world"])).toBe(entry);
      expect(matchAllowlist(entries, resolution, ["python3", "hello", "world"])).toBeNull();
    });

    it("distinguishes zero-arg patterns from one-empty-string-arg patterns", () => {
      const zeroArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00\x00$" };
      const emptyArgEntry = { pattern: "/usr/bin/python3", argPattern: "^\x00$" };

      expect(matchAllowlist([zeroArgEntry], resolution, ["python3"])).toBe(zeroArgEntry);
      expect(matchAllowlist([emptyArgEntry], resolution, ["python3"])).toBeNull();
      expect(matchAllowlist([emptyArgEntry], resolution, ["python3", ""])).toBe(emptyArgEntry);
      expect(matchAllowlist([zeroArgEntry], resolution, ["python3", ""])).toBeNull();
    });
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

  it.runIf(process.platform !== "win32")(
    "rejects wildcard path matches that escape through dot segments",
    () => {
      expect(
        matchAllowlist([{ pattern: "/usr/bin/**" }], {
          rawExecutable: "/usr/bin/../../bin/sh",
          resolvedPath: "/usr/bin/../../bin/sh",
          executableName: "sh",
        }),
      ).toBeNull();
      expect(
        matchAllowlist([{ pattern: "/usr/bin/**" }], {
          rawExecutable: "/usr/bin/sub/../env",
          resolvedPath: "/usr/bin/sub/../env",
          executableName: "env",
        })?.pattern,
      ).toBe("/usr/bin/**");
    },
  );

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

  it("matches path-shaped allowlist entries against the executable trust realpath", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      resolvedRealPath: "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg",
      executableName: "rg",
    };

    expect(
      matchAllowlist([{ pattern: "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg" }], resolution)
        ?.pattern,
    ).toBe("/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg");
    expect(matchAllowlist([{ pattern: "/opt/homebrew/bin/rg" }], resolution)).toBeNull();
  });

  it("keeps basename allowlist entries on the PATH-resolved executable name", () => {
    const resolution = {
      rawExecutable: "rg",
      resolvedPath: "/opt/homebrew/bin/rg",
      resolvedRealPath: "/opt/homebrew/Cellar/ripgrep/14.1.1/bin/rg",
      executableName: "rg",
    };

    expect(matchAllowlist([{ pattern: "rg" }], resolution)?.pattern).toBe("rg");
  });
});
