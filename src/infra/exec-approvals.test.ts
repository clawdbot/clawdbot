import { describe, expect, it } from "vitest";
import { normalizeSafeBins } from "./exec-approvals-allowlist.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import { evaluateExecAllowlist, type ExecAllowlistEntry } from "./exec-approvals.js";

describe("exec approvals allowlist evaluation", () => {
  function evaluateAutoAllowSkills(params: {
    analysis: {
      ok: boolean;
      segments: Array<{
        raw: string;
        argv: string[];
        resolution: ReturnType<typeof makeMockCommandResolution>;
      }>;
    };
    resolvedPath: string;
  }) {
    return evaluateExecAllowlist({
      analysis: params.analysis,
      allowlist: [],
      safeBins: new Set(),
      skillBins: [{ name: "skill-bin", resolvedPath: params.resolvedPath }],
      autoAllowSkills: true,
      cwd: "/tmp",
    });
  }

  function expectAutoAllowSkillsMiss(result: ReturnType<typeof evaluateExecAllowlist>): void {
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentSatisfiedBy).toEqual([null]);
  }

  it("satisfies allowlist on exact match", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "tool",
          argv: ["tool"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "tool",
              resolvedPath: "/usr/bin/tool",
              executableName: "tool",
            }),
          }),
        },
      ],
    };
    const allowlist: ExecAllowlistEntry[] = [{ pattern: "/usr/bin/tool" }];
    const result = evaluateExecAllowlist({
      analysis,
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
  });

  it("satisfies allowlist via safe bins", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "jq .foo",
          argv: ["jq", ".foo"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "jq",
              resolvedPath: "/usr/bin/jq",
              executableName: "jq",
            }),
          }),
        },
      ],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [],
      safeBins: normalizeSafeBins(["jq"]),
      cwd: "/tmp",
    });
    // Safe bins are disabled on Windows (PowerShell parsing/expansion differences).
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches).toStrictEqual([]);
  });

  it("satisfies allowlist via auto-allow skills", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "skill-bin",
          argv: ["skill-bin", "--help"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "skill-bin",
              resolvedPath: "/opt/skills/skill-bin",
              executableName: "skill-bin",
            }),
          }),
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/opt/skills/skill-bin",
    });
    expect(result.allowlistSatisfied).toBe(true);
  });

  it("does not satisfy auto-allow skills for explicit relative paths", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "./skill-bin",
          argv: ["./skill-bin", "--help"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "./skill-bin",
              resolvedPath: "/tmp/skill-bin",
              executableName: "skill-bin",
            }),
          }),
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/tmp/skill-bin",
    });
    expectAutoAllowSkillsMiss(result);
  });

  it("does not satisfy auto-allow skills when command resolution is missing", () => {
    const analysis = {
      ok: true,
      segments: [
        {
          raw: "skill-bin --help",
          argv: ["skill-bin", "--help"],
          resolution: makeMockCommandResolution({
            execution: makeMockExecutableResolution({
              rawExecutable: "skill-bin",
              executableName: "skill-bin",
            }),
          }),
        },
      ],
    };
    const result = evaluateAutoAllowSkills({
      analysis,
      resolvedPath: "/opt/skills/skill-bin",
    });
    expectAutoAllowSkillsMiss(result);
  });

  it("returns empty segment details for chain misses", () => {
    const segment = {
      raw: "tool",
      argv: ["tool"],
      resolution: makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "tool",
          resolvedPath: "/usr/bin/tool",
          executableName: "tool",
        }),
      }),
    };
    const analysis = {
      ok: true,
      segments: [segment],
      chains: [[segment]],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [{ pattern: "/usr/bin/other" }],
      safeBins: new Set(),
      cwd: "/tmp",
    });
    expect(result.allowlistSatisfied).toBe(false);
    expect(result.allowlistMatches).toStrictEqual([]);
    expect(result.segmentSatisfiedBy).toStrictEqual([]);
  });

  it("aggregates segment satisfaction across chains", () => {
    const allowlistSegment = {
      raw: "tool",
      argv: ["tool"],
      resolution: makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "tool",
          resolvedPath: "/usr/bin/tool",
          executableName: "tool",
        }),
      }),
    };
    const safeBinSegment = {
      raw: "jq .foo",
      argv: ["jq", ".foo"],
      resolution: makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "jq",
          resolvedPath: "/usr/bin/jq",
          executableName: "jq",
        }),
      }),
    };
    const analysis = {
      ok: true,
      segments: [allowlistSegment, safeBinSegment],
      chains: [[allowlistSegment], [safeBinSegment]],
    };
    const result = evaluateExecAllowlist({
      analysis,
      allowlist: [{ pattern: "/usr/bin/tool" }],
      safeBins: normalizeSafeBins(["jq"]),
      cwd: "/tmp",
    });
    if (process.platform === "win32") {
      expect(result.allowlistSatisfied).toBe(false);
      return;
    }
    expect(result.allowlistSatisfied).toBe(true);
    expect(result.allowlistMatches.map((entry) => entry.pattern)).toEqual(["/usr/bin/tool"]);
    expect(result.segmentSatisfiedBy).toEqual(["allowlist", "safeBins"]);
  });
});
