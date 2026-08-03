// Covers safe-bin allowlist behavior.
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
  evaluateShellAllowlistWithAuthorization,
  isSafeBinUsage,
  normalizeSafeBins,
  resolveSafeBins,
} from "./exec-approvals.js";
import { resolveSafeBinProfiles } from "./exec-safe-bin-policy.js";
import { getTrustedSafeBinDirs } from "./exec-safe-bin-trust.js";

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
    trusted?: boolean;
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
      name: "blocks jq safe bins even with non-path args",
      argv: ["jq", ".foo"],
      resolvedPath: "/usr/bin/jq",
      expected: false,
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
      name: "blocks jq include directives even when jq is explicitly opted in",
      argv: ["jq", 'include "envdump"; envdump'],
      resolvedPath: "/usr/bin/jq",
      expected: false,
    },
    {
      name: "blocks jq import directives even when jq is explicitly opted in",
      argv: ["jq", 'import "envdump" as envdump; envdump::read'],
      resolvedPath: "/usr/bin/jq",
      expected: false,
    },
    {
      name: "blocks jq field names that match directive keywords",
      argv: ["jq", ".include + .import"],
      resolvedPath: "/usr/bin/jq",
      expected: false,
    },
    {
      name: "blocks jq object keys that match directive keywords",
      argv: ["jq", "{include: .foo, import : .bar}"],
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
      trusted: false,
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
    {
      name: "keeps tail -fn 1 follow mode approval-gated",
      argv: ["tail", "-fn", "1"],
      resolvedPath: "/usr/bin/tail",
      expected: false,
      safeBins: ["tail"],
      executableName: "tail",
    },
    {
      name: "auto-allows cut only-delimited mode with a field selector",
      argv: ["cut", "-s", "-f", "1"],
      resolvedPath: "/usr/bin/cut",
      expected: true,
      safeBins: ["cut"],
      executableName: "cut",
    },
    {
      name: "auto-allows head quiet mode",
      argv: ["head", "-q"],
      resolvedPath: "/usr/bin/head",
      expected: true,
      safeBins: ["head"],
      executableName: "head",
    },
    {
      name: "auto-allows tail quiet mode",
      argv: ["tail", "-q"],
      resolvedPath: "/usr/bin/tail",
      expected: true,
      safeBins: ["tail"],
      executableName: "tail",
    },
    {
      name: "auto-allows wc line count via boolean flag",
      argv: ["wc", "-l"],
      resolvedPath: "/usr/bin/wc",
      expected: true,
      safeBins: ["wc"],
      executableName: "wc",
    },
    {
      name: "auto-allows wc word count via boolean long flag",
      argv: ["wc", "--words"],
      resolvedPath: "/usr/bin/wc",
      expected: true,
      safeBins: ["wc"],
      executableName: "wc",
    },
    {
      name: "auto-allows uniq count via boolean flag",
      argv: ["uniq", "-c"],
      resolvedPath: "/usr/bin/uniq",
      expected: true,
      safeBins: ["uniq"],
      executableName: "uniq",
    },
    {
      name: "auto-allows tr delete via boolean flag",
      argv: ["tr", "-d", "abc"],
      resolvedPath: "/usr/bin/tr",
      expected: true,
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
      // This table isolates argv policy. Dedicated cases below exercise real path trust.
      isTrustedSafeBinPathFn: () => testCase.trusted ?? true,
    });
    expect(ok).toBe(testCase.expected);
  });

  it("supports injected trusted safe-bin dirs for tests/callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const ok = isSafeBinUsage({
      argv: ["head", "-n", "1"],
      resolution: {
        rawExecutable: "head",
        resolvedPath: "/custom/bin/head",
        executableName: "head",
      },
      safeBins: normalizeSafeBins(["head"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
    });
    expect(ok).toBe(true);
  });

  it("checks safe-bin trusted dirs against the real executable identity", () => {
    if (process.platform === "win32") {
      return;
    }
    const resolution = {
      rawExecutable: "head",
      resolvedPath: "/opt/homebrew/bin/head",
      resolvedRealPath: "/opt/homebrew/Cellar/coreutils/9.5/bin/head",
      executableName: "head",
    };
    expect(
      isSafeBinUsage({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: normalizeSafeBins(["head"]),
        trustedSafeBinDirs: new Set(["/opt/homebrew/bin"]),
      }),
    ).toBe(false);
    expect(
      isSafeBinUsage({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: normalizeSafeBins(["head"]),
        trustedSafeBinDirs: getTrustedSafeBinDirs({
          extraDirs: ["/opt/homebrew/Cellar/coreutils/9.5/bin"],
          refresh: true,
        }),
      }),
    ).toBe(true);
    expect(
      isSafeBinUsage({
        argv: ["head", "-n", "1"],
        resolution,
        safeBins: normalizeSafeBins(["head"]),
        trustedSafeBinDirs: new Set(["/tmp/other-bin"]),
      }),
    ).toBe(false);
  });

  it("supports injected platform for deterministic safe-bin checks", () => {
    const ok = isSafeBinUsage({
      argv: ["head", "-n", "1"],
      resolution: {
        rawExecutable: "head",
        resolvedPath: "/usr/bin/head",
        executableName: "head",
      },
      safeBins: normalizeSafeBins(["head"]),
      platform: "win32",
    });
    expect(ok).toBe(false);
  });

  it("supports injected trusted path checker for deterministic callers", () => {
    if (process.platform === "win32") {
      return;
    }
    const baseParams = {
      argv: ["head", "-n", "1"],
      resolution: {
        rawExecutable: "head",
        resolvedPath: "/tmp/custom/head",
        executableName: "head",
      },
      safeBins: normalizeSafeBins(["head"]),
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

  it("does not include sort/grep in default safeBins", () => {
    const defaults = resolveSafeBins(undefined);
    expect(defaults.has("jq")).toBe(false);
    expect(defaults.has("sort")).toBe(false);
    expect(defaults.has("grep")).toBe(false);
  });

  it("does not auto-allow unprofiled safe-bin entries", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluateShellAllowlistWithAuthorization({
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
        resolvedPath: "/opt/openclaw-test/bin/echo",
        executableName: "echo",
      },
      safeBins: normalizeSafeBins(["echo"]),
      safeBinProfiles,
      trustedSafeBinDirs: new Set(["/opt/openclaw-test/bin"]),
    });
    const deny = isSafeBinUsage({
      argv: ["echo", "hello", "world"],
      resolution: {
        rawExecutable: "echo",
        resolvedPath: "/opt/openclaw-test/bin/echo",
        executableName: "echo",
      },
      safeBins: normalizeSafeBins(["echo"]),
      safeBinProfiles,
      trustedSafeBinDirs: new Set(["/opt/openclaw-test/bin"]),
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
          raw: "head -n 1",
          argv: ["head", "-n", "1"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "head",
              resolvedPath: "/custom/bin/head",
              executableName: "head",
            }),
          }),
        },
      ],
    };
    const denied = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["head"]),
      trustedSafeBinDirs: new Set(["/usr/bin"]),
      cwd: "/tmp",
    });
    expect(denied.allowlistSatisfied).toBe(false);

    const allowed = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["head"]),
      trustedSafeBinDirs: new Set(["/custom/bin"]),
      cwd: "/tmp",
    });
    expect(allowed.allowlistSatisfied).toBe(true);
  });

  it("does not auto-trust PATH-shadowed safe bins without explicit trusted dirs", async () => {
    if (process.platform === "win32") {
      return;
    }
    const tmp = makeTempDir();
    const fakeDir = path.join(tmp, "fake-bin");
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeHead = path.join(fakeDir, "head");
    fs.writeFileSync(fakeHead, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakeHead, 0o755);

    const result = await evaluateShellAllowlistWithAuthorization({
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

  it("fails closed for semantic env wrappers in allowlist mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const result = await evaluateShellAllowlistWithAuthorization({
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
