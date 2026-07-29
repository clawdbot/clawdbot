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
    expect(() => parseReportCliArgs(["--root", "-h"])).toThrow("Expected --root <value>.");
    expect(() => parseReportCliArgs(["--json"])).toThrow("Expected --json <value>.");
    expect(() => parseReportCliArgs(["--json", "--markdown", "report.md"])).toThrow(
      "Expected --json <value>.",
    );
    expect(() => parseReportCliArgs(["--json", "-h"])).toThrow("Expected --json <value>.");
    expect(() => parseReportCliArgs(["--markdown", ""])).toThrow("Expected --markdown <value>.");
    expect(() => parseReportCliArgs(["--markdown", "-h"])).toThrow("Expected --markdown <value>.");
  });

  it("rejects duplicate report artifact options", () => {
    expect(() => parseReportCliArgs(["--root", "/repo-a", "--root", "/repo-b"])).toThrow(
      "--root was provided more than once.",
    );
    expect(() => parseReportCliArgs(["--json", "first.json", "--json", "second.json"])).toThrow(
      "--json was provided more than once.",
    );
    expect(() => parseReportCliArgs(["--markdown", "first.md", "--markdown", "second.md"])).toThrow(
      "--markdown was provided more than once.",
    );
  });
});
