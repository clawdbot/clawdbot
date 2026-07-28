// Runtime-pair summary validator tests cover frozen release candidate evidence.
import { describe, expect, it } from "vitest";
import {
  validateQaRuntimePairReport,
  validateQaRuntimePairSummary,
} from "../../scripts/validate-qa-runtime-pair-summary.mjs";

type CellStatus = "pass" | "fail" | "skip";

type RuntimeCell = {
  runtime: "openclaw" | "codex";
  status: CellStatus;
  details?: string;
  runtimeErrorClass?: string;
  toolCalls: Array<{ errorClass?: string }>;
};

type ScenarioParams = {
  name: string;
  status: CellStatus;
  drift?: "none" | "structural" | "failure-mode";
  openclawStatus?: CellStatus;
  codexStatus?: CellStatus;
  codexDetails?: string;
};

function cell(runtime: "openclaw" | "codex", status: CellStatus, details?: string): RuntimeCell {
  return {
    runtime,
    status,
    ...(details ? { details } : {}),
    toolCalls: [],
  };
}

function scenario(params: ScenarioParams) {
  const scenarioId = params.name.toLowerCase().replaceAll(" ", "-");
  return {
    name: params.name,
    status: params.status,
    runtimeParity: {
      scenarioId,
      drift: params.drift ?? (params.status === "pass" ? "none" : "failure-mode"),
      cells: {
        openclaw: cell("openclaw", params.openclawStatus ?? "pass"),
        codex: cell("codex", params.codexStatus ?? "pass", params.codexDetails),
      },
    },
  };
}

function summary(scenarios: ReturnType<typeof scenario>[]) {
  return {
    run: {
      runtimePair: ["openclaw", "codex"],
      scenarioIds: scenarios.map((entry) => entry.runtimeParity.scenarioId),
    },
    counts: {
      total: scenarios.length,
      passed: scenarios.filter((entry) => entry.status === "pass").length,
      failed: scenarios.filter((entry) => entry.status === "fail").length,
      skipped: scenarios.filter((entry) => entry.status === "skip").length,
    },
    scenarios,
  };
}

const frozenCoreScenarioIds = [
  "instruction-followthrough-repo-contract",
  "subagent-fanout-synthesis",
  "subagent-handoff",
  "subagent-stale-child-links",
  "config-restart-capability-flip",
  "image-understanding-attachment",
  "memory-recall",
  "thread-memory-isolation",
  "model-switch-tool-continuity",
  "approval-turn-tool-followthrough",
  "codex-plugin-pinned-new",
  "codex-plugin-pinned-old",
  "compaction-retry-mutating-tool",
  "runtime-first-hour-20-turn",
  "runtime-tool-apply-patch",
  "runtime-tool-bash",
  "runtime-tool-edit",
  "runtime-tool-exec",
  "runtime-tool-fs-list",
  "runtime-tool-fs-read",
  "runtime-tool-fs-write",
  "runtime-tool-grep",
  "runtime-tool-session-status",
  "runtime-tool-sessions-spawn",
  "runtime-tool-web-fetch",
  "runtime-tool-web-search",
  "source-docs-discovery-report",
] as const;
const frozenCoreGapScenarioIds = new Set<string>([
  "runtime-tool-apply-patch",
  "runtime-tool-bash",
  "runtime-tool-edit",
  "runtime-tool-exec",
  "runtime-tool-fs-list",
  "runtime-tool-fs-read",
  "runtime-tool-fs-write",
  "runtime-tool-grep",
]);

function frozenCoreSummary() {
  return summary(
    frozenCoreScenarioIds.map((scenarioId) => {
      const isGap = frozenCoreGapScenarioIds.has(scenarioId);
      return scenario({
        name: scenarioId,
        status: isGap ? "skip" : "pass",
        ...(isGap
          ? {
              codexStatus: "skip",
              codexDetails: "known-harness-gap exec: tracked",
            }
          : {}),
      });
    }),
  );
}

