#!/usr/bin/env node

// Validates runtime-pair evidence emitted by a frozen release candidate.
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";

const RUNTIME_IDS = ["openclaw", "codex"];
const HARD_RUNTIME_ERROR_CLASSES = new Set([
  "missing-api-key",
  "failover",
  "codex-app-server",
  "auth",
  "capture-missing",
]);
const EXPLICIT_CODEX_GAP_PREFIXES = ["known-harness-gap ", "codex-native-workspace "];
const FROZEN_CORE_RUNTIME_PAIR_MANIFEST = {
  scenarioIds: [
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
  ],
  gapScenarioIds: [
    "runtime-tool-apply-patch",
    "runtime-tool-bash",
    "runtime-tool-edit",
    "runtime-tool-exec",
    "runtime-tool-fs-list",
    "runtime-tool-fs-read",
    "runtime-tool-fs-write",
    "runtime-tool-grep",
  ],
};
const FROZEN_RUNTIME_PAIR_MANIFESTS = new Map([
  ["311047822ecdde24e824d839ab105ef08f17be00:core", FROZEN_CORE_RUNTIME_PAIR_MANIFEST],
  ["c37af96b18776fecc9e24268f27fc89b563481bf:core", FROZEN_CORE_RUNTIME_PAIR_MANIFEST],
]);

function isPassableCell(cell) {
  if (!isRecord(cell) || typeof cell.transportErrorClass === "string") {
    return false;
  }
  const runtimeErrorClass = cell.runtimeErrorClass;
  if (
    typeof runtimeErrorClass === "string" &&
    (HARD_RUNTIME_ERROR_CLASSES.has(runtimeErrorClass) || runtimeErrorClass.startsWith("sentinel:"))
  ) {
    return false;
  }
  if (runtimeErrorClass !== undefined && runtimeErrorClass !== "tool-error") {
    return false;
  }
  return (
    Array.isArray(cell.toolCalls) &&
    !cell.toolCalls.some(
      (toolCall) => isRecord(toolCall) && toolCall.errorClass === "tool-result-missing",
    )
  );
}

function isExplicitCodexGap(cell) {
  if (!isRecord(cell) || cell.status !== "skip" || typeof cell.details !== "string") {
    return false;
  }
  const details = cell.details.trimStart();
  return EXPLICIT_CODEX_GAP_PREFIXES.some((prefix) => details.startsWith(prefix));
}

function projectedReportCellStatus(cell) {
  // Frozen parity reports project runtime/transport health, while the raw
  // result cell separately preserves an approved scenario-level skip.
  return cell.runtimeErrorClass || cell.transportErrorClass ? "fail" : "pass";
}

function hasPassingRuntimeCellStatus(cell) {
  // Early frozen candidates did not serialize the derived cell status. Accept
  // only that absent legacy field when the same runtime evidence projects pass.
  return (
    cell.status === "pass" ||
    (!Object.hasOwn(cell, "status") && projectedReportCellStatus(cell) === "pass")
  );
}

function requireRuntimePairScenario(scenario, index) {
  if (!isRecord(scenario)) {
    throw new Error(`scenario ${index + 1} is not an object`);
  }
  const label = typeof scenario.name === "string" ? scenario.name : `scenario ${index + 1}`;
  const parity = scenario.runtimeParity;
  if (!isRecord(parity) || !isRecord(parity.cells)) {
    throw new Error(`${label} is missing runtimeParity cells`);
  }
  const openclaw = parity.cells.openclaw;
  const codex = parity.cells.codex;
  if (!isRecord(openclaw) || !isRecord(codex)) {
    throw new Error(`${label} is missing a canonical runtime cell`);
  }
  if (openclaw.runtime !== "openclaw" || codex.runtime !== "codex") {
    throw new Error(`${label} has mismatched canonical runtime cells`);
  }

  if (scenario.status === "pass") {
    const hasTwoPassingCells =
      hasPassingRuntimeCellStatus(openclaw) && hasPassingRuntimeCellStatus(codex);
    const hasAdvisoryCodexGap =
      parity.drift === "structural" &&
      hasPassingRuntimeCellStatus(openclaw) &&
      isExplicitCodexGap(codex);
    if (
      parity.drift === "failure-mode" ||
      (!hasTwoPassingCells && !hasAdvisoryCodexGap) ||
      !isPassableCell(openclaw) ||
      !isPassableCell(codex)
    ) {
      throw new Error(`${label} reports pass without two passing, passable runtime cells`);
    }
    return false;
  }

  // Older candidates emitted this explicit Codex-native limitation as a skip
  // before the trusted classifier learned to keep the paired result advisory.
  if (
    scenario.status === "skip" &&
    openclaw.status === "pass" &&
    codex.status === "skip" &&
    isExplicitCodexGap(codex) &&
    isPassableCell(openclaw) &&
    isPassableCell(codex)
  ) {
    return true;
  }

  throw new Error(`${label} contains a runtime-pair failure or unsupported skip`);
}

