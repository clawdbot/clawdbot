// Qa Lab plugin module implements tool coverage report behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isRuntimeParityCellPassable,
  type RuntimeId,
  type RuntimeParityCell,
  type RuntimeParityDrift,
  type RuntimeParityResult,
} from "./runtime-parity.js";
import {
  readRuntimeToolCoverageConfig,
  readScenarioRuntimeToolCoverageMetadata,
  type QaRuntimeCapabilityLayer,
  type QaRuntimeToolBucket,
  type QaRuntimeToolExpectedLayer,
} from "./runtime-tool-metadata.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaToolCoverageSuiteScenario = {
  name: string;
  status: "pass" | "fail";
  runtimeParity?: RuntimeParityResult;
};

export type QaToolCoverageSuiteSummary = {
  scenarios: QaToolCoverageSuiteScenario[];
  run?: {
    runtimePair?: [RuntimeId, RuntimeId] | null;
  };
};

export type QaToolCoverageStatus = "pass" | "fail" | "missing" | "not-run";
export type QaToolCoverageDrift = RuntimeParityDrift | "not-run";
export type QaToolCoverageBucket = QaRuntimeToolBucket;

export type QaToolCoverageRow = {
  tool: string;
  runtimeToolName?: string;
  bucket: QaToolCoverageBucket;
  expectedLayer: QaRuntimeToolExpectedLayer;
  capabilityLayer: QaRuntimeCapabilityLayer;
  required: boolean;
  fixtureCount: number;
  scenarios: string[];
  sourcePaths: string[];
  openclaw: QaToolCoverageStatus;
  codex: QaToolCoverageStatus;
  drift: QaToolCoverageDrift;
  openclawToolCalls: number;
  codexToolCalls: number;
  tracking?: string;
  codexDefaultImpact?: string;
  qaImpact?: string;
  action?: string;
  details?: string;
};

export type QaToolCoverageReport = {
  runtimePair: [RuntimeId, RuntimeId];
  generatedAt: string;
  evaluated: boolean;
  totalTools: number;
  requiredTools: number;
  reportOnlyTools: number;
  trackedTools: number;
  nativeWorkspaceTools: number;
  dynamicIntegrationTools: number;
  searchableDynamicTools: number;
  optionalTools: number;
  passingTools: number;
  failingTools: number;
  rows: QaToolCoverageRow[];
  pass: boolean;
  failures: string[];
};

type ToolFixtureGroup = {
  tool: string;
  scenarios: QaSeedScenarioWithSource[];
};

const PASSING_DRIFTS: ReadonlySet<QaToolCoverageDrift> = new Set(["none", "text-only"]);

function normalizeRuntimePair(
  pair: [RuntimeId, RuntimeId] | null | undefined,
): [RuntimeId, RuntimeId] {
  if (pair?.[0] && pair?.[1]) {
    return pair;
  }
  return ["openclaw", "codex"];
}

function cellStatus(cell: RuntimeParityCell | undefined): QaToolCoverageStatus {
  if (!cell) {
    return "missing";
  }
  return isRuntimeParityCellPassable(cell) ? "pass" : "fail";
}

function toolIdsForScenario(scenario: QaSeedScenarioWithSource): string[] {
  const toolCoverage = readRuntimeToolCoverageConfig(scenario.execution.config);
  const family =
    readString(toolCoverage?.family) ??
    readString(toolCoverage?.tool) ??
    readString(toolCoverage?.actualTool) ??
    readString(scenario.execution.config?.toolName);
  return family ? [family] : [];
}

function groupToolFixtures(scenarios: readonly QaSeedScenarioWithSource[]): ToolFixtureGroup[] {
  const byTool = new Map<string, QaSeedScenarioWithSource[]>();
  for (const scenario of scenarios) {
    if (!scenario.sourcePath.startsWith("qa/scenarios/runtime/tools/")) {
      continue;
    }
    for (const tool of toolIdsForScenario(scenario)) {
      const entries = byTool.get(tool) ?? [];
      entries.push(scenario);
      byTool.set(tool, entries);
    }
  }
  return [...byTool.entries()]
    .map(([tool, groupedScenarios]) => ({
      tool,
      scenarios: groupedScenarios.toSorted((left, right) => left.id.localeCompare(right.id)),
    }))
    .toSorted((left, right) => left.tool.localeCompare(right.tool));
}

