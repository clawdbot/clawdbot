import { describe, expect, it } from "vitest";
import {
  buildQaAgenticParityComparison,
  computeQaAgenticParityMetrics,
  renderQaAgenticParityMarkdownReport,
  type QaParitySuiteSummary,
} from "./agentic-parity-report.js";

describe("qa agentic parity report", () => {
  it("computes first-wave parity metrics from suite summaries", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        { name: "Scenario A", status: "pass" },
        { name: "Scenario B", status: "fail", details: "incomplete turn detected" },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary)).toEqual({
      totalScenarios: 2,
      passedScenarios: 1,
      failedScenarios: 1,
      completionRate: 0.5,
      unintendedStopCount: 1,
      unintendedStopRate: 0.5,
      validToolCallCount: 1,
      validToolCallRate: 0.5,
      fakeSuccessCount: 0,
    });
  });

  it("fails the parity gate when the candidate regresses against baseline", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          {
            name: "Compaction retry after mutating tool",
            status: "fail",
            details: "timed out before it continued",
          },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      baselineSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "openai/gpt-5.4 completion rate 80.0% is below anthropic/claude-opus-4-6 100.0%.",
    );
    expect(comparison.failures).toContain(
      "openai/gpt-5.4 unintended-stop rate 20.0% exceeds anthropic/claude-opus-4-6 0.0%.",
    );
  });

  it("fails the parity gate when candidate and baseline cover different non-parity scenarios", () => {
    const baselineScenarios = [
      { name: "Approval turn tool followthrough", status: "pass" as const },
      { name: "Compaction retry after mutating tool", status: "pass" as const },
      { name: "Model switch with tool continuity", status: "pass" as const },
      { name: "Source and docs discovery report", status: "pass" as const },
      { name: "Image understanding from attachment", status: "pass" as const },
      { name: "Extra non-parity lane", status: "pass" as const },
    ];
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: baselineScenarios.filter(
          (scenario) => scenario.name !== "Extra non-parity lane",
        ),
      },
      baselineSummary: { scenarios: baselineScenarios },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Scenario coverage mismatch for Extra non-parity lane: openai/gpt-5.4=missing, anthropic/claude-opus-4-6=pass.",
    );
  });

  it("reports each missing required parity scenario exactly once (no double-counting)", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      baselineSummary: {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    const missingScenario = "Image understanding from attachment";
    const requiredLines = comparison.failures.filter((failure) =>
      failure.includes(`Missing required parity scenario coverage for ${missingScenario}:`),
    );
    const mismatchLines = comparison.failures.filter((failure) =>
      failure.includes(`Scenario coverage mismatch for ${missingScenario}:`),
    );
    expect(requiredLines).toHaveLength(1);
    expect(mismatchLines).toHaveLength(0);
  });

  it("scopes parity metrics to declared parity scenarios even when extra lanes are present", () => {
    const scopedSummary = {
      scenarios: [
        { name: "Approval turn tool followthrough", status: "pass" as const },
        { name: "Compaction retry after mutating tool", status: "pass" as const },
        { name: "Model switch with tool continuity", status: "pass" as const },
        { name: "Source and docs discovery report", status: "pass" as const },
        { name: "Image understanding from attachment", status: "pass" as const },
      ],
    };
    const summaryWithExtras = {
      scenarios: [
        ...scopedSummary.scenarios,
        { name: "Extra lane A", status: "fail" as const, details: "timed out" },
        { name: "Extra lane B", status: "fail" as const, details: "timed out" },
      ],
    };

    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: summaryWithExtras,
      baselineSummary: scopedSummary,
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    // Extra lanes must not drag the candidate's completion rate below baseline
    // and must not generate unintended-stop or fake-success hits.
    expect(comparison.candidateMetrics.totalScenarios).toBe(5);
    expect(comparison.candidateMetrics.completionRate).toBe(1);
    expect(comparison.candidateMetrics.unintendedStopRate).toBe(0);
    expect(comparison.candidateMetrics.fakeSuccessCount).toBe(0);
    // The pass/fail verdict here still depends only on the parity pack itself.
    const regressionFailures = comparison.failures.filter((failure) =>
      failure.includes("completion rate"),
    );
    expect(regressionFailures).toEqual([]);
  });

  it("fails the parity gate when required parity scenarios are missing on both sides", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      baselineSummary: {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Missing required parity scenario coverage for Image understanding from attachment: openai/gpt-5.4=missing, anthropic/claude-opus-4-6=missing.",
    );
  });

  it("fails the parity gate when required parity scenarios are skipped", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "skip" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      baselineSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "skip" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Missing required parity scenario coverage for Compaction retry after mutating tool: openai/gpt-5.4=skip, anthropic/claude-opus-4-6=skip.",
    );
  });

  it("fails the parity gate when the baseline contains suspicious pass results", () => {
    // Cover the full first-wave pack on both sides so the suspicious-pass assertion
    // below is the isolated gate failure under test (no coverage-gap noise).
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      baselineSummary: {
        scenarios: [
          {
            name: "Approval turn tool followthrough",
            status: "pass",
            details: "timed out before it continued",
          },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toEqual([
      "anthropic/claude-opus-4-6 produced 1 suspicious pass result(s); baseline fake-success count must also be 0.",
    ]);
  });

  it("ignores neutral Failed and Blocked headings in passing protocol reports", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Source and docs discovery report",
          status: "pass",
          details: `Worked:
- Read the seeded QA material.
Failed:
- None observed.
Blocked:
- No live provider evidence in this lane.
Follow-up:
- Re-run with a real provider if needed.`,
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("ignores neutral error-budget and no-errors-observed phrasing in passing reports", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Source and docs discovery report",
          status: "pass",
          details: `Worked:
- Scenario finished with Error budget: 0.
- No errors found in the seeded material.
- Errors: none observed.`,
        },
        {
          name: "Image understanding from attachment",
          status: "pass",
          details: "Error: none. The attached image analysis completed without incident.",
        },
      ],
    };

    // Bare "error"/"Error" in narration is not a suspicious-pass signal on its own.
    // Only phrases like "error occurred" or "an error was ..." should count.
    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("still flags genuine error-narration suspicious passes", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Approval turn tool followthrough",
          status: "pass",
          details: "Tool call completed, but an error occurred mid-turn and no retry happened.",
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(1);
  });

  it("renders a readable markdown parity report", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      baselineSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    const report = renderQaAgenticParityMarkdownReport(comparison);

    expect(report).toContain("# OpenClaw GPT-5.4 / Opus 4.6 Agentic Parity Report");
    expect(report).toContain("| Completion rate | 100.0% | 100.0% |");
    expect(report).toContain("### Approval turn tool followthrough");
    expect(report).toContain("- Verdict: pass");
  });
});
