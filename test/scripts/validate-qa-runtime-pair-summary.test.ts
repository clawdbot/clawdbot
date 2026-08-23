// Runtime-pair summary validator tests cover frozen release candidate evidence.
import { describe, expect, it } from "vitest";
import {
  validateQaRuntimePairReport,
  validateQaRuntimePairSummary,
} from "../../scripts/validate-qa-runtime-pair-summary.mts";

type CellStatus = "pass" | "fail" | "skip";

type RuntimeCell = {
  runtime: "openclaw" | "codex";
  status?: CellStatus;
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
      status: "completed",
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
  // Mirrors the immutable report shape for the fixed candidate SHAs, not the live catalog.
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
const frozenLegacyCoreScenarioIds = frozenCoreScenarioIds.filter(
  (scenarioId) =>
    scenarioId !== "codex-plugin-pinned-new" && scenarioId !== "codex-plugin-pinned-old",
);
const frozenLegacyTargetShas = [
  "ee5ead24b1b46a3560f28f8d57e0afcd911acacb",
  "9a83cbf29d8f637cbe566d809811cb6a13c93664",
  "3203a6f7f8d79644fde2b4f091a694f4c1698538",
] as const;

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

function frozenLegacyStatuslessSummary() {
  const fixture = summary(
    frozenLegacyCoreScenarioIds.map((scenarioId) =>
      scenario({
        name: scenarioId,
        status: "pass",
      }),
    ),
  );
  delete (fixture.run as { status?: string }).status;
  return Object.assign(fixture, {
    run: {
      ...fixture.run,
      startedAt: "2026-08-22T06:02:37.608Z",
      finishedAt: "2026-08-22T06:14:49.336Z",
    },
  });
}

function reportFor(scenarios: ReturnType<typeof scenario>[]) {
  return {
    runtimePair: ["openclaw", "codex"],
    totalScenarios: scenarios.length,
    passedScenarios: scenarios.length,
    failedScenarios: 0,
    scenarios: scenarios.map((entry) => ({
      name: entry.name,
      status: "pass",
      drift: entry.runtimeParity.drift,
      driftDetails: undefined,
      openclawStatus: "pass",
      codexStatus: "pass",
    })),
    failures: [],
    pass: true,
  };
}

function markdownFor(scenarios: ReturnType<typeof scenario>[]) {
  return [
    "# OpenClaw Runtime Parity Report — openclaw vs codex",
    "",
    "- Verdict: pass",
    ...scenarios.flatMap((entry) => [
      "",
      `### ${entry.name}`,
      "",
      "- status: pass",
      `- drift: ${entry.runtimeParity.drift}`,
      "- openclaw: pass (0 tool calls)",
      "- codex: pass (0 tool calls)",
    ]),
    "",
  ].join("\n");
}

describe("frozen QA runtime-pair summary validation", () => {
  it("rejects a nonterminal runtime-pair summary", () => {
    const fixture = summary([scenario({ name: "running", status: "pass" })]);
    fixture.run.status = "running";

    expect(() => validateQaRuntimePairSummary(fixture)).toThrow(
      "runtime-pair summary is not completed",
    );
  });

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

  it("accepts statusless passing cells from an older frozen candidate", () => {
    const legacyScenario = scenario({ name: "legacy passing", status: "pass" });
    delete legacyScenario.runtimeParity.cells.openclaw.status;
    delete legacyScenario.runtimeParity.cells.codex.status;

    expect(validateQaRuntimePairSummary(summary([legacyScenario]))).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("accepts an older all-passing summary that omitted zero skipped count", () => {
    const fixture = summary([scenario({ name: "legacy passing", status: "pass" })]);
    delete (fixture.counts as { skipped?: number }).skipped;

    expect(validateQaRuntimePairSummary(fixture)).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  describe.each(frozenLegacyTargetShas)("statusless frozen core profile %s", (targetSha) => {
    it("accepts the exact profile after a successful suite", () => {
      expect(
        validateQaRuntimePairSummary(frozenLegacyStatuslessSummary(), {
          candidateSuiteOutcome: "success",
          targetSha,
          lane: "core",
        }),
      ).toEqual({
        total: 25,
        passed: 25,
        failed: 0,
        skipped: 0,
      });
    });

    it("rejects a nonterminal status", () => {
      const fixture = frozenLegacyStatuslessSummary();
      fixture.run.status = "running";

      expect(() =>
        validateQaRuntimePairSummary(fixture, {
          candidateSuiteOutcome: "success",
          targetSha,
          lane: "core",
        }),
      ).toThrow("runtime-pair summary is not completed");
    });

    it.each([
      ["missing suite outcome", { targetSha, lane: "core" }],
      ["failed suite", { candidateSuiteOutcome: "failure", targetSha, lane: "core" }],
      ["skipped suite", { candidateSuiteOutcome: "skipped", targetSha, lane: "core" }],
      ["cancelled suite", { candidateSuiteOutcome: "cancelled", targetSha, lane: "core" }],
      ["unknown suite outcome", { candidateSuiteOutcome: "unknown", targetSha, lane: "core" }],
      [
        "wrong target",
        { candidateSuiteOutcome: "success", targetSha: "0".repeat(40), lane: "core" },
      ],
      ["wrong lane", { candidateSuiteOutcome: "success", targetSha, lane: "soak" }],
    ])("rejects evidence with %s", (_label, options) => {
      expect(() => validateQaRuntimePairSummary(frozenLegacyStatuslessSummary(), options)).toThrow(
        "runtime-pair summary is not completed",
      );
    });

    it.each([
      ["missing startedAt", undefined, "2026-08-22T06:14:49.336Z"],
      ["missing finishedAt", "2026-08-22T06:02:37.608Z", undefined],
      ["invalid startedAt", "not-a-date", "2026-08-22T06:14:49.336Z"],
      ["invalid finishedAt", "2026-08-22T06:02:37.608Z", "not-a-date"],
      ["reversed timestamps", "2026-08-22T06:14:49.336Z", "2026-08-22T06:02:37.608Z"],
    ])("rejects evidence with %s", (_label, startedAt, finishedAt) => {
      const fixture = frozenLegacyStatuslessSummary();
      if (startedAt === undefined) {
        delete (fixture.run as { startedAt?: string }).startedAt;
      } else {
        fixture.run.startedAt = startedAt;
      }
      if (finishedAt === undefined) {
        delete (fixture.run as { finishedAt?: string }).finishedAt;
      } else {
        fixture.run.finishedAt = finishedAt;
      }

      expect(() =>
        validateQaRuntimePairSummary(fixture, {
          candidateSuiteOutcome: "success",
          targetSha,
          lane: "core",
        }),
      ).toThrow("runtime-pair summary is not completed");
    });

    it("rejects manifest drift before profile admission", () => {
      const fixture = frozenLegacyStatuslessSummary();
      fixture.run.scenarioIds.reverse();
      fixture.scenarios.reverse();

      expect(() =>
        validateQaRuntimePairSummary(fixture, {
          candidateSuiteOutcome: "success",
          targetSha,
          lane: "core",
        }),
      ).toThrow("runtime-pair summary is not completed");
    });

    it("still rejects scenario and count failures after profile admission", () => {
      const options = {
        candidateSuiteOutcome: "success",
        targetSha,
        lane: "core",
      };
      const failedScenario = frozenLegacyStatuslessSummary();
      failedScenario.scenarios[0]!.status = "fail";
      failedScenario.counts.passed -= 1;
      failedScenario.counts.failed += 1;
      expect(() => validateQaRuntimePairSummary(failedScenario, options)).toThrow(
        "runtime-pair failure or unsupported skip",
      );

      const countDrift = frozenLegacyStatuslessSummary();
      countDrift.counts.passed -= 1;
      expect(() => validateQaRuntimePairSummary(countDrift, options)).toThrow(
        "counts do not match validated scenario evidence",
      );
    });

    it("applies the trusted suite outcome gate to report validation", () => {
      const fixture = frozenLegacyStatuslessSummary();
      const reportSummary = reportFor(fixture.scenarios);
      const markdown = markdownFor(fixture.scenarios);
      const options = {
        candidateSuiteOutcome: "success",
        targetSha,
        lane: "core",
      };

      expect(validateQaRuntimePairReport(fixture, reportSummary, markdown, options)).toMatchObject({
        total: 25,
        passed: 25,
      });
      expect(() =>
        validateQaRuntimePairReport(fixture, reportSummary, markdown, {
          ...options,
          candidateSuiteOutcome: "failure",
        }),
      ).toThrow("runtime-pair summary is not completed");
    });
  });

  it("requires skipped count when validated evidence contains skips", () => {
    const fixture = summary([
      scenario({
        name: "tracked gap",
        status: "skip",
        codexStatus: "skip",
        codexDetails: "known-harness-gap exec: tracked",
      }),
    ]);
    delete (fixture.counts as { skipped?: number }).skipped;

    expect(() => validateQaRuntimePairSummary(fixture)).toThrow(
      "counts do not match validated scenario evidence",
    );
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