function readScenarioTracking(scenario: QaSeedScenarioWithSource): string | undefined {
  const metadata = readScenarioRuntimeToolCoverageMetadata(scenario);
  const config = scenario.execution.config;
  const knownBroken = isRecord(config?.knownBroken) ? config.knownBroken : undefined;
  const knownHarnessGap = isRecord(config?.knownHarnessGap) ? config.knownHarnessGap : undefined;
  const issue =
    metadata.tracking ?? readString(knownHarnessGap?.issue) ?? readString(knownBroken?.issue);
  const reason =
    metadata.reason ?? readString(knownHarnessGap?.reason) ?? readString(knownBroken?.reason);
  if (issue && reason) {
    return `${issue} ${reason}`;
  }
  return issue;
}

function readScenarioRuntimeToolName(scenario: QaSeedScenarioWithSource): string | undefined {
  const config = scenario.execution.config;
  const toolCoverage = isRecord(config?.toolCoverage) ? config.toolCoverage : undefined;
  return readString(toolCoverage?.actualTool) ?? readString(config?.toolName);
}

function summaryByScenarioId(
  summary: QaToolCoverageSuiteSummary | undefined,
): Map<string, RuntimeParityResult> {
  const byScenarioId = new Map<string, RuntimeParityResult>();
  for (const scenario of summary?.scenarios ?? []) {
    if (scenario.runtimeParity) {
      byScenarioId.set(scenario.runtimeParity.scenarioId, scenario.runtimeParity);
    }
  }
  return byScenarioId;
}

function mergeScenarioResults(
  scenarios: readonly QaSeedScenarioWithSource[],
  results: ReadonlyMap<string, RuntimeParityResult>,
) {
  const scenarioResults = scenarios
    .map((scenario) => results.get(scenario.id))
    .filter((result): result is RuntimeParityResult => Boolean(result));
  if (scenarioResults.length === 0) {
    return undefined;
  }
  const failingResult =
    scenarioResults.find((result) => !PASSING_DRIFTS.has(result.drift)) ?? scenarioResults[0];
  return failingResult;
}

function isPassingToolCoverageDrift(drift: QaToolCoverageDrift, evaluated: boolean) {
  return PASSING_DRIFTS.has(drift) || (!evaluated && drift === "not-run");
}

function countRuntimeToolCalls(
  result: RuntimeParityResult | undefined,
  runtime: RuntimeId,
  toolName: string | undefined,
) {
  if (!result || !toolName) {
    return 0;
  }
  const cell = runtime === "openclaw" ? result.cells.openclaw : result.cells.codex;
  return cell.toolCalls.filter((call) => call.tool === toolName).length;
}

function buildRow(params: {
  group: ToolFixtureGroup;
  results: ReadonlyMap<string, RuntimeParityResult>;
}): QaToolCoverageRow {
  const result = mergeScenarioResults(params.group.scenarios, params.results);
  const tracking = params.group.scenarios.map(readScenarioTracking).find(Boolean);
  const metadata = params.group.scenarios
    .map(readScenarioRuntimeToolCoverageMetadata)
    .find((entry) => entry.required);
  const firstScenario = expectDefined(
    params.group.scenarios[0],
    `QA tool fixture group ${params.group.tool} scenario`,
  );
  const fallbackMetadata = readScenarioRuntimeToolCoverageMetadata(firstScenario);
  const rowMetadata = metadata ?? fallbackMetadata;
  const runtimeToolName = params.group.scenarios.map(readScenarioRuntimeToolName).find(Boolean);
  return {
    tool: params.group.tool,
    ...(runtimeToolName ? { runtimeToolName } : {}),
    bucket: rowMetadata.bucket,
    expectedLayer: rowMetadata.expectedLayer,
    capabilityLayer: rowMetadata.capabilityLayer,
    required: rowMetadata.required,
    fixtureCount: params.group.scenarios.length,
    scenarios: params.group.scenarios.map((scenario) => scenario.id),
    sourcePaths: params.group.scenarios.map((scenario) => scenario.sourcePath),
    openclaw: result ? cellStatus(result.cells.openclaw) : "not-run",
    codex: result ? cellStatus(result.cells.codex) : "not-run",
    drift: result?.drift ?? "not-run",
    openclawToolCalls: countRuntimeToolCalls(result, "openclaw", runtimeToolName),
    codexToolCalls: countRuntimeToolCalls(result, "codex", runtimeToolName),
    ...(tracking ? { tracking } : {}),
    ...(rowMetadata.codexDefaultImpact
      ? { codexDefaultImpact: rowMetadata.codexDefaultImpact }
      : {}),
    ...(rowMetadata.qaImpact ? { qaImpact: rowMetadata.qaImpact } : {}),
    ...(rowMetadata.action ? { action: rowMetadata.action } : {}),
    ...(result?.driftDetails ? { details: result.driftDetails } : {}),
  };
}

