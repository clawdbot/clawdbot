import { describe, expect, it } from "vitest";
import {
  buildQaAgenticParityComparison,
  computeQaAgenticParityMetrics,
  QaParityLabelMismatchError,
  renderQaAgenticParityMarkdownReport,
  type QaParityReportScenario,
  type QaParitySuiteSummary,
} from "./agentic-parity-report.js";

const FULL_PARITY_PASS_SCENARIOS: QaParityReportScenario[] = [
  { name: "Approval turn tool followthrough", status: "pass" as const },
  { name: "Compaction retry after mutating tool", status: "pass" as const },
  { name: "Model switch with tool continuity", status: "pass" as const },
  { name: "Source and docs discovery report", status: "pass" as const },
  { name: "Image understanding from attachment", status: "pass" as const },
  { name: "Subagent handoff", status: "pass" as const },
  { name: "Subagent fanout synthesis", status: "pass" as const },
  { name: "Memory recall after context switch", status: "pass" as const },
  { name: "Thread memory isolation", status: "pass" as const },
  { name: "Config restart capability flip", status: "pass" as const },
  { name: "Instruction followthrough repo contract", status: "pass" as const },
];

function withScenarioOverride(name: string, override: Partial<QaParityReportScenario>) {
  return FULL_PARITY_PASS_SCENARIOS.map((scenario) =>
    scenario.name === name ? { ...scenario, ...override } : scenario,
  );
}

