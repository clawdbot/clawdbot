// Qa Lab tests cover agentic parity report plugin behavior.
import { describe, expect, it } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import {
  buildQaAgenticParityComparison,
  buildQaRuntimeParityReport,
  renderQaAgenticParityMarkdownReport,
  renderQaRuntimeParityMarkdownReport,
  type QaParitySuiteSummary,
  type QaRuntimeParitySuiteSummary,
} from "./agentic-parity-report.js";
import { runRuntimeParityScenario } from "./runtime-parity.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { buildRuntimeParityScenarioResult } from "./suite-runtime-parity-result.js";

type QaParityReportScenario = QaParitySuiteSummary["scenarios"][number];

function computeQaAgenticParityMetrics(summary: QaParitySuiteSummary) {
  const label = summary.run?.primaryProvider ?? "qa";
  return compareQaAgenticParity(summary, summary, { candidate: label, baseline: label })
    .candidateMetrics;
}

const FULL_PARITY_PASS_SCENARIOS: QaParityReportScenario[] = [
  { name: "Approval turn tool followthrough", status: "pass" },
  { name: "Compaction retry after mutating tool", status: "pass" },
  { name: "Model switch with tool continuity", status: "pass" },
  { name: "Source and docs discovery report", status: "pass" },
  { name: "Image understanding from attachment", status: "pass" },
  { name: "Subagent handoff", status: "pass" },
  { name: "Subagent fanout synthesis", status: "pass" },
  { name: "Subagent stale child links", status: "pass" },
  { name: "Memory recall after context switch", status: "pass" },
  { name: "Thread memory isolation", status: "pass" },
  { name: "Config restart capability flip", status: "pass" },
  { name: "Instruction followthrough repo contract", status: "pass" },
];

function withScenarioOverride(name: string, override: Partial<QaParityReportScenario>) {
  return FULL_PARITY_PASS_SCENARIOS.map((scenario) =>
    scenario.name === name ? { ...scenario, ...override } : scenario,
  );
}

function matchingRun(primaryProvider: "openai" | "anthropic") {
  const primaryModel = primaryProvider === "openai" ? "gpt-5.6-luna" : "claude-opus-4-8";
  return {
    primaryProvider,
    primaryModel: `${primaryProvider}/${primaryModel}`,
    primaryModelName: primaryModel,
  };
}

function parityPassSummary(primaryProvider?: "openai" | "anthropic"): QaParitySuiteSummary {
  return {
    scenarios: FULL_PARITY_PASS_SCENARIOS,
    ...(primaryProvider ? { run: matchingRun(primaryProvider) } : {}),
  };
}

function firstRuntimeParityScenario() {
  const scenario = makeRuntimeParitySummary().scenarios[0];
  if (!scenario) {
    throw new Error("missing runtime parity scenario fixture");
  }
  return scenario;
}