describe("frozen QA runtime-pair summary validation", () => {
  it("accepts only passing scenarios and explicit one-sided Codex-native gaps", () => {
    const fixture = summary([
      scenario({ name: "passing", status: "pass" }),
      scenario({
        name: "tracked gap",
        status: "skip",
        codexStatus: "skip",
        codexDetails: "known-harness-gap exec: tracked\ntracking: #80319",
      }),
      scenario({
        name: "legacy native gap",
        status: "skip",
        codexStatus: "skip",
        codexDetails: "codex-native-workspace read: Codex owns this operation natively",
      }),
    ]);

    expect(validateQaRuntimePairSummary(fixture)).toEqual({
      total: 3,
      passed: 1,
      failed: 0,
      skipped: 2,
    });
  });

  it("accepts a tracked Codex harness gap kept advisory by the current classifier", () => {
    const advisoryGap = scenario({
      name: "tracked advisory gap",
      status: "pass",
      drift: "structural",
      codexStatus: "skip",
      codexDetails: "known-harness-gap exec: tracked\ntracking: #80319",
    });

    const fixture = summary([advisoryGap]);
    expect(validateQaRuntimePairSummary(fixture)).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });

    const reportSummary = {
      runtimePair: ["openclaw", "codex"],
      totalScenarios: 1,
      passedScenarios: 1,
      failedScenarios: 0,
      scenarios: [
        {
          name: "tracked advisory gap",
          status: "pass",
          drift: "structural",
          driftDetails: undefined,
          openclawStatus: "pass",
          codexStatus: "pass",
        },
      ],
      failures: [],
      pass: true,
    };
    const markdown =
      "# OpenClaw Runtime Parity Report — openclaw vs codex\n\n- Verdict: pass\n\n### tracked advisory gap\n\n- status: pass\n- drift: structural\n- openclaw: pass (0 tool calls)\n- codex: pass (0 tool calls)\n";
    expect(validateQaRuntimePairReport(fixture, reportSummary, markdown)).toMatchObject({
      total: 1,
      passed: 1,
    });
  });

  it("rejects malformed or unsafe advisory gap evidence", () => {
    const buildAdvisoryGap = () => {
      const advisoryGap = scenario({
        name: "tracked advisory gap",
        status: "pass",
        drift: "structural",
        codexStatus: "skip",
        codexDetails: "known-harness-gap exec: tracked\ntracking: #80319",
      });
      return advisoryGap;
    };

    const unannotated = buildAdvisoryGap();
    unannotated.runtimeParity.cells.codex.details = "implementation unavailable";
    expect(() => validateQaRuntimePairSummary(summary([unannotated]))).toThrow(
      "reports pass without two passing, passable runtime cells",
    );

    const pairedSkip = buildAdvisoryGap();
    pairedSkip.runtimeParity.cells.openclaw.status = "skip";
    expect(() => validateQaRuntimePairSummary(summary([pairedSkip]))).toThrow(
      "reports pass without two passing, passable runtime cells",
    );

    const hardError = buildAdvisoryGap();
    hardError.runtimeParity.cells.codex.runtimeErrorClass = "auth";
    expect(() => validateQaRuntimePairSummary(summary([hardError]))).toThrow(
      "reports pass without two passing, passable runtime cells",
    );

    const missingResult = buildAdvisoryGap();
    missingResult.runtimeParity.cells.codex.toolCalls.push({
      errorClass: "tool-result-missing",
    });
    expect(() => validateQaRuntimePairSummary(summary([missingResult]))).toThrow(
      "reports pass without two passing, passable runtime cells",
    );

    const failureMode = buildAdvisoryGap();
    failureMode.runtimeParity.drift = "failure-mode";
    expect(() => validateQaRuntimePairSummary(summary([failureMode]))).toThrow(
      "reports pass without two passing, passable runtime cells",
    );
  });

  const rejectedSkips: Array<
    [string, Partial<Pick<ScenarioParams, "codexDetails" | "openclawStatus">>]
  > = [
    ["unannotated skip", { codexDetails: "implementation unavailable" }],
    ["paired skip", { openclawStatus: "skip" }],
    ["failed peer", { openclawStatus: "fail" }],
  ];

  it.each(rejectedSkips)("rejects %s", (_label, overrides) => {
    const fixture = summary([
      scenario({
        name: "blocked",
        status: "skip",
        codexStatus: "skip",
        codexDetails: "known-harness-gap exec: tracked",
        ...overrides,
      }),
    ]);

    expect(() => validateQaRuntimePairSummary(fixture)).toThrow(
      "contains a runtime-pair failure or unsupported skip",
    );
  });

  it("rejects hard errors and missing tool results hidden behind an explicit gap", () => {
    const hardError = summary([
      scenario({
        name: "hard error",
        status: "skip",
        codexStatus: "skip",
        codexDetails: "known-harness-gap exec: tracked",
      }),
    ]);
    hardError.scenarios[0]!.runtimeParity.cells.codex.runtimeErrorClass = "auth";
    expect(() => validateQaRuntimePairSummary(hardError)).toThrow("unsupported skip");

    const missingResult = summary([
      scenario({
        name: "missing result",
        status: "skip",
        codexStatus: "skip",
        codexDetails: "known-harness-gap exec: tracked",
      }),
    ]);
    missingResult.scenarios[0]!.runtimeParity.cells.codex.toolCalls.push({
      errorClass: "tool-result-missing",
    });
    expect(() => validateQaRuntimePairSummary(missingResult)).toThrow("unsupported skip");
  });

  it("rejects count drift instead of overlooking hidden failures", () => {
    const fixture = summary([scenario({ name: "passing", status: "pass" })]);
    fixture.counts.passed = 0;

    expect(() => validateQaRuntimePairSummary(fixture)).toThrow(
      "counts do not match validated scenario evidence",
    );
  });

  it("requires complete declared results before overriding a nonzero suite exit", () => {
    const passingOnly = summary([scenario({ name: "passing", status: "pass" })]);
    expect(() =>
      validateQaRuntimePairSummary(passingOnly, {
        requireExplicitGap: true,
        targetSha: "311047822ecdde24e824d839ab105ef08f17be00",
        lane: "core",
      }),
    ).toThrow("requires an explicit Codex-native harness gap");

    const incomplete = summary([scenario({ name: "passing", status: "pass" })]);
    incomplete.run.scenarioIds.push("missing-result");
    expect(() => validateQaRuntimePairSummary(incomplete)).toThrow(
      "do not match the declared scenario manifest",
    );
  });

  it.each(["311047822ecdde24e824d839ab105ef08f17be00", "c37af96b18776fecc9e24268f27fc89b563481bf"])(
    "accepts the exact frozen core manifest for %s",
    (targetSha) => {
      const fixture = frozenCoreSummary();
      expect(
        validateQaRuntimePairSummary(fixture, {
          requireExplicitGap: true,
          targetSha,
          lane: "core",
        }),
      ).toMatchObject({ skipped: 8 });
    },
  );

  it("rejects an arbitrary target with otherwise identical frozen evidence", () => {
    expect(() =>
      validateQaRuntimePairSummary(frozenCoreSummary(), {
        requireExplicitGap: true,
        targetSha: "0000000000000000000000000000000000000000",
        lane: "core",
      }),
    ).toThrow("trusted frozen-lane manifest");
  });

  it("pins the exact frozen scenarios that may use the explicit gap exception", () => {
    const fixture = frozenCoreSummary();

    const expectedGap = fixture.scenarios.find(
      (entry) => entry.runtimeParity.scenarioId === "runtime-tool-apply-patch",
    )!;
    expectedGap.status = "pass";
    expectedGap.runtimeParity.drift = "none";
    expectedGap.runtimeParity.cells.codex.status = "pass";
    delete expectedGap.runtimeParity.cells.codex.details;
    const unrelated = fixture.scenarios.find(
      (entry) => entry.runtimeParity.scenarioId === "instruction-followthrough-repo-contract",
    )!;
    unrelated.status = "skip";
    unrelated.runtimeParity.drift = "failure-mode";
    unrelated.runtimeParity.cells.codex.status = "skip";
    unrelated.runtimeParity.cells.codex.details = "known-harness-gap exec: tracked";

    expect(() =>
      validateQaRuntimePairSummary(fixture, {
        requireExplicitGap: true,
        targetSha: "c37af96b18776fecc9e24268f27fc89b563481bf",
        lane: "core",
      }),
    ).toThrow("trusted frozen-lane manifest");
  });

  it("cross-checks generated report JSON and Markdown", () => {
    const fixture = summary([scenario({ name: "Passing", status: "pass" })]);
    const reportSummary = {
      runtimePair: ["openclaw", "codex"],
      totalScenarios: 1,
      passedScenarios: 1,
      failedScenarios: 0,
      scenarios: [
        {
          name: "Passing",
          status: "pass",
          drift: "none",
          driftDetails: undefined,
          openclawStatus: "pass",
          codexStatus: "pass",
        },
      ],
      failures: [],
      pass: true,
    };
    const markdown =
      "# OpenClaw Runtime Parity Report — openclaw vs codex\n\n- Verdict: pass\n\n### Passing\n\n- status: pass\n- drift: none\n- openclaw: pass (0 tool calls)\n- codex: pass (0 tool calls)\n";
    expect(validateQaRuntimePairReport(fixture, reportSummary, markdown)).toMatchObject({
      total: 1,
      passed: 1,
    });

    reportSummary.scenarios = [];
    expect(() => validateQaRuntimePairReport(fixture, reportSummary, markdown)).toThrow(
      "report summary does not match",
    );
  });
});
