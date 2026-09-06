// Test Report Utils tests cover test report utils script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectVitestAssertionDurations,
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
} from "../../scripts/test-report-utils.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

describe("scripts/test-report-utils normalizeTrackedRepoPath", () => {
  it("normalizes repo-local absolute paths to repo-relative slash paths", () => {
    const absoluteFile = path.join(process.cwd(), "src", "tools", "example.test.ts");

    expect(normalizeTrackedRepoPath(absoluteFile)).toBe("src/tools/example.test.ts");
  });

  it("preserves external absolute paths as normalized absolute paths", () => {
    const externalFile = path.join(path.parse(process.cwd()).root, "tmp", "outside.test.ts");

    expect(normalizeTrackedRepoPath(externalFile)).toBe(externalFile.split(path.sep).join("/"));
  });
});

describe("scripts/test-report-utils collectVitestFileDurations", () => {
  it("extracts per-file durations and applies file normalization", () => {
    const report = {
      testResults: [
        {
          name: path.join(process.cwd(), "src", "alpha.test.ts"),
          startTime: 100,
          endTime: 460,
          assertionResults: [{}, {}],
        },
        {
          name: "src/zero.test.ts",
          startTime: 300,
          endTime: 300,
          assertionResults: [{}],
        },
      ],
    };

    expect(collectVitestFileDurations(report, normalizeTrackedRepoPath)).toEqual([
      {
        file: "src/alpha.test.ts",
        durationMs: 360,
        testCount: 2,
      },
    ]);
  });
});

describe("scripts/test-report-utils collectVitestAssertionDurations", () => {
  it("extracts per-test durations with normalized files", () => {
    const report = {
      testResults: [
        {
          name: path.join(process.cwd(), "src", "alpha.test.ts"),
          assertionResults: [
            { duration: 25, fullName: "alpha fast", status: "passed" },
            { duration: 0, fullName: "alpha zero", status: "passed" },
          ],
        },
      ],
    };

    expect(collectVitestAssertionDurations(report, normalizeTrackedRepoPath)).toEqual([
      {
        file: "src/alpha.test.ts",
        durationMs: 25,
        fullName: "alpha fast",
        status: "passed",
      },
    ]);
  });
});

describe("scripts/test-report-utils runVitestJsonReport", () => {
  beforeEach(async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // Keep process-cleanup probes native; report-only cases override the implementation below.
    spawnSyncMock.mockReset().mockImplementation(actual.spawnSync);
  });

  it("creates and reuses a native JSON report without a package-manager PATH", async ({
    signal,
    onTestFinished,
  }) => {
    const lifetime = createFixtureLifetime();
    onTestFinished(() => lifetime.cleanup());
    await lifetime.run(async () => {
      const root = lifetime.createTempDir("oc-report-cli-");
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      fs.symlinkSync(
        requireNodeTool("node"),
        path.join(bin, process.platform === "win32" ? "node.exe" : "node"),
        "file",
      );
      const repoRoot = process.cwd();
      const config = path.join(root, "vitest.config.mjs");
      const reportPath = path.join(root, "report.json");
      const entry = path.join(root, "report.mts");
      fs.writeFileSync(
        config,
        `export default { root: ${JSON.stringify(root)}, test: { include: ["case.test.mjs"], globals: true, maxWorkers: 1 } };`,
      );
      fs.writeFileSync(
        path.join(root, "case.test.mjs"),
        'test("native report fixture", () => expect(2 + 2).toBe(4));',
      );
      fs.writeFileSync(
        entry,
        `import assert from "node:assert/strict";
import { runVitestJsonReport } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "scripts/test-report-utils.mts")).href)};
assert.equal(runVitestJsonReport(${JSON.stringify({ config, reportPath })}), ${JSON.stringify(reportPath)});
assert.equal(runVitestJsonReport(${JSON.stringify({ config: path.join(root, "missing.config.mjs"), reportPath })}), ${JSON.stringify(reportPath)});
`,
      );
      const result = await lifetime.track(
        runNodeScript(
          ["--import", path.join(repoRoot, "scripts/tsx.mjs"), entry],
          {
            ...process.env,
            PATH: bin,
            OPENCLAW_LIVE_USE_REAL_HOME: "0",
            TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
          },
          30_000,
          { cwd: root, signal, requireProcessTreeExit: process.platform !== "win32" },
        ),
      );
      expect(result.error, result.stdout + result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      expect(report.success).toBe(true);
      expect(
        report.testResults.flatMap(
          (file: { assertionResults: { title: string; status: string }[] }) =>
            file.assertionResults.map(({ title, status }) => [title, status]),
        ),
      ).toEqual([["native report fixture", "passed"]]);
    });
  });

  it("uses distinct default report paths when invocations share a clock tick", async () => {
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mts");
    const reportPaths: string[] = [];
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      const outputFileIndex = args.indexOf("--outputFile") + 1;
      const outputFile = expectDefined(args[outputFileIndex], "Vitest JSON report output path");
      reportPaths.push(outputFile);
      fs.writeFileSync(outputFile, `${JSON.stringify({ testResults: [] })}\n`, "utf8");
      return { status: 0 };
    });

    try {
      runVitestJsonReport({
        config: "test/vitest/vitest.unit.config.ts",
      });
      runVitestJsonReport({
        config: "test/vitest/vitest.unit.config.ts",
      });

      expect(reportPaths).toHaveLength(2);
      expect(reportPaths[0]).not.toBe(reportPaths[1]);
      for (const reportPath of reportPaths) {
        expect(path.dirname(reportPath)).toBe(os.tmpdir());
        expect(path.basename(reportPath)).toMatch(
          /^openclaw-vitest-report-\d+-1234567890-[0-9a-f-]+\.json$/u,
        );
      }
    } finally {
      nowSpy.mockRestore();
      for (const reportPath of reportPaths) {
        fs.rmSync(reportPath, { force: true });
      }
    }
  });

  it("fails when Vitest exits successfully without writing a JSON report", async () => {
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mts");
    spawnSyncMock.mockReturnValue({ status: 0 });
    const reportPath = path.join(os.tmpdir(), `openclaw-vitest-json-missing-${Date.now()}.json`);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit ${String(code)}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        runVitestJsonReport({
          config: "test/vitest/vitest.unit.config.ts",
          reportPath,
        }),
      ).toThrow("process.exit 1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[test-report-utils] missing Vitest JSON report:"),
      );
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      fs.rmSync(reportPath, { force: true });
    }
  });
});
