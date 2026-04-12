import { QA_AGENTIC_PARITY_SCENARIO_TITLES } from "./agentic-parity.js";

export type QaParityReportStep = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
};

export type QaParityReportScenario = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
  steps?: QaParityReportStep[];
};

export type QaParitySuiteSummary = {
  scenarios: QaParityReportScenario[];
  counts?: {
    total?: number;
    passed?: number;
    failed?: number;
  };
};

export type QaAgenticParityMetrics = {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  completionRate: number;
  unintendedStopCount: number;
  unintendedStopRate: number;
  validToolCallCount: number;
  validToolCallRate: number;
  fakeSuccessCount: number;
};

export type QaAgenticParityScenarioComparison = {
  name: string;
  candidateStatus: "pass" | "fail" | "skip" | "missing";
  baselineStatus: "pass" | "fail" | "skip" | "missing";
  candidateDetails?: string;
  baselineDetails?: string;
};

export type QaAgenticParityComparison = {
  candidateLabel: string;
  baselineLabel: string;
  comparedAt: string;
  candidateMetrics: QaAgenticParityMetrics;
  baselineMetrics: QaAgenticParityMetrics;
  scenarioComparisons: QaAgenticParityScenarioComparison[];
  pass: boolean;
  failures: string[];
  notes: string[];
};

const UNINTENDED_STOP_PATTERNS = [
  /incomplete turn/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /\bstopped\b/i,
  /\bblocked\b/i,
  /\babandoned\b/i,
  /did not continue/i,
] as const;

const SUSPICIOUS_PASS_PATTERNS = [
  /incomplete turn/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /\bfailed to\b/i,
  /\bcould not\b/i,
  /\bunable to\b/i,
  /did not continue/i,
  /error occurred/i,
  /an error was/i,
] as const;

function normalizeScenarioStatus(status: string | undefined): "pass" | "fail" | "skip" {
  return status === "pass" || status === "fail" || status === "skip" ? status : "fail";
}

function scenarioText(scenario: QaParityReportScenario) {
  const parts = [scenario.details ?? ""];
  for (const step of scenario.steps ?? []) {
    parts.push(step.details ?? "");
  }
  return parts.filter(Boolean).join("\n");
}

function scenarioHasPattern(
  scenario: QaParityReportScenario,
  patterns: readonly RegExp[],
): boolean {
  const text = scenarioText(scenario);
  return text.length > 0 && patterns.some((pattern) => pattern.test(text));
}