function requireCanonicalRuntimePair(runtimePair) {
  return (
    Array.isArray(runtimePair) &&
    runtimePair.length === RUNTIME_IDS.length &&
    runtimePair.every((runtime, index) => runtime === RUNTIME_IDS[index])
  );
}

export function validateQaRuntimePairSummary(summary, options = {}) {
  if (!isRecord(summary) || !isRecord(summary.run) || !Array.isArray(summary.scenarios)) {
    throw new Error("runtime-pair summary is missing run or scenario evidence");
  }
  if (!requireCanonicalRuntimePair(summary.run.runtimePair)) {
    throw new Error("runtime-pair summary must compare openclaw and codex in canonical order");
  }
  if (summary.scenarios.length === 0) {
    throw new Error("runtime-pair summary contains no scenarios");
  }
  const scenarioIds = summary.scenarios.map((scenario) => scenario?.runtimeParity?.scenarioId);
  if (
    !Array.isArray(summary.run.scenarioIds) ||
    summary.run.scenarioIds.length !== scenarioIds.length ||
    new Set(summary.run.scenarioIds).size !== summary.run.scenarioIds.length ||
    scenarioIds.some(
      (scenarioId, index) =>
        typeof scenarioId !== "string" || scenarioId !== summary.run.scenarioIds[index],
    )
  ) {
    throw new Error("runtime-pair results do not match the declared scenario manifest");
  }

  let passed = 0;
  let skipped = 0;
  const skippedScenarioIds = [];
  for (const [index, scenario] of summary.scenarios.entries()) {
    if (requireRuntimePairScenario(scenario, index)) {
      skipped += 1;
      skippedScenarioIds.push(scenarioIds[index]);
    } else {
      passed += 1;
    }
  }

  const expectedCounts = {
    total: summary.scenarios.length,
    passed,
    failed: 0,
    skipped,
  };
  if (
    !isRecord(summary.counts) ||
    Object.entries(expectedCounts).some(([key, value]) => summary.counts[key] !== value)
  ) {
    throw new Error("runtime-pair summary counts do not match validated scenario evidence");
  }
  if (options.requireExplicitGap === true && skipped === 0) {
    throw new Error("nonzero candidate suite exit requires an explicit Codex-native harness gap");
  }
  if (options.requireExplicitGap === true) {
    const manifest = FROZEN_RUNTIME_PAIR_MANIFESTS.get(`${options.targetSha}:${options.lane}`);
    if (
      !manifest ||
      manifest.scenarioIds.length !== scenarioIds.length ||
      manifest.scenarioIds.some((scenarioId, index) => scenarioId !== scenarioIds[index]) ||
      manifest.gapScenarioIds.length !== skippedScenarioIds.length ||
      manifest.gapScenarioIds.some((scenarioId, index) => scenarioId !== skippedScenarioIds[index])
    ) {
      throw new Error("nonzero candidate exit is not covered by a trusted frozen-lane manifest");
    }
  }
  return expectedCounts;
}