describe("qa agentic parity report", () => {
  it("computes first-wave parity metrics from suite summaries", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        { name: "Approval turn tool followthrough", status: "pass" },
        {
          name: "Compaction retry after mutating tool",
          status: "fail",
          details: "incomplete turn detected",
        },
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

  it("keeps non-tool scenarios out of the valid-tool-call metric", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        { name: "Approval turn tool followthrough", status: "pass" },
        { name: "Memory recall after context switch", status: "pass" },
        { name: "Image understanding from attachment", status: "pass" },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary)).toMatchObject({
      totalScenarios: 3,
      passedScenarios: 3,
      validToolCallCount: 1,
      validToolCallRate: 1,
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

  it("fails the parity gate when a required parity scenario fails on both sides", () => {
    // Regression for the loop-7 Codex-connector P1 finding: without this
    // check, a required parity scenario that fails on both candidate and
    // baseline still produces pass=true because the downstream metric
    // comparisons are purely relative (candidate vs baseline). Cover the
    // whole parity pack as pass on both sides except the one scenario we
    // deliberately fail on both sides, so the assertion can pin the
    // isolated gate failure under test.
    const scenariosWithBothFail = withScenarioOverride("Approval turn tool followthrough", {
      status: "fail",
    });
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: { scenarios: scenariosWithBothFail },
      baselineSummary: { scenarios: scenariosWithBothFail },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Required parity scenario Approval turn tool followthrough failed: openai/gpt-5.4=fail, anthropic/claude-opus-4-6=fail.",
    );
    // Metric comparisons are relative, so a same-on-both-sides failure
    // must not appear as a relative metric failure. The required-scenario
    // failure line is the only thing keeping the gate honest here.
    expect(comparison.failures.some((failure) => failure.includes("completion rate"))).toBe(false);
  });

  it("fails the parity gate when a required parity scenario fails on the candidate only", () => {
    // A candidate regression below a passing baseline is already caught
    // by the relative completion-rate comparison, but surface it as a
    // named required-scenario failure too so operators see a concrete
    // scenario name alongside the rate differential.
    const candidateWithOneFail = withScenarioOverride("Approval turn tool followthrough", {
      status: "fail",
    });
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: { scenarios: candidateWithOneFail },
      baselineSummary: { scenarios: FULL_PARITY_PASS_SCENARIOS },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Required parity scenario Approval turn tool followthrough failed: openai/gpt-5.4=fail, anthropic/claude-opus-4-6=pass.",
    );
  });

  it("fails the parity gate when the baseline contains suspicious pass results", () => {
    // Cover the full second-wave pack on both sides so the suspicious-pass assertion
    // below is the isolated gate failure under test (no coverage-gap noise).
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
      },
      baselineSummary: {
        scenarios: withScenarioOverride("Approval turn tool followthrough", {
          details: "timed out before it continued",
        }),
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

  it("does not flag positive-tone prose as fake success (positive-tone detection removed)", () => {
    // Positive-tone detection was removed because for passing runs the
    // `details` field is the model's prose, which never contains tool-call
    // evidence. Criterion 2 is enforced by per-scenario tool-call assertions.
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Subagent handoff",
          status: "pass",
          details: "Successfully completed the delegation. The subagent returned its result.",
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("does not flag bare 'Done.' prose as fake success", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Approval turn tool followthrough",
          status: "pass",
          details: "Done.",
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("does not flag structured status lines that end in `done`", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Compaction retry after mutating tool",
          status: "pass",
          details: `Confirmed, replay unsafe after write.
compactionCount=0
status=done`,
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("does not flag positive-tone passes when the scenario shows real tool-call evidence", () => {
    // A legitimate tool-mediated pass that happens to include
    // "successfully" in its prose must not be flagged. The
    // `plannedToolName` evidence (or any of the other tool-call
    // evidence patterns) exempts the scenario from positive-tone
    // detection. Without this exemption, real tool-backed passes with
    // self-congratulatory prose would count as fake successes and break
    // the gate.
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Source and docs discovery report",
          status: "pass",
          details:
            "Successfully completed the report. plannedToolName=read recorded via /debug/requests.",
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("only flags failure-tone passes, not positive-tone", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Approval turn tool followthrough",
          status: "pass",
          details: "Task executed successfully without errors.",
        },
        {
          name: "Subagent handoff",
          status: "pass",
          details: "Tool call completed, but an error occurred mid-turn.",
        },
      ],
    };

    // Only the failure-tone scenario ("error occurred") counts.
    // The positive-tone one ("successfully") is not flagged.
    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(1);
  });

  it("throws QaParityLabelMismatchError when the candidate run.primaryProvider does not match the label", () => {
    // Regression for the gate footgun: if an operator swaps the
    // --candidate-summary and --baseline-summary paths, the gate would
    // silently produce a reversed verdict. PR L #64789 ships the `run`
    // block on every summary so the parity report can verify it against
    // the caller-supplied label; this test pins the precondition check.
    const parityPassScenarios = [
      { name: "Approval turn tool followthrough", status: "pass" as const },
      { name: "Compaction retry after mutating tool", status: "pass" as const },
      { name: "Model switch with tool continuity", status: "pass" as const },
      { name: "Source and docs discovery report", status: "pass" as const },
      { name: "Image understanding from attachment", status: "pass" as const },
    ];

    expect(() =>
      buildQaAgenticParityComparison({
        candidateLabel: "openai/gpt-5.4",
        baselineLabel: "anthropic/claude-opus-4-6",
        candidateSummary: {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "anthropic", primaryModel: "claude-opus-4-6" },
        },
        baselineSummary: {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "anthropic", primaryModel: "claude-opus-4-6" },
        },
        comparedAt: "2026-04-11T00:00:00.000Z",
      }),
    ).toThrow(QaParityLabelMismatchError);
  });

  it("throws QaParityLabelMismatchError when the baseline run.primaryProvider does not match the label", () => {
    const parityPassScenarios = [
      { name: "Approval turn tool followthrough", status: "pass" as const },
    ];

    expect(() =>
      buildQaAgenticParityComparison({
        candidateLabel: "openai/gpt-5.4",
        baselineLabel: "anthropic/claude-opus-4-6",
        candidateSummary: {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "openai" },
        },
        baselineSummary: {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "openai", primaryModel: "gpt-5.4" },
        },
        comparedAt: "2026-04-11T00:00:00.000Z",
      }),
    ).toThrow(
      /baseline summary run\.primaryProvider=openai and run\.primaryModel=gpt-5\.4 do not match --baseline-label/,
    );
  });

  it("accepts matching run.primaryProvider labels without throwing", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "openai",
          primaryModel: "openai/gpt-5.4",
          primaryModelName: "gpt-5.4",
        },
      },
      baselineSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "anthropic",
          primaryModel: "anthropic/claude-opus-4-6",
          primaryModelName: "claude-opus-4-6",
        },
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });
    expect(comparison.pass).toBe(true);
  });

  it("skips run.primaryProvider verification when the summary is missing a run block (legacy summaries)", () => {
    // Pre-PR-L summaries don't carry a `run` block. The gate must still
    // work against those, trusting the caller-supplied label.
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: { scenarios: FULL_PARITY_PASS_SCENARIOS },
      baselineSummary: { scenarios: FULL_PARITY_PASS_SCENARIOS },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });
    expect(comparison.pass).toBe(true);
  });

  it("skips provider verification for arbitrary display labels when run metadata is present", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "GPT-5.4 candidate",
      baselineLabel: "Opus 4.6 baseline",
      candidateSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "openai",
          primaryModel: "openai/gpt-5.4",
          primaryModelName: "gpt-5.4",
        },
      },
      baselineSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "anthropic",
          primaryModel: "anthropic/claude-opus-4-6",
          primaryModelName: "claude-opus-4-6",
        },
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(true);
  });

  it("skips provider verification for mixed-case or decorated display labels", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "Candidate: GPT-5.4",
      baselineLabel: "Opus 4.6 / baseline",
      candidateSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "openai",
          primaryModel: "openai/gpt-5.4",
          primaryModelName: "gpt-5.4",
        },
      },
      baselineSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "anthropic",
          primaryModel: "anthropic/claude-opus-4-6",
          primaryModelName: "claude-opus-4-6",
        },
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(true);
  });

  it("throws when a structured label mismatches the recorded model even if the provider matches", () => {
    expect(() =>
      buildQaAgenticParityComparison({
        candidateLabel: "openai/gpt-5.4",
        baselineLabel: "anthropic/claude-opus-4-6",
        candidateSummary: {
          scenarios: FULL_PARITY_PASS_SCENARIOS,
          run: {
            primaryProvider: "openai",
            primaryModel: "openai/gpt-5.4-alt",
            primaryModelName: "gpt-5.4-alt",
          },
        },
        baselineSummary: {
          scenarios: FULL_PARITY_PASS_SCENARIOS,
          run: {
            primaryProvider: "anthropic",
            primaryModel: "anthropic/claude-opus-4-6",
            primaryModelName: "claude-opus-4-6",
          },
        },
        comparedAt: "2026-04-11T00:00:00.000Z",
      }),
    ).toThrow(
      /candidate summary run\.primaryProvider=openai and run\.primaryModel=openai\/gpt-5\.4-alt do not match --candidate-label=openai\/gpt-5\.4/,
    );
  });

  it("accepts colon-delimited structured labels when provider and model both match", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai:gpt-5.4",
      baselineLabel: "anthropic:claude-opus-4-6",
      candidateSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "openai",
          primaryModel: "openai/gpt-5.4",
          primaryModelName: "gpt-5.4",
        },
      },
      baselineSummary: {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
        run: {
          primaryProvider: "anthropic",
          primaryModel: "anthropic/claude-opus-4-6",
          primaryModelName: "claude-opus-4-6",
        },
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(true);
  });

  it("renders a readable markdown parity report", () => {
    // Cover the full parity pack on both sides so the pass
    // verdict is not disrupted by required-scenario coverage failures
    // added by the second-wave expansion.
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: { scenarios: FULL_PARITY_PASS_SCENARIOS },
      baselineSummary: { scenarios: FULL_PARITY_PASS_SCENARIOS },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    const report = renderQaAgenticParityMarkdownReport(comparison);

    expect(report).toContain(
      "# OpenClaw Agentic Parity Report — openai/gpt-5.4 vs anthropic/claude-opus-4-6",
    );
    expect(report).toContain("| Completion rate | 100.0% | 100.0% |");
    expect(report).toContain("### Approval turn tool followthrough");
    expect(report).toContain("- Verdict: pass");
  });

  it("parametrizes the markdown header from the comparison labels", () => {
    // Regression for the loop-7 Copilot finding: callers that configure
    // non-gpt-5.4 / non-opus labels (for example an internal candidate vs
    // another candidate) must see the labels in the rendered H1 instead of
    // the hardcoded "GPT-5.4 / Opus 4.6" title that would otherwise confuse
    // readers of saved reports.
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4-alt",
      baselineLabel: "openai/gpt-5.4",
      candidateSummary: { scenarios: [] },
      baselineSummary: { scenarios: [] },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });
    const report = renderQaAgenticParityMarkdownReport(comparison);
    expect(report).toContain(
      "# OpenClaw Agentic Parity Report — openai/gpt-5.4-alt vs openai/gpt-5.4",
    );
  });
});