export function computeQaAgenticParityMetrics(
  summary: QaParitySuiteSummary,
): QaAgenticParityMetrics {
  const scenarios = summary.scenarios.map((scenario) => ({
    ...scenario,
    status: normalizeScenarioStatus(scenario.status),
  }));
  const totalScenarios = summary.counts?.total ?? scenarios.length;
  const passedScenarios =
    summary.counts?.passed ?? scenarios.filter((scenario) => scenario.status === "pass").length;
  const failedScenarios =
    summary.counts?.failed ?? scenarios.filter((scenario) => scenario.status === "fail").length;
  const unintendedStopCount = scenarios.filter(
    (scenario) =>
      scenario.status !== "pass" && scenarioHasPattern(scenario, UNINTENDED_STOP_PATTERNS),
  ).length;
  const fakeSuccessCount = scenarios.filter(
    (scenario) =>
      scenario.status === "pass" && scenarioHasPattern(scenario, SUSPICIOUS_PASS_PATTERNS),
  ).length;

  // First-wave parity scenarios are all tool-mediated tasks, so a passing scenario is our
  // verified unit of valid tool-backed execution in this harness.
  const validToolCallCount = passedScenarios;

  const rate = (value: number) => (totalScenarios > 0 ? value / totalScenarios : 0);
  return {
    totalScenarios,
    passedScenarios,
    failedScenarios,
    completionRate: rate(passedScenarios),
    unintendedStopCount,
    unintendedStopRate: rate(unintendedStopCount),
    validToolCallCount,
    validToolCallRate: rate(validToolCallCount),
    fakeSuccessCount,
  };
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function requiredCoverageStatus(
  scenario: QaParityReportScenario | undefined,
): "pass" | "fail" | "skip" | "missing" {
  return scenario ? normalizeScenarioStatus(scenario.status) : "missing";
}

function scopeSummaryToParityPack(
  summary: QaParitySuiteSummary,
  parityTitleSet: ReadonlySet<string>,
): QaParitySuiteSummary {
  // The parity verdict must only consider the declared first-wave parity scenarios.
  // Drop `counts` so the metric helper recomputes totals from the filtered scenario
  // list instead of inheriting the caller's full-suite counters.
  return {
    scenarios: summary.scenarios.filter((scenario) => parityTitleSet.has(scenario.name)),
  };
}

export function buildQaAgenticParityComparison(params: {
  candidateLabel: string;
  baselineLabel: string;
  candidateSummary: QaParitySuiteSummary;
  baselineSummary: QaParitySuiteSummary;
  comparedAt?: string;
}): QaAgenticParityComparison {
  const parityTitleSet: ReadonlySet<string> = new Set<string>(QA_AGENTIC_PARITY_SCENARIO_TITLES);
  // Rates and fake-success counts are computed from the parity-scoped summaries only,
  // so extra non-parity scenarios in the input (for example when a caller feeds a full
  // qa-suite-summary.json rather than a --parity-pack agentic run) cannot influence
  // the gate verdict.
  const candidateMetrics = computeQaAgenticParityMetrics(
    scopeSummaryToParityPack(params.candidateSummary, parityTitleSet),
  );
  const baselineMetrics = computeQaAgenticParityMetrics(
    scopeSummaryToParityPack(params.baselineSummary, parityTitleSet),
  );

  const scenarioNames = new Set([
    ...QA_AGENTIC_PARITY_SCENARIO_TITLES,
    ...params.candidateSummary.scenarios.map((scenario) => scenario.name),
    ...params.baselineSummary.scenarios.map((scenario) => scenario.name),
  ]);
  const candidateByName = new Map(
    params.candidateSummary.scenarios.map((scenario) => [scenario.name, scenario]),
  );
  const baselineByName = new Map(
    params.baselineSummary.scenarios.map((scenario) => [scenario.name, scenario]),
  );

  const scenarioComparisons = [...scenarioNames]
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => {
      const candidate = candidateByName.get(name);
      const baseline = baselineByName.get(name);
      return {
        name,
        candidateStatus: candidate ? normalizeScenarioStatus(candidate.status) : "missing",
        baselineStatus: baseline ? normalizeScenarioStatus(baseline.status) : "missing",
        ...(candidate?.details ? { candidateDetails: candidate.details } : {}),
        ...(baseline?.details ? { baselineDetails: baseline.details } : {}),
      } satisfies QaAgenticParityScenarioComparison;
    });

  const failures: string[] = [];
  const requiredScenarioCoverage = QA_AGENTIC_PARITY_SCENARIO_TITLES.map((name) => {
    const candidate = candidateByName.get(name);
    const baseline = baselineByName.get(name);
    return {
      name,
      candidateStatus: requiredCoverageStatus(candidate),
      baselineStatus: requiredCoverageStatus(baseline),
    };
  }).filter(
    (scenario) =>
      scenario.candidateStatus === "missing" ||
      scenario.baselineStatus === "missing" ||
      scenario.candidateStatus === "skip" ||
      scenario.baselineStatus === "skip",
  );
  for (const scenario of requiredScenarioCoverage) {
    failures.push(
      `Missing required parity scenario coverage for ${scenario.name}: ${params.candidateLabel}=${scenario.candidateStatus}, ${params.baselineLabel}=${scenario.baselineStatus}.`,
    );
  }
  // Required parity scenarios are already reported via `requiredScenarioCoverage`
  // above; excluding them here keeps the operator-facing failure list from
  // double-counting the same missing scenario (one "Missing required parity scenario
  // coverage for X" line plus a "Scenario coverage mismatch for X" line on the same
  // scenario).
  const coverageMismatch = scenarioComparisons.filter(
    (scenario) =>
      !parityTitleSet.has(scenario.name) &&
      (scenario.candidateStatus === "missing" || scenario.baselineStatus === "missing"),
  );
  for (const scenario of coverageMismatch) {
    failures.push(
      `Scenario coverage mismatch for ${scenario.name}: ${params.candidateLabel}=${scenario.candidateStatus}, ${params.baselineLabel}=${scenario.baselineStatus}.`,
    );
  }
  if (candidateMetrics.completionRate < baselineMetrics.completionRate) {
    failures.push(
      `${params.candidateLabel} completion rate ${formatPercent(candidateMetrics.completionRate)} is below ${params.baselineLabel} ${formatPercent(baselineMetrics.completionRate)}.`,
    );
  }
  if (candidateMetrics.unintendedStopRate > baselineMetrics.unintendedStopRate) {
    failures.push(
      `${params.candidateLabel} unintended-stop rate ${formatPercent(candidateMetrics.unintendedStopRate)} exceeds ${params.baselineLabel} ${formatPercent(baselineMetrics.unintendedStopRate)}.`,
    );
  }
  if (candidateMetrics.validToolCallRate < baselineMetrics.validToolCallRate) {
    failures.push(
      `${params.candidateLabel} valid-tool-call rate ${formatPercent(candidateMetrics.validToolCallRate)} is below ${params.baselineLabel} ${formatPercent(baselineMetrics.validToolCallRate)}.`,
    );
  }
  if (candidateMetrics.fakeSuccessCount > 0) {
    failures.push(
      `${params.candidateLabel} produced ${candidateMetrics.fakeSuccessCount} suspicious pass result(s); fake-success count must be 0.`,
    );
  }
  if (baselineMetrics.fakeSuccessCount > 0) {
    failures.push(
      `${params.baselineLabel} produced ${baselineMetrics.fakeSuccessCount} suspicious pass result(s); baseline fake-success count must also be 0.`,
    );
  }

  return {
    candidateLabel: params.candidateLabel,
    baselineLabel: params.baselineLabel,
    comparedAt: params.comparedAt ?? new Date().toISOString(),
    candidateMetrics,
    baselineMetrics,
    scenarioComparisons,
    pass: failures.length === 0,
    failures,
    notes: [
      "First-wave valid-tool-call rate is scenario-level and uses passing tool-mediated scenarios as the verified numerator.",
      "Auth/proxy/DNS correctness is intentionally out of scope for this parity report and should be gated by the deterministic runtime-truthfulness suites.",
    ],
  };
}