function compareQaAgenticParity(
  candidateSummary: QaParitySuiteSummary,
  baselineSummary: QaParitySuiteSummary,
  {
    candidate = "openai/gpt-5.6-luna",
    baseline = "anthropic/claude-opus-4-8",
  }: { candidate?: string; baseline?: string } = {},
) {
  return buildQaAgenticParityComparison({
    candidateLabel: candidate,
    baselineLabel: baseline,
    candidateSummary,
    baselineSummary,
    comparedAt: "2026-04-11T00:00:00.000Z",
  });
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

  it("uses scenario rows rather than stale summary counts for parity metrics", () => {
    const summary: QaParitySuiteSummary = {
      counts: {
        total: 2,
        passed: 2,
        failed: 0,
      },
      scenarios: [
        { name: "Approval turn tool followthrough", status: "pass" },
        { name: "Compaction retry after mutating tool", status: "fail" },
      ],
    };

    const metrics = computeQaAgenticParityMetrics(summary);

    expect(metrics.totalScenarios).toBe(2);
    expect(metrics.passedScenarios).toBe(1);
    expect(metrics.failedScenarios).toBe(1);
    expect(metrics.completionRate).toBe(0.5);
  });

  it("keeps non-tool scenarios out of the valid-tool-call metric", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        { name: "Approval turn tool followthrough", status: "pass" },
        { name: "Memory recall after context switch", status: "pass" },
        { name: "Image understanding from attachment", status: "pass" },
      ],
    };

    const metrics = computeQaAgenticParityMetrics(summary);
    expect(metrics.totalScenarios).toBe(3);
    expect(metrics.passedScenarios).toBe(3);
    expect(metrics.validToolCallCount).toBe(1);
    expect(metrics.validToolCallRate).toBe(1);
  });

  it("does not count passing runtime parity scenarios without tool-call evidence", () => {
    const summary: QaRuntimeParitySuiteSummary = {
      scenarios: [
        {
          name: "Approval turn tool followthrough",
          status: "pass",
          steps: [],
          runtimeParity: {
            scenarioId: "approval-turn-tool-followthrough",
            drift: "none",
            cells: {
              openclaw: {
                runtime: "openclaw",
                status: "pass",
                transcriptBytes: '{"role":"assistant"}\n',
                toolCalls: [],
                finalText: "done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                wallClockMs: 10,
                bootStateLines: [],
              },
              codex: {
                runtime: "codex",
                status: "pass",
                transcriptBytes: '{"role":"assistant"}\n',
                toolCalls: [],
                finalText: "done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                wallClockMs: 10,
                bootStateLines: [],
              },
            },
          },
        },
      ],
    };

    const metrics = computeQaAgenticParityMetrics(summary);

    expect(metrics.passedScenarios).toBe(1);
    expect(metrics.validToolCallCount).toBe(0);
    expect(metrics.validToolCallRate).toBe(0);
  });

  it("counts passing runtime parity scenarios with tool calls in both runtimes", () => {
    const metrics = computeQaAgenticParityMetrics({
      scenarios: [firstRuntimeParityScenario()],
    });

    expect(metrics.validToolCallCount).toBe(1);
    expect(metrics.validToolCallRate).toBe(1);
  });

  it("fails the parity gate when the candidate regresses against baseline", () => {
    const comparison = compareQaAgenticParity(
      {
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
      {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "openai/gpt-5.6-luna completion rate 80.0% is below anthropic/claude-opus-4-8 100.0%.",
    );
    expect(comparison.failures).toContain(
      "openai/gpt-5.6-luna unintended-stop rate 20.0% exceeds anthropic/claude-opus-4-8 0.0%.",
    );
  });

  it("fails the parity gate when candidate and baseline cover different non-parity scenarios", () => {
    const passScenario = (name: string): QaParityReportScenario => ({ name, status: "pass" });
    const baselineScenarios = [
      passScenario("Approval turn tool followthrough"),
      passScenario("Compaction retry after mutating tool"),
      passScenario("Model switch with tool continuity"),
      passScenario("Source and docs discovery report"),
      passScenario("Image understanding from attachment"),
      passScenario("Extra non-parity lane"),
    ];
    const comparison = compareQaAgenticParity(
      {
        scenarios: baselineScenarios.filter(
          (scenario) => scenario.name !== "Extra non-parity lane",
        ),
      },
      { scenarios: baselineScenarios },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Scenario coverage mismatch for Extra non-parity lane: openai/gpt-5.6-luna=missing, anthropic/claude-opus-4-8=pass.",
    );
  });

  it("reports each missing required parity scenario exactly once (no double-counting)", () => {
    const comparison = compareQaAgenticParity(
      {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
    );

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
    const scopedSummary: QaParitySuiteSummary = {
      scenarios: [
        { name: "Approval turn tool followthrough", status: "pass" },
        { name: "Compaction retry after mutating tool", status: "pass" },
        { name: "Model switch with tool continuity", status: "pass" },
        { name: "Source and docs discovery report", status: "pass" },
        { name: "Image understanding from attachment", status: "pass" },
      ],
    };
    const summaryWithExtras: QaParitySuiteSummary = {
      scenarios: [
        ...scopedSummary.scenarios,
        { name: "Extra lane A", status: "fail", details: "timed out" },
        { name: "Extra lane B", status: "fail", details: "timed out" },
      ],
    };

    const comparison = compareQaAgenticParity(summaryWithExtras, scopedSummary);

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
    expect(regressionFailures).toStrictEqual([]);
  });

  it("fails the parity gate when required parity scenarios are missing on both sides", () => {
    const comparison = compareQaAgenticParity(
      {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Missing required parity scenario coverage for Image understanding from attachment: openai/gpt-5.6-luna=missing, anthropic/claude-opus-4-8=missing.",
    );
  });

  it("fails the parity gate when required parity scenarios are skipped", () => {
    const comparison = compareQaAgenticParity(
      {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "skip" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "skip" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Missing required parity scenario coverage for Compaction retry after mutating tool: openai/gpt-5.6-luna=skip, anthropic/claude-opus-4-8=skip.",
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
    const comparison = compareQaAgenticParity(
      { scenarios: scenariosWithBothFail },
      { scenarios: scenariosWithBothFail },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Required parity scenario Approval turn tool followthrough failed: openai/gpt-5.6-luna=fail, anthropic/claude-opus-4-8=fail.",
    );
    // Metric comparisons are relative, so a same-on-both-sides failure
    // must not appear as a relative metric failure. The required-scenario
    // failure line is the only thing keeping the gate honest here.
    expect(comparison.failures.filter((failure) => failure.includes("completion rate"))).toEqual(
      [],
    );
  });

  it("fails the parity gate when a required parity scenario fails on the candidate only", () => {
    // A candidate regression below a passing baseline is already caught
    // by the relative completion-rate comparison, but surface it as a
    // named required-scenario failure too so operators see a concrete
    // scenario name alongside the rate differential.
    const candidateWithOneFail = withScenarioOverride("Approval turn tool followthrough", {
      status: "fail",
    });
    const comparison = compareQaAgenticParity(
      { scenarios: candidateWithOneFail },
      { scenarios: FULL_PARITY_PASS_SCENARIOS },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Required parity scenario Approval turn tool followthrough failed: openai/gpt-5.6-luna=fail, anthropic/claude-opus-4-8=pass.",
    );
  });

  it("fails the parity gate when the baseline contains suspicious pass results", () => {
    // Cover the full second-wave pack on both sides so the suspicious-pass assertion
    // below is the isolated gate failure under test (no coverage-gap noise).
    const comparison = compareQaAgenticParity(
      {
        scenarios: FULL_PARITY_PASS_SCENARIOS,
      },
      {
        scenarios: withScenarioOverride("Approval turn tool followthrough", {
          details: "timed out before it continued",
        }),
      },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toEqual([
      "anthropic/claude-opus-4-8 produced 1 suspicious pass result(s); baseline fake-success count must also be 0.",
    ]);
  });

  it.each([
    {
      title: "ignores neutral Failed and Blocked headings in passing protocol reports",
      scenarioName: "Source and docs discovery report",
      report: `Worked:
- Read the seeded QA material.
Failed:
- None observed.
Blocked:
- No live provider evidence in this lane.
Follow-up:
- Re-run with a real provider if needed.`,
      expectedSuspiciousPasses: 0,
    },
    {
      title: "still flags genuine error-narration suspicious passes",
      scenarioName: "Approval turn tool followthrough",
      report: "Tool call completed, but an error occurred mid-turn and no retry happened.",
      expectedSuspiciousPasses: 1,
    },
    {
      title: "does not flag bare 'Done.' prose as fake success",
      scenarioName: "Approval turn tool followthrough",
      report: "Done.",
      expectedSuspiciousPasses: 0,
    },
    {
      title: "does not flag structured status lines that end in `done`",
      scenarioName: "Compaction retry after mutating tool",
      report: `Confirmed, replay unsafe after write.
compactionCount=0
status=done`,
      expectedSuspiciousPasses: 0,
    },
  ])("$title", ({ scenarioName, report, expectedSuspiciousPasses }) => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: scenarioName,
          status: "pass",
          details: report,
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(expectedSuspiciousPasses);
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
    const parityPassScenarios: QaParityReportScenario[] = [
      { name: "Approval turn tool followthrough", status: "pass" },
      { name: "Compaction retry after mutating tool", status: "pass" },
      { name: "Model switch with tool continuity", status: "pass" },
      { name: "Source and docs discovery report", status: "pass" },
      { name: "Image understanding from attachment", status: "pass" },
    ];

    expect(() =>
      compareQaAgenticParity(
        {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "anthropic", primaryModel: "claude-opus-4-8" },
        },
        {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "anthropic", primaryModel: "claude-opus-4-8" },
        },
      ),
    ).toThrow("do not match --candidate-label");
  });

  it("throws QaParityLabelMismatchError when the baseline run.primaryProvider does not match the label", () => {
    const parityPassScenarios: QaParityReportScenario[] = [
      { name: "Approval turn tool followthrough", status: "pass" },
    ];

    expect(() =>
      compareQaAgenticParity(
        {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "openai" },
        },
        {
          scenarios: parityPassScenarios,
          run: { primaryProvider: "openai", primaryModel: "gpt-5.6-luna" },
        },
      ),
    ).toThrow(
      /baseline summary run\.primaryProvider=openai and run\.primaryModel=gpt-5\.6-luna do not match --baseline-label/,
    );
  });

  it("accepts matching run.primaryProvider labels without throwing", () => {
    const comparison = compareQaAgenticParity(
      parityPassSummary("openai"),
      parityPassSummary("anthropic"),
    );
    expect(comparison.pass).toBe(true);
  });

  it("skips run.primaryProvider verification when the summary is missing a run block (legacy summaries)", () => {
    // Pre-PR-L summaries don't carry a `run` block. The gate must still
    // work against those, trusting the caller-supplied label.
    const comparison = compareQaAgenticParity(parityPassSummary(), parityPassSummary());
    expect(comparison.pass).toBe(true);
  });

  it("skips provider verification for arbitrary display labels when run metadata is present", () => {
    const comparison = compareQaAgenticParity(
      parityPassSummary("openai"),
      parityPassSummary("anthropic"),
      { candidate: "GPT-5.6 Luna candidate", baseline: "Opus 4.8 baseline" },
    );

    expect(comparison.pass).toBe(true);
  });

  it("skips provider verification for mixed-case or decorated display labels", () => {
    const comparison = compareQaAgenticParity(
      parityPassSummary("openai"),
      parityPassSummary("anthropic"),
      { candidate: "Candidate: GPT-5.6 Luna", baseline: "Opus 4.8 / baseline" },
    );

    expect(comparison.pass).toBe(true);
  });

  it("throws when a structured label mismatches the recorded model even if the provider matches", () => {
    expect(() =>
      compareQaAgenticParity(
        {
          scenarios: FULL_PARITY_PASS_SCENARIOS,
          run: {
            primaryProvider: "openai",
            primaryModel: "openai/gpt-5.6-luna-alt",
            primaryModelName: "gpt-5.6-luna-alt",
          },
        },
        parityPassSummary("anthropic"),
      ),
    ).toThrow(
      /candidate summary run\.primaryProvider=openai and run\.primaryModel=openai\/gpt-5\.6-luna-alt do not match --candidate-label=openai\/gpt-5\.6-luna/,
    );
  });

  it("accepts colon-delimited structured labels when provider and model both match", () => {
    const comparison = compareQaAgenticParity(
      parityPassSummary("openai"),
      parityPassSummary("anthropic"),
      { candidate: "openai:gpt-5.6-luna", baseline: "anthropic:claude-opus-4-8" },
    );

    expect(comparison.pass).toBe(true);
  });

  it("renders a readable markdown parity report", () => {
    // Cover the full parity pack on both sides so the pass
    // verdict is not disrupted by required-scenario coverage failures
    // added by the second-wave expansion.
    const comparison = compareQaAgenticParity(parityPassSummary(), parityPassSummary());

    const report = renderQaAgenticParityMarkdownReport(comparison);

    expect(report).toContain(
      "# OpenClaw Agentic Parity Report — openai/gpt-5.6-luna vs anthropic/claude-opus-4-8",
    );
    expect(report).toContain("| Completion rate | 100.0% | 100.0% |");
    expect(report).toContain("### Approval turn tool followthrough");
    expect(report).toContain("- Verdict: pass");
  });

  it("parametrizes the markdown header from the comparison labels", () => {
    // Regression for the loop-7 Copilot finding: callers that configure
    // non-gpt-5.6-luna / non-opus labels (for example an internal candidate vs
    // another candidate) must see the labels in the rendered H1 instead of
    // the hardcoded "GPT-5.6 Luna / Opus 4.8" title that would otherwise confuse
    // readers of saved reports.
    const comparison = compareQaAgenticParity(
      { scenarios: [] },
      { scenarios: [] },
      { candidate: "openai/gpt-5.6-luna-alt", baseline: "openai/gpt-5.6-luna" },
    );
    const report = renderQaAgenticParityMarkdownReport(comparison);
    expect(report).toContain(
      "# OpenClaw Agentic Parity Report — openai/gpt-5.6-luna-alt vs openai/gpt-5.6-luna",
    );
  });

  it("builds a runtime parity report from suite summaries", () => {
    const report = buildQaRuntimeParityReport({
      summary: makeRuntimeParitySummary(),
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.runtimePair).toEqual(["openclaw", "codex"]);
    expect(report.pass).toBe(true);
    expect(report.driftCounts.none).toBe(1);
    expect(report.driftCounts["tool-call-shape"]).toBe(1);
    expect(report.failures).toEqual([]);
    expect(report.scenarios[0]).toMatchObject({
      openclawWallClockMs: 20,
      codexWallClockMs: 18,
      fasterRuntime: "codex",
      speedupPercent: (2 / 18) * 100,
    });
    expect(report.timing).toEqual({
      openclaw: {
        totalWallClockMs: 40,
        p50WallClockMs: 20,
        p90WallClockMs: 20,
      },
      codex: {
        totalWallClockMs: 37,
        p50WallClockMs: 18,
        p90WallClockMs: 19,
      },
      fasterRuntime: "codex",
      speedupPercent: (3 / 37) * 100,
    });
  });

  it("reports tied zero-duration captures without an invalid speedup", () => {
    const summary = makeRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.wallClockMs = 0;
        scenario.runtimeParity.cells.codex.wallClockMs = 0;
      }
    }

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(true);
    expect(report.timing).toEqual({
      openclaw: { totalWallClockMs: 0, p50WallClockMs: 0, p90WallClockMs: 0 },
      codex: { totalWallClockMs: 0, p50WallClockMs: 0, p90WallClockMs: 0 },
      fasterRuntime: "tie",
      speedupPercent: 0,
    });
    expect(report.scenarios[0]).toMatchObject({
      fasterRuntime: "tie",
      speedupPercent: 0,
    });
  });

  it("excludes missing runtime captures from wall-clock aggregates", () => {
    const summary = makeRuntimeParitySummary();
    summary.scenarios.push({ name: "Missing runtime capture", status: "fail" });

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(false);
    expect(report.timing.openclaw.totalWallClockMs).toBe(40);
    expect(report.timing.codex.totalWallClockMs).toBe(37);
    expect(report.scenarios[2]).toMatchObject({
      openclawWallClockMs: null,
      codexWallClockMs: null,
      fasterRuntime: null,
      speedupPercent: null,
    });
  });

  it("reports missing runtime timing as unavailable instead of zero", () => {
    const report = buildQaRuntimeParityReport({
      summary: {
        scenarios: [{ name: "Missing runtime capture", status: "fail" }],
        counts: { total: 1, passed: 0, failed: 1 },
        run: { providerMode: "live-frontier", runtimePair: ["openclaw", "codex"] },
      },
    });

    expect(report.timing).toEqual({
      openclaw: { totalWallClockMs: null, p50WallClockMs: null, p90WallClockMs: null },
      codex: { totalWallClockMs: null, p50WallClockMs: null, p90WallClockMs: null },
      fasterRuntime: null,
      speedupPercent: null,
    });

    const markdown = renderQaRuntimeParityMarkdownReport(report);
    expect(markdown).toContain("| openclaw | N/A | N/A | N/A |");
    expect(markdown).toContain("| codex | N/A | N/A | N/A |");
    expect(markdown).toContain("- Faster runtime: N/A");
  });

  it.each([
    { description: "hard runtime error", cell: { runtimeErrorClass: "auth" } },
    { description: "failed execution", cell: { status: "fail" as const } },
  ])("fails runtime parity reports with $description", ({ cell }) => {
    const summary = makeRuntimeParitySummary();
    const scenario = summary.scenarios[1];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.status = "fail";
    Object.assign(scenario.runtimeParity.cells.codex, cell);

    const report = buildQaRuntimeParityReport({
      summary,
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failedScenarios).toBe(1);
    expect(report.scenarios[1]?.codexStatus).toBe("fail");
    expect(report.failures).toContain(
      "Compaction retry after mutating tool drift=tool-call-shape (tool call 1 differs).",
    );
  });

  it("preserves an actual catalog harness-gap skip in passing runtime parity evidence", async () => {
    const summary = makeRuntimeParitySummary();
    const catalogScenario = readQaScenarioById("compaction-retry-mutating-tool");
    const captured = summary.scenarios[1]?.runtimeParity;
    if (!captured) {
      throw new Error("runtime parity fixture missing");
    }
    const result = await runRuntimeParityScenario({
      scenarioId: catalogScenario.id,
      runCell: async (runtime) => ({
        status: runtime === "codex" ? "skip" : "pass",
        ...(runtime === "codex"
          ? { details: "known-harness-gap compaction-retry-mutating-tool: native compaction" }
          : {}),
        cell: captured.cells[runtime],
      }),
    });
    summary.scenarios[1] = buildRuntimeParityScenarioResult({
      scenarioName: catalogScenario.title,
      result,
    });

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(true);
    expect(report.scenarios[1]).toMatchObject({
      status: "pass",
      openclawStatus: "pass",
      codexStatus: "skip",
      drift: "structural",
    });
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain("- codex: skip (");
  });

  it("passes runtime parity reports with controlled tool-error cells and advisory drift", () => {
    const summary = makeRuntimeParitySummary();
    const scenario = summary.scenarios[1];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.codex.runtimeErrorClass = "tool-error";

    const report = buildQaRuntimeParityReport({
      summary,
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.failedScenarios).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.scenarios[1]?.codexStatus).toBe("pass");
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain("- codex: pass (1 tool calls");
  });

  it("fails live runtime parity reports when assistant-message usage is missing", () => {
    const summary = makeRuntimeParitySummary();
    summary.run = {
      ...summary.run,
      providerMode: "live-frontier",
    };
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.openclaw.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    scenario.runtimeParity.cells.codex.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const report = buildQaRuntimeParityReport({
      summary,
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failedScenarios).toBe(1);
    expect(report.failures).toContain(
      "Approval turn tool followthrough missing live assistant-message usage (openclaw=0, codex=0).",
    );
    expect(report.scenarios[0]?.status).toBe("fail");
  });

  it("renders explicit non-assistant parity usage as N/A without weakening parity", () => {
    const summary = makeRuntimeParitySummary();
    summary.run = {
      ...summary.run,
      providerMode: "live-frontier",
    };
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.runtimeParityUsage = {
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    };
    scenario.runtimeParity.cells.openclaw.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    scenario.runtimeParity.cells.codex.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const report = buildQaRuntimeParityReport({ summary });
    const markdown = renderQaRuntimeParityMarkdownReport(report);

    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.scenarios[0]?.status).toBe("pass");
    expect(markdown).toContain("- openclaw: pass (1 tool calls, N/A tokens)");
    expect(markdown).toContain(
      "- assistant-message usage: N/A (Local fixture only; no assistant turn runs.)",
    );
  });

  it("keeps non-assistant parity runtime failures red", () => {
    const summary = makeRuntimeParitySummary();
    summary.run = {
      ...summary.run,
      providerMode: "live-frontier",
    };
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.runtimeParityUsage = {
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    };
    scenario.runtimeParity.cells.openclaw.usage.totalTokens = 0;
    scenario.runtimeParity.cells.codex.usage.totalTokens = 0;
    scenario.runtimeParity.cells.codex.runtimeErrorClass = "auth";

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(false);
    expect(report.failedScenarios).toBe(1);
    expect(report.failures).toContain("Approval turn tool followthrough drift=none.");
  });

  it("fails runtime parity reports with no executed scenarios", () => {
    const report = buildQaRuntimeParityReport({
      summary: {
        scenarios: [],
        counts: {
          total: 0,
          passed: 0,
          failed: 0,
        },
        run: {
          providerMode: "live-frontier",
          runtimePair: ["openclaw", "codex"],
        },
      },
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toContain("Runtime parity report has no executed scenarios.");
  });

  it("renders a readable runtime parity markdown report", () => {
    const report = renderQaRuntimeParityMarkdownReport(
      buildQaRuntimeParityReport({
        summary: makeRuntimeParitySummary(),
        comparedAt: "2026-05-10T00:00:00.000Z",
      }),
    );

    expect(report).toContain("# OpenClaw Runtime Parity Report — openclaw vs codex");
    expect(report).toContain("| Tool-call-shape drift | 1 |");
    expect(report).toContain("## Runtime Timing");
    expect(report).toContain("| openclaw | 40 ms | 20 ms | 20 ms |");
    expect(report).toContain("| codex | 37 ms | 18 ms | 19 ms |");
    expect(report).toContain("- Faster runtime: codex 8.1% faster");
    expect(report).toContain("### Compaction retry after mutating tool");
    expect(report).toContain("- drift: tool-call-shape");
    expect(report).toContain("- wall time: openclaw 20 ms; codex 19 ms; codex 5.3% faster");
  });
});
