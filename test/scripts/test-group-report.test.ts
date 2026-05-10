import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGroupedTestComparison,
  buildGroupedTestReport,
  renderGroupedTestComparison,
  resolveGroupKey,
  resolveTestArea,
} from "../../scripts/lib/test-group-report.mjs";
import {
  parseTestGroupReportArgs,
  resolveReportArtifactDirs,
} from "../../scripts/test-group-report.mjs";

describe("scripts/test-group-report grouping", () => {
  it("groups repo files by stable product area", () => {
    expect(resolveTestArea("extensions/discord/src/send.test.ts")).toBe("extensions/discord");
    expect(resolveTestArea("src/commands/agent.test.ts")).toBe("src/commands");
    expect(resolveTestArea("packages/plugin-sdk/src/index.test.ts")).toBe("packages/plugin-sdk");
    expect(resolveTestArea("ui/src/ui/views/chat.test.ts")).toBe("ui/views");
    expect(resolveTestArea("test/scripts/test-group-report.test.ts")).toBe("test/scripts");
  });

  it("supports folder and top-level grouping modes", () => {
    expect(resolveGroupKey("src/commands/agent.test.ts", "folder")).toBe("src/commands");
    expect(resolveGroupKey("extensions/browser/src/browser/pw.test.ts", "folder")).toBe(
      "extensions/browser/src",
    );
    expect(resolveGroupKey("extensions/browser/src/browser/pw.test.ts", "top")).toBe("extensions");
  });
});

describe("scripts/test-group-report aggregation", () => {
  it("aggregates file durations by group and config", () => {
    const report = buildGroupedTestReport({
      groupBy: "area",
      reports: [
        {
          config: "test/vitest/vitest.commands.config.ts",
          report: {
            testResults: [
              {
                name: path.join(process.cwd(), "src", "commands", "agent.test.ts"),
                startTime: 100,
                endTime: 700,
                assertionResults: [{}, {}],
              },
              {
                name: path.join(process.cwd(), "extensions", "discord", "src", "send.test.ts"),
                startTime: 200,
                endTime: 450,
                assertionResults: [{}],
              },
            ],
          },
        },
      ],
    });

    expect(report.totals).toEqual({ durationMs: 850, fileCount: 2, testCount: 3 });
    expect(report.groups.map((group) => [group.key, group.durationMs])).toEqual([
      ["src/commands", 600],
      ["extensions/discord", 250],
    ]);
    expect(report.configs).toStrictEqual([
      {
        configs: ["commands"],
        key: "commands",
        durationMs: 850,
        fileCount: 2,
        testCount: 3,
      },
    ]);
  });
});

describe("scripts/test-group-report comparison", () => {
  it("compares grouped reports by group, file, config, and run metrics", () => {
    const comparison = buildGroupedTestComparison({
      beforePath: "before.json",
      afterPath: "after.json",
      before: {
        groupBy: "area",
        totals: { durationMs: 1000, fileCount: 2, testCount: 4 },
        groups: [
          { key: "src/commands", durationMs: 700, fileCount: 1, testCount: 2 },
          { key: "extensions/discord", durationMs: 300, fileCount: 1, testCount: 2 },
        ],
        configs: [{ key: "commands", durationMs: 1000, fileCount: 2, testCount: 4 }],
        topFiles: [
          {
            config: "commands",
            file: "src/commands/agent.test.ts",
            group: "src/commands",
            durationMs: 700,
            testCount: 2,
          },
          {
            config: "commands",
            file: "extensions/discord/src/send.test.ts",
            group: "extensions/discord",
            durationMs: 300,
            testCount: 2,
          },
        ],
        runs: [
          {
            config: "test/vitest/vitest.commands.config.ts",
            elapsedMs: 2000,
            maxRssBytes: 1024 * 1024 * 100,
            status: 0,
          },
        ],
      },
      after: {
        groupBy: "area",
        totals: { durationMs: 900, fileCount: 2, testCount: 5 },
        groups: [{ key: "src/commands", durationMs: 900, fileCount: 2, testCount: 5 }],
        configs: [{ key: "commands", durationMs: 900, fileCount: 2, testCount: 5 }],
        topFiles: [
          {
            config: "commands",
            file: "src/commands/agent.test.ts",
            group: "src/commands",
            durationMs: 800,
            testCount: 3,
          },
          {
            config: "commands",
            file: "src/commands/new.test.ts",
            group: "src/commands",
            durationMs: 100,
            testCount: 2,
          },
        ],
        runs: [
          {
            config: "test/vitest/vitest.commands.config.ts",
            elapsedMs: 1800,
            maxRssBytes: 1024 * 1024 * 80,
            status: 0,
          },
        ],
      },
    });

    expect(comparison.totals.delta).toEqual({ durationMs: -100, fileCount: 0, testCount: 1 });
    const commandsGroup = comparison.groups.find((group) => group.key === "src/commands");
    expect(commandsGroup?.delta).toStrictEqual({ durationMs: 200, fileCount: 1, testCount: 3 });
    const removedDiscordFile = comparison.files.find(
      (file) => file.file === "extensions/discord/src/send.test.ts",
    );
    expect(removedDiscordFile?.status).toBe("removed");
    expect(removedDiscordFile?.delta).toStrictEqual({ durationMs: -300, testCount: -2 });
    expect(comparison.runs[0]?.key).toBe("commands");
    expect(comparison.runs[0]?.delta).toStrictEqual({
      elapsedMs: -200,
      maxRssBytes: -1024 * 1024 * 20,
    });

    expect(renderGroupedTestComparison(comparison, { limit: 2, topFiles: 2 })).toContain(
      "Top group regressions",
    );
  });
});

describe("scripts/test-group-report arg parsing", () => {
  it("parses repeatable config and passthrough args", () => {
    expect(
      parseTestGroupReportArgs([
        "--config",
        "a.ts",
        "--config",
        "b.ts",
        "--group-by",
        "folder",
        "--allow-failures",
        "--",
        "--maxWorkers=1",
      ]),
    ).toStrictEqual({
      allowFailures: true,
      compare: null,
      configs: ["a.ts", "b.ts"],
      fullSuite: false,
      groupBy: "folder",
      limit: 25,
      output: null,
      reports: [],
      rss: process.platform === "darwin",
      topFiles: 25,
      vitestArgs: ["--maxWorkers=1"],
    });
  });

  it("parses compare mode", () => {
    expect(
      parseTestGroupReportArgs([
        "--compare",
        "before.json",
        "after.json",
        "--limit",
        "5",
        "--top-files",
        "3",
      ]),
    ).toStrictEqual({
      allowFailures: false,
      compare: { before: "before.json", after: "after.json" },
      configs: [],
      fullSuite: false,
      groupBy: "area",
      limit: 5,
      output: null,
      reports: [],
      rss: process.platform === "darwin",
      topFiles: 3,
      vitestArgs: [],
    });
  });
});

describe("scripts/test-group-report artifact paths", () => {
  it("keeps raw Vitest reports scoped to the output file stem", () => {
    expect(resolveReportArtifactDirs(".artifacts/test-perf/baseline-before.json")).toEqual({
      reportDir: path.join(".artifacts", "test-perf", "baseline-before", "vitest-json"),
      logDir: path.join(".artifacts", "test-perf", "baseline-before", "logs"),
    });
  });
});
