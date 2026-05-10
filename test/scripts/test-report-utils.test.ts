import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectVitestFileDurations,
  normalizeTrackedRepoPath,
  runVitestJsonReport,
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
    spawnSyncMock.mockReset();
  });

  it("launches Vitest through pnpm exec", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    const reportPath = path.join(os.tmpdir(), `openclaw-vitest-json-${Date.now()}.json`);

    expect(
      runVitestJsonReport({
        config: "test/vitest/vitest.unit.config.ts",
        reportPath,
      }),
    ).toBe(reportPath);

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
});