export function renderQaAgenticParityMarkdownReport(comparison: QaAgenticParityComparison): string {
  const lines = [
    "# OpenClaw GPT-5.4 / Opus 4.6 Agentic Parity Report",
    "",
    `- Compared at: ${comparison.comparedAt}`,
    `- Candidate: ${comparison.candidateLabel}`,
    `- Baseline: ${comparison.baselineLabel}`,
    `- Verdict: ${comparison.pass ? "pass" : "fail"}`,
    "",
    "## Aggregate Metrics",
    "",
    "| Metric | Candidate | Baseline |",
    "| --- | ---: | ---: |",
    `| Completion rate | ${formatPercent(comparison.candidateMetrics.completionRate)} | ${formatPercent(comparison.baselineMetrics.completionRate)} |`,
    `| Unintended-stop rate | ${formatPercent(comparison.candidateMetrics.unintendedStopRate)} | ${formatPercent(comparison.baselineMetrics.unintendedStopRate)} |`,
    `| Valid-tool-call rate | ${formatPercent(comparison.candidateMetrics.validToolCallRate)} | ${formatPercent(comparison.baselineMetrics.validToolCallRate)} |`,
    `| Fake-success count | ${comparison.candidateMetrics.fakeSuccessCount} | ${comparison.baselineMetrics.fakeSuccessCount} |`,
    "",
  ];

  if (comparison.failures.length > 0) {
    lines.push("## Gate Failures", "");
    for (const failure of comparison.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
  }

  lines.push("## Scenario Comparison", "");
  for (const scenario of comparison.scenarioComparisons) {
    lines.push(`### ${scenario.name}`, "");
    lines.push(`- ${comparison.candidateLabel}: ${scenario.candidateStatus}`);
    lines.push(`- ${comparison.baselineLabel}: ${scenario.baselineStatus}`);
    if (scenario.candidateDetails) {
      lines.push(`- ${comparison.candidateLabel} details: ${scenario.candidateDetails}`);
    }
    if (scenario.baselineDetails) {
      lines.push(`- ${comparison.baselineLabel} details: ${scenario.baselineDetails}`);
    }
    lines.push("");
  }

  lines.push("## Notes", "");
  for (const note of comparison.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return lines.join("\n");
}
