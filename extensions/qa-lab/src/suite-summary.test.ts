// Qa Lab tests cover suite summary plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  countQaSuiteFailedScenarios,
  readQaSuiteFailedOrSkippedScenarioCountFromFile,
  readQaSuiteFailedScenarioCountFromFile,
} from "./suite-summary.js";

async function readSummary<T>(
  summary: unknown,
  reader: (summaryPath: string) => Promise<T>,
): Promise<T> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-summary-inline-"));
  const summaryPath = path.join(outputDir, "qa-suite-summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary), "utf8");
  try {
    return await reader(summaryPath);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

describe("qa suite summary helpers", () => {
  it("counts failed scenarios from scenario statuses", () => {
    expect(
      countQaSuiteFailedScenarios([{ status: "pass" }, { status: "fail" }, { status: "fail" }]),
    ).toBe(2);
  });

  it("counts failed and skipped scenarios from scenario statuses", async () => {
    await expect(
      readSummary(
        {
          scenarios: [
            { status: "pass" },
            { status: "skip" },
            { status: "skipped" },
            { status: "fail" },
          ],
        },
        readQaSuiteFailedOrSkippedScenarioCountFromFile,
      ),
    ).resolves.toBe(3);
  });

  it("counts unknown scenario statuses as blocking for strict gates", async () => {
    await expect(
      readSummary(
        {
          counts: { failed: 0, skipped: 0 },
          scenarios: [{ status: "timeout" }, { status: "error" }],
        },
        readQaSuiteFailedOrSkippedScenarioCountFromFile,
      ),
    ).resolves.toBe(2);
  });

  it("uses the larger failure signal when counts and scenarios disagree", async () => {
    await expect(
      readSummary(
        { counts: { failed: 0 }, scenarios: [{ status: "pass" }, { status: "fail" }] },
        readQaSuiteFailedScenarioCountFromFile,
      ),
    ).resolves.toBe(1);
    await expect(
      readSummary(
        { counts: { failed: 3.8 }, scenarios: [{ status: "pass" }, { status: "fail" }] },
        readQaSuiteFailedScenarioCountFromFile,
      ),
    ).resolves.toBe(3);
  });

  it("falls back to scenario statuses when counts.failed is missing", async () => {
    await expect(
      readSummary(
        { counts: { total: 2 }, scenarios: [{ status: "pass" }, { status: "fail" }] },
        readQaSuiteFailedScenarioCountFromFile,
      ),
    ).resolves.toBe(1);
  });

  it("counts evidence entry results", async () => {
    const summary = {
      entries: [
        { result: { status: "pass" } },
        { result: { status: "fail" } },
        { result: { status: "skipped" } },
      ],
    };

    await expect(readSummary(summary, readQaSuiteFailedScenarioCountFromFile)).resolves.toBe(1);
    await expect(
      readSummary(summary, readQaSuiteFailedOrSkippedScenarioCountFromFile),
    ).resolves.toBe(2);
  });

  it("uses the larger blocking signal when skipped counts and scenarios disagree", async () => {
    await expect(
      readSummary(
        { counts: { failed: 0, skipped: 1 }, scenarios: [{ status: "pass" }] },
        readQaSuiteFailedOrSkippedScenarioCountFromFile,
      ),
    ).resolves.toBe(1);
    await expect(
      readSummary(
        { counts: { failed: 0, skipped: 0 }, scenarios: [{ status: "skip" }, { status: "fail" }] },
        readQaSuiteFailedOrSkippedScenarioCountFromFile,
      ),
    ).resolves.toBe(2);
  });

  it("rejects unsupported summary shapes", async () => {
    await expect(
      readSummary({ counts: { total: 2 } }, readQaSuiteFailedScenarioCountFromFile),
    ).rejects.toThrow("did not include counts.failed");
    await expect(
      readSummary("not-json-object", readQaSuiteFailedScenarioCountFromFile),
    ).rejects.toThrow("did not include counts.failed");
  });

  it("reads failed scenario counts from summary files", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-summary-"));
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        counts: { failed: 0 },
        scenarios: [{ status: "fail" }],
      }),
      "utf8",
    );

    try {
      await expect(readQaSuiteFailedScenarioCountFromFile(summaryPath)).resolves.toBe(1);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reads failed or skipped scenario counts from summary files", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-summary-"));
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        counts: { failed: 0, skipped: 1 },
        scenarios: [{ status: "pass" }],
      }),
      "utf8",
    );

    try {
      await expect(readQaSuiteFailedOrSkippedScenarioCountFromFile(summaryPath)).resolves.toBe(1);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("fails summary files without a failure signal", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-summary-"));
    const summaryPath = path.join(outputDir, "qa-suite-summary.json");
    await fs.writeFile(summaryPath, JSON.stringify({ counts: { total: 1 } }), "utf8");

    try {
      await expect(readQaSuiteFailedScenarioCountFromFile(summaryPath)).rejects.toThrow(
        "did not include counts.failed, scenarios[].status, or entries[].result.status",
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