export function validateQaRuntimePairReport(summary, reportSummary, reportMarkdown, options = {}) {
  const counts = validateQaRuntimePairSummary(summary, options);
  if (
    !isRecord(reportSummary) ||
    !requireCanonicalRuntimePair(reportSummary.runtimePair) ||
    !Array.isArray(reportSummary.scenarios) ||
    !Array.isArray(reportSummary.failures) ||
    reportSummary.totalScenarios !== counts.total ||
    reportSummary.passedScenarios !== counts.passed ||
    reportSummary.failedScenarios !== counts.skipped ||
    reportSummary.scenarios.length !== counts.total ||
    reportSummary.failures.length !== counts.skipped
  ) {
    throw new Error("runtime-pair report summary does not match validated suite evidence");
  }
  const scenarioNames = summary.scenarios.map((scenario) => scenario.name);
  if (
    scenarioNames.some((name) => typeof name !== "string") ||
    reportSummary.scenarios.some((scenario, index) => {
      const source = summary.scenarios[index];
      const expectedStatus = source.status === "skip" ? "fail" : "pass";
      return (
        scenario?.name !== scenarioNames[index] ||
        scenario.status !== expectedStatus ||
        scenario.drift !== source.runtimeParity.drift ||
        scenario.driftDetails !== source.runtimeParity.driftDetails ||
        scenario.openclawStatus !==
          projectedReportCellStatus(source.runtimeParity.cells.openclaw) ||
        scenario.codexStatus !== projectedReportCellStatus(source.runtimeParity.cells.codex)
      );
    })
  ) {
    throw new Error("runtime-pair report scenarios do not match validated suite evidence");
  }
  const expectedFailures = summary.scenarios
    .filter((scenario) => scenario.status === "skip")
    .map(
      (scenario) =>
        `${scenario.name} drift=${scenario.runtimeParity.drift} (${scenario.runtimeParity.driftDetails}).`,
    );
  if (
    reportSummary.pass !== (counts.skipped === 0) ||
    reportSummary.failures.some((failure, index) => failure !== expectedFailures[index])
  ) {
    throw new Error("runtime-pair report failures do not match validated suite evidence");
  }
  if (
    typeof reportMarkdown !== "string" ||
    !reportMarkdown.startsWith("# OpenClaw Runtime Parity Report") ||
    !reportMarkdown.includes(`- Verdict: ${counts.skipped === 0 ? "pass" : "fail"}`) ||
    summary.scenarios.some((scenario) => {
      const heading = `\n### ${scenario.name}\n`;
      const start = reportMarkdown.indexOf(heading);
      if (start < 0) {
        return true;
      }
      const next = reportMarkdown.indexOf("\n### ", start + heading.length);
      const sectionLines = new Set(
        reportMarkdown.slice(start, next < 0 ? undefined : next).split("\n"),
      );
      const expectedStatus = scenario.status === "skip" ? "fail" : "pass";
      return (
        !sectionLines.has(`- status: ${expectedStatus}`) ||
        !sectionLines.has(`- drift: ${scenario.runtimeParity.drift}`) ||
        ![...sectionLines].some((line) =>
          line.startsWith(
            `- openclaw: ${projectedReportCellStatus(scenario.runtimeParity.cells.openclaw)} `,
          ),
        ) ||
        ![...sectionLines].some((line) =>
          line.startsWith(
            `- codex: ${projectedReportCellStatus(scenario.runtimeParity.cells.codex)} `,
          ),
        )
      );
    })
  ) {
    throw new Error("runtime-pair Markdown report is incomplete");
  }
  return counts;
}

export function parseArgs(argv) {
  let summaryPath;
  let reportSummaryPath;
  let reportMarkdownPath;
  let requireExplicitGap = false;
  let targetSha;
  let lane;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--summary") {
      summaryPath = argv[index + 1];
      if (!summaryPath || summaryPath.startsWith("-")) {
        throw new Error("--summary requires a path");
      }
      index += 1;
    } else if (arg === "--report-summary" || arg === "--report-markdown") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a path`);
      }
      if (arg === "--report-summary") {
        reportSummaryPath = value;
      } else {
        reportMarkdownPath = value;
      }
      index += 1;
    } else if (arg === "--require-explicit-gap") {
      requireExplicitGap = true;
    } else if (arg === "--target-sha" || arg === "--lane") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--target-sha") {
        targetSha = value;
      } else {
        lane = value;
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/validate-qa-runtime-pair-summary.mjs --summary <qa-suite-summary.json> [--require-explicit-gap] [--report-summary <json> --report-markdown <md>]\n",
      );
      return undefined;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!summaryPath) {
    throw new Error("--summary is required");
  }
  if (Boolean(reportSummaryPath) !== Boolean(reportMarkdownPath)) {
    throw new Error("--report-summary and --report-markdown must be provided together");
  }
  if (requireExplicitGap && (!targetSha || !lane)) {
    throw new Error("--require-explicit-gap requires --target-sha and --lane");
  }
  return {
    summaryPath,
    reportSummaryPath,
    reportMarkdownPath,
    requireExplicitGap,
    targetSha,
    lane,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }
  const summary = JSON.parse(fs.readFileSync(options.summaryPath, "utf8"));
  const counts = options.reportSummaryPath
    ? validateQaRuntimePairReport(
        summary,
        JSON.parse(fs.readFileSync(options.reportSummaryPath, "utf8")),
        fs.readFileSync(options.reportMarkdownPath, "utf8"),
        options,
      )
    : validateQaRuntimePairSummary(summary, options);
  process.stdout.write(
    `Validated ${counts.total} runtime-pair scenarios (${counts.passed} passed, ${counts.skipped} explicit Codex-native harness gaps).\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
