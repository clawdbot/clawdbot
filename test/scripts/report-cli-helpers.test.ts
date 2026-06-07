import { describe, expect, it } from "vitest";
import { parseReportCliArgs } from "../../scripts/lib/report-cli-helpers.mjs";

describe("report-cli-helpers", () => {
  it("parses report artifact paths", () => {
    expect(
      parseReportCliArgs([
        "--root",
        "/repo",
        "--json",
        "artifacts/report.json",
        "--markdown",
        "artifacts/report.md",
      ]),
    ).toEqual({
      rootDir: "/repo",
      jsonPath: "artifacts/report.json",
      markdownPath: "artifacts/report.md",
    });
  });

  it("rejects missing report option values", () => {
    expect(() => parseReportCliArgs(["--root", "--json", "report.json"])).toThrow(
      "Expected --root <value>.",
    );
    expect(() => parseReportCliArgs(["--json"])).toThrow("Expected --json <value>.");
    expect(() => parseReportCliArgs(["--json", "--markdown", "report.md"])).toThrow(
      "Expected --json <value>.",
    );
    expect(() => parseReportCliArgs(["--markdown", ""])).toThrow("Expected --markdown <value>.");
  });
});