function coverageFailureForRow(row: QaToolCoverageRow): string | undefined {
  if (!row.required || row.tracking) {
    return undefined;
  }
  if (row.drift === "not-run") {
    return `${row.tool} drift=not-run`;
  }
  if (row.openclaw !== "pass" || row.codex !== "pass") {
    return `${row.tool} status openclaw=${row.openclaw} codex=${row.codex}`;
  }
  if (row.drift === "failure-mode") {
    return `${row.tool} drift=failure-mode${row.details ? ` (${row.details})` : ""}`;
  }
  if (row.runtimeToolName && row.openclawToolCalls === 0) {
    return `${row.tool} missing openclaw tool call ${row.runtimeToolName}`;
  }
  if (row.runtimeToolName && row.codexToolCalls === 0) {
    return `${row.tool} missing codex tool call ${row.runtimeToolName}`;
  }
  return undefined;
}

export function buildQaToolCoverageReport(params: {
  scenarios: readonly QaSeedScenarioWithSource[];
  summary?: QaToolCoverageSuiteSummary;
  runtimePair?: [RuntimeId, RuntimeId];
  generatedAt?: string;
}): QaToolCoverageReport {
  const results = summaryByScenarioId(params.summary);
  const rows = groupToolFixtures(params.scenarios).map((group) =>
    buildRow({
      group,
      results,
    }),
  );
  const evaluated = Boolean(params.summary);
  const failures = evaluated
    ? rows.map(coverageFailureForRow).filter((failure): failure is string => Boolean(failure))
    : [];
  return {
    runtimePair: normalizeRuntimePair(params.runtimePair ?? params.summary?.run?.runtimePair),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    evaluated,
    totalTools: rows.length,
    requiredTools: rows.filter((row) => row.required).length,
    reportOnlyTools: rows.filter((row) => !row.required || Boolean(row.tracking)).length,
    trackedTools: rows.filter((row) => Boolean(row.tracking)).length,
    nativeWorkspaceTools: rows.filter((row) => row.bucket === "codex-native-workspace").length,
    dynamicIntegrationTools: rows.filter((row) => row.bucket === "openclaw-dynamic-integration")
      .length,
    searchableDynamicTools: rows.filter(
      (row) => row.capabilityLayer === "openclaw-dynamic-searchable",
    ).length,
    optionalTools: rows.filter((row) => row.bucket === "optional-profile-or-plugin").length,
    passingTools: evaluated
      ? rows.filter(
          (row) =>
            row.required &&
            !row.tracking &&
            row.openclaw === "pass" &&
            row.codex === "pass" &&
            (isPassingToolCoverageDrift(row.drift, true) || !coverageFailureForRow(row)),
        ).length
      : 0,
    failingTools: failures.length,
    rows,
    pass: failures.length === 0,
    failures,
  };
}

export function renderQaToolCoverageMarkdownReport(report: QaToolCoverageReport): string {
  const lines = [
    `# OpenClaw Runtime Tool Coverage — ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Mode: ${report.evaluated ? "runtime summary" : "catalog inventory"}`,
    `- Tools: ${report.totalTools}`,
    `- Required tools: ${report.requiredTools}`,
    `- Report-only tools: ${report.reportOnlyTools}`,
    `- Tracked issue rows: ${report.trackedTools}`,
    `- Codex-native workspace tools: ${report.nativeWorkspaceTools}`,
    `- OpenClaw dynamic integration tools: ${report.dynamicIntegrationTools}`,
    `- Searchable/deferred dynamic tools: ${report.searchableDynamicTools}`,
    `- Optional/profile/plugin-dependent tools: ${report.optionalTools}`,
    `- Passing tools: ${report.passingTools}`,
    `- Failing tools: ${report.failingTools}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    "",
    "| Tool | Bucket | Expected layer | Capability layer | Required | Fixtures | OpenClaw | Codex | Drift | Codex default impact | QA impact | Action | Tracking |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of report.rows) {
    const cells = [
      row.tool,
      row.bucket,
      row.expectedLayer,
      row.capabilityLayer,
      row.required ? "yes" : "no",
      row.fixtureCount.toString(),
      row.openclaw,
      row.codex,
      row.drift,
      row.codexDefaultImpact ?? "",
      row.qaImpact ?? "",
      row.action ?? "",
      row.tracking ?? "",
    ].map(escapeTableCell);
    lines.push(`| ${cells.join(" | ")} |`);
  }

  if (report.failures.length > 0) {
    lines.push("", "## Gate Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }

  lines.push("", "## Fixture Sources", "");
  for (const row of report.rows) {
    lines.push(`- ${row.tool}: ${row.scenarios.join(", ")}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}
