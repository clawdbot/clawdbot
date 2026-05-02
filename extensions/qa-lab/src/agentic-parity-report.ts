import {
  QA_AGENTIC_PARITY_SCENARIO_TITLES,
  QA_AGENTIC_PARITY_TOOL_BACKED_SCENARIO_TITLES,
} from "./agentic-parity.js";

type QaParityReportStep = {
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

/**
 * Optional self-describing run metadata written by PR L (#64789). Before
 * that PR merges, older summaries only have `scenarios` + `counts`; the
 * parity report treats a missing `run` block as "unknown provenance" and
 * skips the label-match verification for backwards compatibility
 * with legacy summaries that predate the run metadata block.
 */
type QaParityRunBlock = {
  primaryProvider?: string;
  primaryModel?: string;
  primaryModelName?: string;
  providerMode?: string;
  scenarioIds?: readonly string[] | null;
};

export type QaParitySuiteSummary = {
  scenarios: QaParityReportScenario[];
  counts?: {
    total?: number;
    passed?: number;
    failed?: number;
  };
  /** Self-describing run metadata — see PR L #64789 for the writer side. */
  run?: QaParityRunBlock;
};

type QaAgenticParityMetrics = {
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

type QaAgenticParityScenarioComparison = {
  name: string;
  candidateStatus: "pass" | "fail" | "skip" | "missing";
  baselineStatus: "pass" | "fail" | "skip" | "missing";
  candidateDetails?: string;
  baselineDetails?: string;
};

type QaAgenticParityComparison = {
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

// Failure-tone patterns: a passing scenario whose details text matches any
// of these is treated as a "fake success" — the scenario is marked pass but
// the supporting text reveals something went wrong. Adding new patterns here
// widens the net for bad prose that correlates with runtime failure modes.
const SUSPICIOUS_PASS_FAILURE_TONE_PATTERNS = [
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

// Positive-tone patterns (e.g. "Successfully completed", "Done.") are NOT
// checked in fakeSuccessCount. For passing runs, `details` is the model's
// outbound prose, which never contains tool-call evidence strings, so a
// tool-call-evidence exemption would false-positive on every legitimate
// pass. Criterion 2 ("no fake progress") is enforced by per-scenario
// `/debug/requests` tool-call assertions in the YAML flows (PR J) instead.

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
  const toolBackedTitleSet: ReadonlySet<string> = new Set(
    QA_AGENTIC_PARITY_TOOL_BACKED_SCENARIO_TITLES,
  );
  const totalScenarios = summary.counts?.total ?? scenarios.length;
  const passedScenarios =
    summary.counts?.passed ?? scenarios.filter((scenario) => scenario.status === "pass").length;
  const failedScenarios =
    summary.counts?.failed ?? scenarios.filter((scenario) => scenario.status === "fail").length;
  const unintendedStopCount = scenarios.filter(
    (scenario) =>
      scenario.status !== "pass" && scenarioHasPattern(scenario, UNINTENDED_STOP_PATTERNS),
  ).length;
  const fakeSuccessCount = scenarios.filter((scenario) => {
    if (scenario.status !== "pass") {
      return false;
    }
    // Failure-tone patterns catch obviously-broken passes regardless of
    // whether the scenario shows tool-call evidence — "timed out" under a
    // pass is always fake.
    if (scenarioHasPattern(scenario, SUSPICIOUS_PASS_FAILURE_TONE_PATTERNS)) {
      return true;
    }
    // Positive-tone patterns (like "Successfully completed") are NOT checked
    // here because for passing runs the `details` field is the model's
    // outbound prose, which never contains tool-call evidence strings.
    // The `scenarioLacksToolCallEvidence` check would return true for ALL
    // passes and false-positive on legitimate completions. Criterion 2
    // ("no fake tool completion") is instead enforced by the per-scenario
    // `/debug/requests` tool-call assertions from the scenario YAML flows.
    return false;
  }).length;

  // Count only the scenarios that are supposed to exercise a real tool,
  // subagent, or capability invocation. Memory recall and image-only
  // understanding lanes stay in the parity pack, but they should not inflate
  // the tool-call metric just by passing.
  const toolBackedScenarioCount = scenarios.filter((scenario) =>
    toolBackedTitleSet.has(scenario.name),
  ).length;
  const validToolCallCount = scenarios.filter(
    (scenario) => toolBackedTitleSet.has(scenario.name) && scenario.status === "pass",
  ).length;

  const rate = (value: number) => (totalScenarios > 0 ? value / totalScenarios : 0);
  const toolRate = (value: number) =>
    toolBackedScenarioCount > 0 ? value / toolBackedScenarioCount : 0;
  return {
    totalScenarios,
    passedScenarios,
    failedScenarios,
    completionRate: rate(passedScenarios),
    unintendedStopCount,
    unintendedStopRate: rate(unintendedStopCount),
    validToolCallCount,
    validToolCallRate: toolRate(validToolCallCount),
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
  // The parity verdict must only consider the declared parity scenarios
  // (the full first-wave + second-wave pack from QA_AGENTIC_PARITY_SCENARIOS).
  // Drop `counts` so the metric helper recomputes totals from the filtered
  // scenario list instead of inheriting the caller's full-suite counters.
  return {
    scenarios: summary.scenarios.filter((scenario) => parityTitleSet.has(scenario.name)),
    ...(summary.run ? { run: summary.run } : {}),
  };
}

type StructuredQaParityLabel = {
  provider: string;
  model: string;
};

/**
 * Only treat caller labels as provenance-checked identifiers when they are
 * exact lower-case provider/model refs. Human-facing display labels like
 * "GPT-5.5 candidate" or "Candidate: GPT-5.5" should render in the report
 * without being misread as structured provider ids.
 */
function parseStructuredLabelRef(label: string): StructuredQaParityLabel | null {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed !== trimmed.toLowerCase()) {
    return null;
  }
  const separatorMatch = /^([a-z0-9][a-z0-9-]*)[/:]([a-z0-9][a-z0-9._-]*)$/.exec(trimmed);
  if (!separatorMatch) {
    return null;
  }
  return {
    provider: separatorMatch[1] ?? "",
    model: separatorMatch[2] ?? "",
  };
}

/**
 * Verify the `run.primaryProvider` + `run.primaryModel` fields on a summary
 * match the caller-supplied label when that label is a structured
 * `provider/model` or `provider:model` ref. PR L #64789 ships the `run`
 * block; before it lands, older summaries don't have the field and this check
 * is a no-op.
 *
 * Throws `QaParityLabelMismatchError` when the summary reports a different
 * provider/model than the caller claimed — this catches the "swapped
 * candidate and baseline summary paths" footgun the earlier adversarial
 * review flagged. Returns silently when the fields are absent (legacy
 * summaries) or when the fields match.
 */
function verifySummaryLabelMatch(params: {
  summary: QaParitySuiteSummary;
  label: string;
  role: "candidate" | "baseline";
}): void {
  const runProvider = params.summary.run?.primaryProvider?.trim();
  const runModel = params.summary.run?.primaryModel?.trim();
  const runModelName = params.summary.run?.primaryModelName?.trim();
  if (!runProvider || !runModel) {
    return;
  }
  const labelRef = parseStructuredLabelRef(params.label);
  if (!labelRef) {
    return;
  }
  const normalizedRunModel = runModel.toLowerCase();
  const normalizedRunModelName = runModelName?.toLowerCase();
  const normalizedLabelModel = labelRef.model;
  if (
    runProvider.toLowerCase() === labelRef.provider &&
    (normalizedRunModel === normalizedLabelModel ||
      normalizedRunModelName === normalizedLabelModel ||
      normalizedRunModel === `${labelRef.provider}/${normalizedLabelModel}`)
  ) {
    return;
  }
  throw new QaParityLabelMismatchError({
    role: params.role,
    label: params.label,
    runProvider,
    runModel,
  });
}

export class QaParityLabelMismatchError extends Error {
  readonly role: "candidate" | "baseline";
  readonly label: string;
  readonly runProvider: string;
  readonly runModel: string;

  constructor(params: {
    role: "candidate" | "baseline";
    label: string;
    runProvider: string;
    runModel: string;
  }) {
    super(
      `${params.role} summary run.primaryProvider=${params.runProvider} and run.primaryModel=${params.runModel} do not match --${params.role}-label=${params.label}. ` +
        `Check that the --candidate-summary / --baseline-summary paths weren't swapped.`,
    );
    this.name = "QaParityLabelMismatchError";
    this.role = params.role;
    this.label = params.label;
    this.runProvider = params.runProvider;
    this.runModel = params.runModel;
  }
}

export function buildQaAgenticParityComparison(params: {
  candidateLabel: string;
  baselineLabel: string;
  candidateSummary: QaParitySuiteSummary;
  baselineSummary: QaParitySuiteSummary;
  comparedAt?: string;
}): QaAgenticParityComparison {
  // Precondition: verify the `run.primaryProvider` field on each summary
  // matches the caller-supplied label (when the `run` block is present).
  // Throws `QaParityLabelMismatchError` on mismatch so the release gate
  // fails loudly instead of silently producing a reversed verdict when an
  // operator swaps the --candidate-summary and --baseline-summary paths.
  // Legacy summaries without a `run` block are accepted as-is.
  verifySummaryLabelMatch({
    summary: params.candidateSummary,
    label: params.candidateLabel,
    role: "candidate",
  });
  verifySummaryLabelMatch({
    summary: params.baselineSummary,
    label: params.baselineLabel,
    role: "baseline",
  });
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
      const candidateStatus = candidate ? normalizeScenarioStatus(candidate.status) : "missing";
      const baselineStatus = baseline ? normalizeScenarioStatus(baseline.status) : "missing";
      const comparison: QaAgenticParityScenarioComparison = {
        name,
        candidateStatus,
        baselineStatus,
      };
      if (candidate?.details) {
        comparison.candidateDetails = candidate.details;
      }
      if (baseline?.details) {
        comparison.baselineDetails = baseline.details;
      }
      return comparison;
    });

  const failures: string[] = [];
  const requiredScenarioStatuses = QA_AGENTIC_PARITY_SCENARIO_TITLES.map((name) => {
    const candidate = candidateByName.get(name);
    const baseline = baselineByName.get(name);
    return {
      name,
      candidateStatus: requiredCoverageStatus(candidate),
      baselineStatus: requiredCoverageStatus(baseline),
    };
  });
  const requiredScenarioCoverage = requiredScenarioStatuses.filter(
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
  // Required parity scenarios that ran on both sides but FAILED also fail
  // the gate. Without this check, a run where both models fail the same
  // required scenarios still produced pass=true, because the downstream
  // metric comparisons are purely relative (candidate vs baseline) and
  // the suspicious-pass fake-success check only catches passes that carry
  // failure-sounding details. Excluding missing/skip here keeps operator
  // output from double-counting the same scenario with two lines.
  const requiredScenarioFailures = requiredScenarioStatuses.filter(
    (scenario) =>
      scenario.candidateStatus !== "missing" &&
      scenario.baselineStatus !== "missing" &&
      scenario.candidateStatus !== "skip" &&
      scenario.baselineStatus !== "skip" &&
      (scenario.candidateStatus === "fail" || scenario.baselineStatus === "fail"),
  );
  for (const scenario of requiredScenarioFailures) {
    failures.push(
      `Required parity scenario ${scenario.name} failed: ${params.candidateLabel}=${scenario.candidateStatus}, ${params.baselineLabel}=${scenario.baselineStatus}.`,
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
  // Title is parametrized from the candidate / baseline labels so reports
  // for any candidate/baseline pair (not only gpt-5.5 vs opus 4.6) render
  // with an accurate header. The default CLI labels are still
  // openai/gpt-5.5 vs anthropic/claude-opus-4-6, but the helper works for
  // any parity comparison a caller configures.
  const lines = [
    `# OpenClaw Agentic Parity Report — ${comparison.candidateLabel} vs ${comparison.baselineLabel}`,
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
