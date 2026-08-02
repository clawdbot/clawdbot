import { describe, expect, it } from "vitest";
import { renderQaMarkdownReport } from "./report.js";

describe("renderQaMarkdownReport", () => {
  it("renders checks, scenarios, timeline, and multiline details", () => {
    const report = renderQaMarkdownReport({
      title: "QA Report",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:00:02.000Z"),
      checks: [{ name: "preflight", status: "pass" }],
      scenarios: [
        {
          name: "transport reply",
          status: "fail",
          details: "line one\nline two",
          steps: [{ name: "send", status: "pass", details: "ok" }],
        },
      ],
      timeline: ["sent request"],
      notes: ["kept artifacts"],
    });

    expect(report).toContain("# QA Report");
    expect(report).toContain("- Duration ms: 2000");
    expect(report).toContain("- Passed: 1");
    expect(report).toContain("- Failed: 1");
    expect(report).toContain("- Skipped: 0");
    expect(report).toContain("```text\nline one\nline two\n```");
    expect(report).toContain("- [x] send");
    expect(report).toContain("## Timeline");
  });

  it("counts skipped coverage and distinguishes skipped checks from failures", () => {
    const report = renderQaMarkdownReport({
      title: "QA Report",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      finishedAt: new Date("2026-01-01T00:00:01.000Z"),
      checks: [
        { name: "unavailable check", status: "skip" },
        { name: "broken check", status: "fail" },
      ],
      scenarios: [
        {
          name: "unavailable scenario",
          status: "skip",
          steps: [
            { name: "unavailable step", status: "skip" },
            { name: "broken step", status: "fail" },
          ],
        },
      ],
    });

    expect(report).toContain("- Passed: 0");
    expect(report).toContain("- Failed: 1");
    expect(report).toContain("- Skipped: 2");
    expect(report).toContain("- [ ] unavailable check (skip)");
    expect(report).toContain("- [ ] broken check (fail)");
    expect(report).toContain("  - [ ] unavailable step (skip)");
    expect(report).toContain("  - [ ] broken step (fail)");
  });
});
