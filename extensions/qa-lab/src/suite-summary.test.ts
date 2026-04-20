import { describe, expect, it } from "vitest";
import {
  countQaSuiteFailedScenarios,
  readQaSuiteFailedScenarioCountFromSummary,
} from "./suite-summary.js";

describe("qa suite summary helpers", () => {
  it("counts failed scenarios from scenario statuses", () => {
    expect(
      countQaSuiteFailedScenarios([{ status: "pass" }, { status: "fail" }, { status: "fail" }]),
    ).toBe(2);
  });

  it("prefers counts.failed when available", () => {
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

  it("returns null for unsupported summary shapes", () => {
    expect(readQaSuiteFailedScenarioCountFromSummary({ counts: { total: 2 } })).toBeNull();
    expect(readQaSuiteFailedScenarioCountFromSummary("not-json-object")).toBeNull();
  });
});
