// Qa Lab tests cover suite summary plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  countQaSuiteFailedOrSkippedScenarios,
  countQaSuiteFailedScenarios,
  readQaSuiteFailedOrSkippedScenarioCountFromFile,
  readQaSuiteFailedOrSkippedScenarioCountFromSummary,
  readQaSuiteFailedScenarioCountFromFile,
  readQaSuiteFailedScenarioCountFromSummary,
} from "./suite-summary.js";

describe("qa suite summary helpers", () => {
  it("counts failed scenarios from scenario statuses", () => {
    expect(
      countQaSuiteFailedScenarios([{ status: "pass" }, { status: "fail" }, { status: "fail" }]),
    ).toBe(2);
  });

  it("counts failed and skipped scenarios from scenario statuses", () => {
    expect(
      countQaSuiteFailedOrSkippedScenarios([
        { status: "pass" },
        { status: "skip" },
        { status: "skipped" },
        { status: "fail" },
      ]),
    ).toBe(3);
  });

  it("counts unknown scenario statuses as blocking for strict gates", () => {
    expect(
      countQaSuiteFailedOrSkippedScenarios([
        { status: "pass" },
        { status: "timeout" as never },
        { status: "error" as never },
      ]),
    ).toBe(2);

    expect(
      readQaSuiteFailedOrSkippedScenarioCountFromSummary({
        counts: { failed: 0, skipped: 0 },
        scenarios: [{ status: "timeout" }, { status: "error" }],
      }),
    ).toBe(2);
  });

  it("uses the larger failure signal when counts and scenarios disagree", () => {
    expect(
      readQaSuiteFailedScenarioCountFromSummary({
        counts: { failed: 0 },
        scenarios: [{ status: "pass" }, { status: "fail" }],
      }),
    ).toBe(1);

    expect(
      readQaSuiteFailedScenarioCountFromSummary({
        counts: { failed: 3.8 },
        scenarios: [{ status: "pass" }, { status: "fail" }],
      }),
    ).toBe(3);
  });

  it("falls back to scenario statuses when counts.failed is missing", () => {
    expect(
      readQaSuiteFailedScenarioCountFromSummary({
        counts: { total: 2 },
        scenarios: [{ status: "pass" }, { status: "fail" }],
      }),
    ).toBe(1);
  });

  it("uses the larger blocking signal when skipped counts and scenarios disagree", () => {
    expect(
      readQaSuiteFailedOrSkippedScenarioCountFromSummary({
        counts: { failed: 0, skipped: 1 },
        scenarios: [{ status: "pass" }],
      }),
    ).toBe(1);

    expect(
      readQaSuiteFailedOrSkippedScenarioCountFromSummary({
        counts: { failed: 0, skipped: 0 },
        scenarios: [{ status: "skip" }, { status: "fail" }],
      }),
    ).toBe(2);
  });

  it("returns null for unsupported summary shapes", () => {
    expect(readQaSuiteFailedScenarioCountFromSummary({ counts: { total: 2 } })).toBeNull();
    expect(readQaSuiteFailedScenarioCountFromSummary("not-json-object")).toBeNull();
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
        "did not include counts.failed or scenarios[].status",
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
