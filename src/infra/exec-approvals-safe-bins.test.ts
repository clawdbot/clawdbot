import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
  makePathEnv,
  makeTempDir,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  isSafeBinUsage,
  normalizeSafeBins,
  resolveSafeBins,
} from "./exec-approvals.js";
import {
  SAFE_BIN_PROFILE_FIXTURES,
  SAFE_BIN_PROFILES,
  resolveSafeBinProfiles,
} from "./exec-safe-bin-policy.js";

describe("exec approvals safe bins", () => {
  type SafeBinCase = {
    name: string;
    argv: string[];
    resolvedPath: string;
    expected: boolean;
    safeBins?: string[];
    safeBinProfiles?: Readonly<Record<string, { minPositional?: number; maxPositional?: number }>>;
    executableName?: string;
    rawExecutable?: string;
    cwd?: string;
    setup?: (cwd: string) => void;
  };

  function buildDeniedFlagVariantCases(params: {
    executableName: string;
    resolvedPath: string;
    safeBins?: string[];
    flag: string;
    takesValue: boolean;
    label: string;
  }): SafeBinCase[] {
    const value = "blocked";
    const argvVariants: string[][] = [];
    if (!params.takesValue) {
      argvVariants.push([params.executableName, params.flag]);
    } else if (params.flag.startsWith("--")) {
      argvVariants.push([params.executableName, `${params.flag}=${value}`]);
      argvVariants.push([params.executableName, params.flag, value]);
    } else if (params.flag.startsWith("-")) {
      argvVariants.push([params.executableName, `${params.flag}${value}`]);
      argvVariants.push([params.executableName, params.flag, value]);
    } else {
      argvVariants.push([params.executableName, params.flag, value]);
    }
    return argvVariants.map((argv) => ({
      name: `${params.label} (${argv.slice(1).join(" ")})`,
      argv,
      resolvedPath: params.resolvedPath,
      expected: false,
      safeBins: params.safeBins ?? [params.executableName],
      executableName: params.executableName,
    }));
  }

  const deniedFlagCases: SafeBinCase[] = [
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "-o",
      takesValue: true,
      label: "blocks sort output flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "--output",
      takesValue: true,
      label: "blocks sort output flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "--compress-program",
      takesValue: true,
      label: "blocks sort external program flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "--compress-prog",
      takesValue: true,
      label: "blocks sort denied flag abbreviations",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "--files0-fro",
      takesValue: true,
      label: "blocks sort denied flag abbreviations",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "--random-source",
      takesValue: true,
      label: "blocks sort filesystem-dependent flags",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "--temporary-directory",
      takesValue: true,
      label: "blocks sort filesystem-dependent flags",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "sort",
      resolvedPath: "/usr/bin/sort",
      flag: "-T",
      takesValue: true,
      label: "blocks sort filesystem-dependent flags",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "grep",
      resolvedPath: "/usr/bin/grep",
      flag: "-R",
      takesValue: false,
      label: "blocks grep recursive flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "grep",
      resolvedPath: "/usr/bin/grep",
      flag: "--recursive",
      takesValue: false,
      label: "blocks grep recursive flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "grep",
      resolvedPath: "/usr/bin/grep",
      flag: "--file",
      takesValue: true,
      label: "blocks grep file-pattern flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "jq",
      resolvedPath: "/usr/bin/jq",
      flag: "-f",
      takesValue: true,
      label: "blocks jq file-program flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "jq",
      resolvedPath: "/usr/bin/jq",
      flag: "--from-file",
      takesValue: true,
      label: "blocks jq file-program flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "wc",
      resolvedPath: "/usr/bin/wc",
      flag: "--files0-from",
      takesValue: true,
      label: "blocks wc file-list flag",
    }),
    ...buildDeniedFlagVariantCases({
      executableName: "wc",
      resolvedPath: "/usr/bin/wc",
      flag: "--files0-fro",
      takesValue: true,
      label: "blocks wc denied flag abbreviations",
    }),
  ];

  const cases: SafeBinCase[] = [
    {
      name: "allows safe bins with non-path args",
      argv: ["jq", ".foo"],
      resolvedPath: "/usr/bin/jq",
      expected: true,
    },
    {
      name: "blocks jq env builtin even when jq is explicitly opted in",
      argv: ["jq", "env"],
      resolvedPath: "/usr/bin/jq",
      expected: false,
    },
    {
      name: "blocks jq $ENV builtin variable even when jq is explicitly opted in",
      argv: ["jq", "$ENV"],
      resolvedPath: "/usr/bin/jq",
      expected: false,
    },
    {
      name: "blocks jq $ENV property access even when jq is explicitly opted in",
      argv: ["jq", "($ENV).OPENAI_API_KEY"],
      resolvedPath: "/usr/bin/jq",
      expected: false,
    },
    {
      name: "blocks awk scripts even when awk is explicitly profiled",
      argv: ["awk", 'BEGIN { system("id") }'],
      resolvedPath: "/usr/bin/awk",
      expected: false,
      safeBins: ["awk"],
      safeBinProfiles: { awk: {} },
      executableName: "awk",
    },
    {
      name: "blocks sed scripts even when sed is explicitly profiled",
      argv: ["sed", "e"],
      resolvedPath: "/usr/bin/sed",
      expected: false,
      safeBins: ["sed"],
      safeBinProfiles: { sed: {} },
      executableName: "sed",
    },
    {
      name: "blocks safe bins with file args",
      argv: ["jq", ".foo", "secret.json"],
      resolvedPath: "/usr/bin/jq",
      expected: false,
      setup: (cwd) => fs.writeFileSync(path.join(cwd, "secret.json"), "{}"),
    },
    {
      name: "blocks POSIX parameter expansion in safe-bin value tokens",
      argv: ["head", "-c${IFS}16${IFS}${OPENCLAW_CONFIG_PATH}"],
      resolvedPath: "/usr/bin/head",
      expected: false,
      safeBins: ["head"],
      executableName: "head",
    },
    {
      name: "blocks POSIX parameter expansion in safe-bin long option values",
      argv: ["head", "--bytes=${IFS}16"],
      resolvedPath: "/usr/bin/head",
      expected: false,
      safeBins: ["head"],
      executableName: "head",
    },
    {
      name: "blocks POSIX parameter expansion in safe-bin positional tokens",
      argv: ["tr", "${IFS}", "_"],
      resolvedPath: "/usr/bin/tr",
      expected: false,
      safeBins: ["tr"],
      executableName: "tr",
    },
    {
      name: "blocks safe bins resolved from untrusted directories",
      argv: ["jq", ".foo"],
      resolvedPath: "/tmp/evil-bin/jq",
      expected: false,
      cwd: "/tmp",
    },
    ...deniedFlagCases,
    {
      name: "blocks grep file positional when pattern uses -e",
      argv: ["grep", "-e", "needle", ".env"],
      resolvedPath: "/usr/bin/grep",
      expected: false,
      safeBins: ["grep"],
      executableName: "grep",
    },
    {
      name: "blocks grep file positional after -- terminator",
      argv: ["grep", "-e", "needle", "--", ".env"],
      resolvedPath: "/usr/bin/grep",
      expected: false,
      safeBins: ["grep"],
      executableName: "grep",
    },
    {
      name: "rejects unknown long options in safe-bin mode",
      argv: ["sort", "--totally-unknown=1"],
      resolvedPath: "/usr/bin/sort",
      expected: false,
      safeBins: ["sort"],
      executableName: "sort",
    },
    {
      name: "rejects ambiguous long-option abbreviations in safe-bin mode",
      argv: ["sort", "--f=1"],
      resolvedPath: "/usr/bin/sort",
      expected: false,
      safeBins: ["sort"],
      executableName: "sort",
    },
    {
      name: "rejects unknown short options in safe-bin mode",
      argv: ["tr", "-S", "a", "b"],
      resolvedPath: "/usr/bin/tr",
      expected: false,
      safeBins: ["tr"],
      executableName: "tr",
    },
  ];

  it.runIf(process.platform !== "win32").each(cases)("$name", (testCase) => {
    const cwd = testCase.cwd ?? makeTempDir();
    testCase.setup?.(cwd);
    const executableName = testCase.executableName ?? "jq";
    const rawExecutable = testCase.rawExecutable ?? executableName;
    const ok = isSafeBinUsage({
      argv: testCase.argv,
      resolution: {
        rawExecutable,
        resolvedPath: testCase.resolvedPath,
        executableName,
      },
      safeBins: normalizeSafeBins(testCase.safeBins ?? [executableName]),
      safeBinProfiles: testCase.safeBinProfiles,
    });
    expect(ok).toBe(testCase.expected);
  });

  it("supports injected trusted safe-bin dirs for tests/callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const ok = isSafeBinUsage({
      argv: ["jq", ".foo"],
      resolution: {
        rawExecutable: "jq",
        resolvedPath: "/custom/bin/jq",
        executableName: "jq",
      },
      safeBins: normalizeSafeBins(["jq"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
    });
    expect(ok).toBe(true);
  });

  it("supports injected platform for deterministic safe-bin checks", () => {
    const ok = isSafeBinUsage({
      argv: ["jq", ".foo"],
      resolution: {
        rawExecutable: "jq",
        resolvedPath: "/usr/bin/jq",
        executableName: "jq",
      },
      safeBins: normalizeSafeBins(["jq"]),
      platform: "win32",
    });
    expect(ok).toBe(false);
  });

  it("supports injected trusted path checker for deterministic callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const baseParams = {
      argv: ["jq", ".foo"],
      resolution: {
        rawExecutable: "jq",
        resolvedPath: "/tmp/custom/jq",
        executableName: "jq",
      },
      safeBins: normalizeSafeBins(["jq"]),
    };
    expect(
      isSafeBinUsage({
        ...baseParams,
        isTrustedSafeBinPathFn: () => true,
      }),
    ).toBe(true);
    expect(
      isSafeBinUsage({
        ...baseParams,
        isTrustedSafeBinPathFn: () => false,
      }),
    ).toBe(false);
  });

  it("keeps safe-bin profile fixtures aligned with compiled profiles", () => {
    for (const [name, fixture] of Object.entries(SAFE_BIN_PROFILE_FIXTURES)) {
      const profile = SAFE_BIN_PROFILES[name];
      if (profile === undefined) {
        throw new Error(`missing compiled safe-bin profile fixture ${name}`);
      }
      const fixtureDeniedFlags = fixture.deniedFlags ?? [];
      const compiledDeniedFlags = profile.deniedFlags ?? new Set<string>();
      for (const deniedFlag of fixtureDeniedFlags) {
        expect(compiledDeniedFlags.has(deniedFlag)).toBe(true);
      }
      expect(Array.from(compiledDeniedFlags).toSorted()).toEqual(
        [...fixtureDeniedFlags].toSorted(),
      );
    }
  });

  it("does not include sort/grep in default safeBins", () => {
    const defaults = resolveSafeBins(undefined);
    expect(defaults.has("jq")).toBe(false);
    expect(defaults.has("sort")).toBe(false);
    expect(defaults.has("grep")).toBe(false);
  });

  it("does not auto-allow unprofiled safe-bin entries", () => {
    if (process.platform === "win32") {
      return;
    }
    const result = evaluateShellAllowlist({
      command: "python3 -c \"print('owned')\"",
      allowlist: [],
      safeBins: normalizeSafeBins(["python3"]),
      cwd: "/tmp",
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
  });

  it("allows caller-defined custom safe-bin profiles", () => {
    if (process.platform === "win32") {
      return;
    }
    const safeBinProfiles = resolveSafeBinProfiles({
      echo: {
        maxPositional: 1,
      },
    });
    const allow = isSafeBinUsage({
      argv: ["echo", "hello"],
      resolution: {
        rawExecutable: "echo",
        resolvedPath: "/bin/echo",
        executableName: "echo",
      },
      safeBins: normalizeSafeBins(["echo"]),
      safeBinProfiles,
    });
    const deny = isSafeBinUsage({
      argv: ["echo", "hello", "world"],
      resolution: {
        rawExecutable: "echo",
        resolvedPath: "/bin/echo",
        executableName: "echo",
      },
      safeBins: normalizeSafeBins(["echo"]),
      safeBinProfiles,
    });
    expect(allow).toBe(true);
    expect(deny).toBe(false);
  });

  it("blocks sort output flags independent of file existence", () => {
    if (process.platform === "win32") {
      return;
    }
    const cwd = makeTempDir();
    fs.writeFileSync(path.join(cwd, "existing.txt"), "x");
    const resolution = {
      rawExecutable: "sort",
      resolvedPath: "/usr/bin/sort",
      executableName: "sort",
    };
    const safeBins = normalizeSafeBins(["sort"]);
    const existing = isSafeBinUsage({
      argv: ["sort", "-o", "existing.txt"],
      resolution,
      safeBins,
    });
    const missing = isSafeBinUsage({
      argv: ["sort", "-o", "missing.txt"],
      resolution,
      safeBins,
    });
    const longFlag = isSafeBinUsage({
      argv: ["sort", "--output=missing.txt"],
      resolution,
      safeBins,
    });
    expect(existing).toBe(false);
    expect(missing).toBe(false);
    expect(longFlag).toBe(false);
  });

  it("threads trusted safe-bin dirs through allowlist evaluation", () => {
    if (process.platform === "win32") {
      return;
    }
    const analysis = {
      ok: true as const,
      segments: [
        {
          raw: "jq .foo",
          argv: ["jq", ".foo"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "jq",
              resolvedPath: "/custom/bin/jq",
              executableName: "jq",
            }),
          }),
        },
      ],
    };
    const denied = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["jq"]),
      trustedSafeBinDirs: new Set(["/usr/bin"]),
      cwd: "/tmp",
    });
    expect(denied.allowlistSatisfied).toBe(false);

    const allowed = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["jq"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
      cwd: "/tmp",
    });
    expect(allowed.allowlistSatisfied).toBe(true);
  });

  it("does not auto-trust PATH-shadowed safe bins without explicit trusted dirs", () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = makeTempDir();
    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeHead = path.join(fakeDir, "head");
    fs.writeFileSync(fakeHead, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeHead, 0o755);

    const result = evaluateShellAllowlist({
      command: "head -n 1",
      allowlist: [],
      safeBins: normalizeSafeBins(["head"]),
      env: makePathEnv(fakeDir),
      cwd: tmp,
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
    expect(result.segments[0]?.resolution?.execution.resolvedPath).toBe(fakeHead);
  });

  it("fails closed for semantic env wrappers in allowlist mode", () => {
    if (process.platform === "win32") {
      return;
    }
    const result = evaluateShellAllowlist({
      command: "env -S 'sh -c \"echo pwned\"' tr",
      allowlist: [{ pattern: "/usr/bin/tr" }],
      safeBins: normalizeSafeBins(["tr"]),
      cwd: "/tmp",
      platform: process.platform,
    });
    expect(result.analysisOk).toBe(true);
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
    expect(result.segments[0]?.resolution?.policyBlocked).toBe(true);
  });
});
