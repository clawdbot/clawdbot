// Test Report Utils tests cover test report utils script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectVitestAssertionDurations,
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
  tryReadJsonFile,
} from "../../scripts/test-report-utils.mjs";

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

describe("scripts/test-report-utils tryReadJsonFile", () => {
  it("returns the fallback when the file is missing", () => {
    const missingPath = path.join(os.tmpdir(), `openclaw-missing-${Date.now()}.json`);

    expect(tryReadJsonFile(missingPath, { ok: true })).toEqual({ ok: true });
  });

  it("reads valid JSON files", () => {
    const tempPath = path.join(os.tmpdir(), `openclaw-json-${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify({ ok: true }));

    try {
      expect(tryReadJsonFile(tempPath, null)).toEqual({ ok: true });
    } finally {
      fs.unlinkSync(tempPath);
    }
  });
});

describe("scripts/test-report-utils runVitestJsonReport", () => {
  beforeEach(() => {
    vi.resetModules();
    spawnSyncMock.mockReset();
  });

  it("launches Vitest through pnpm exec", async () => {
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mjs");
    const reportPath = path.join(os.tmpdir(), `openclaw-vitest-json-${Date.now()}.json`);
    spawnSyncMock.mockImplementation(() => {
      fs.writeFileSync(reportPath, `${JSON.stringify({ testResults: [] })}\n`, "utf8");
      return { status: 0 };
    });

    try {
      expect(
        runVitestJsonReport({
          config: "test/vitest/vitest.unit.config.ts",
          reportPath,
        }),
      ).toBe(reportPath);
    } finally {
      fs.rmSync(reportPath, { force: true });
    }

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/vitest/vitest.unit.config.ts",
        "--reporter=json",
        "--outputFile",
        reportPath,
      ],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
  });

  it("uses distinct default report paths when invocations share a clock tick", async () => {
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mjs");
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
    const { runVitestJsonReport } = await import("../../scripts/test-report-utils.mjs");
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
