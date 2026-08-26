import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { assertQaSuiteArtifactWritten } from "./artifact-assertion.js";
import { toRepoRelativePath } from "./cli-paths.js";
import {
  buildPlaywrightEvidenceSummary,
  buildScriptEvidenceSummary,
  buildVitestEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
  resolveQaEvidenceProfile,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { sanitizeQaProgressValue } from "./progress-format.js";
import type { QaProviderMode } from "./providers/index.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import { shellQuote } from "./shell-quote.js";
import {
  runQaScenarioCommandLifecycle,
  type QaScenarioCommandExecution,
  type QaScenarioCommandResult,
} from "./test-file-scenario-command-lifecycle.js";
import { isDockerE2eScenario, runDockerE2eBatch } from "./test-file-scenario-docker-batch.js";
import { readScriptProducerEvidence } from "./test-file-scenario-script-evidence.js";
import {
  readNativeVitestExecutionFailure,
  resolveNativeVitestReportPath,
} from "./test-file-scenario-vitest-report.js";
export type { QaScenarioCommandExecution } from "./test-file-scenario-command-lifecycle.js";

export type QaTestFileScenario = QaSeedScenarioWithSource & {
  execution: Extract<
    QaSeedScenarioWithSource["execution"],
    { kind: "script" | "vitest" | "playwright" }
  >;
};

export type QaTestFileExecutionKind = "script" | "vitest" | "playwright";

type QaTestFileScenarioRunParams = {
  commandTimeoutMs?: number;
  evidenceMode?: QaScorecardEvidenceMode;
  env?: NodeJS.ProcessEnv;
  envMode?: "replace";
  failFast?: boolean;
  onCommandOutput?: QaScenarioCommandExecution["onOutput"];
  outputDir: string;
  primaryModel: string;
  progress?: (message: string) => void;
  providerMode: QaProviderMode;
  repoRoot: string;
  runCommand?: QaScenarioCommandRunner;
  scenarios: readonly QaSeedScenarioWithSource[];
  writeEvidenceFile?: boolean;
};

type QaScenarioCommandRunner = (
  command: QaScenarioCommandExecution,
) => Promise<QaScenarioCommandResult>;

type QaScenarioCommandStep = {
  args: string[];
  command: string;
};

type QaTestFileScenarioResult = {
  durationMs: number;
  failureMessage?: string;
  includeFallbackEvidence?: boolean;
  logPath: string;
  producerEvidence?: QaEvidenceSummaryJson;
  scenario: QaTestFileScenario;
  status: QaEvidenceStatus;
};

type QaTestFileExecutionUnit =
  | {
      kind: "docker-batch";
      order: number;
      scenarios: Parameters<typeof runDockerE2eBatch>[0]["scenarios"];
      timeoutMs: number;
    }
  | {
      kind: "scenario";
      order: number;
      scenario: QaTestFileScenario;
      timeoutMs: number;
    };

export type QaTestFileScenarioRunResult = {
  evidence: QaEvidenceSummaryJson;
  evidencePath: string;
  executionKind: QaTestFileExecutionKind;
  outputDir: string;
  results: QaTestFileScenarioResult[];
};

type QaTestFileRunnerDefinition = {
  buildEvidenceSummary: typeof buildVitestEvidenceSummary;
  buildSteps(scenario: QaTestFileScenario, context: { outputDir: string }): QaScenarioCommandStep[];
};

const DEFAULT_QA_TEST_FILE_COMMAND_TIMEOUT_MS = 30 * 60_000;
export function isQaTestFileScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is QaTestFileScenario {
  return (
    scenario.execution.kind === "vitest" ||
    scenario.execution.kind === "playwright" ||
    scenario.execution.kind === "script"
  );
}

function vitestReporterArgs(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): string[] {
  return [
    "--reporter=verbose",
    "--reporter=json",
    `--outputFile.json=${resolveNativeVitestReportPath(scenario, context.outputDir)}`,
  ];
}

function vitestSteps(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): QaScenarioCommandStep[] {
  const e2eConfigArgs = scenario.execution.path.endsWith(".e2e.test.ts")
    ? ["run", "--config", "test/vitest/vitest.e2e.config.ts"]
    : [];
  return [
    {
      command: process.execPath,
      args: [
        "scripts/run-vitest.mjs",
        ...e2eConfigArgs,
        scenario.execution.path,
        ...vitestReporterArgs(scenario, context),
      ],
    },
  ];
}

function playwrightSteps(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): QaScenarioCommandStep[] {
  const testNamePattern =
    scenario.execution.kind === "playwright" ? scenario.execution.testNamePattern : undefined;
  const testNameArgs = testNamePattern ? ["--testNamePattern", testNamePattern] : [];
  return [
    {
      command: process.execPath,
      args: ["--import", "tsx", "scripts/ensure-playwright-chromium.mts"],
    },
    {
      command: process.execPath,
      args: [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.ui-e2e.config.ts",
        "--configLoader",
        "runner",
        scenario.execution.path,
        ...vitestReporterArgs(scenario, context),
        ...testNameArgs,
      ],
    },
  ];
}

function replaceScriptArgTokens(
  args: readonly string[] | undefined,
  context: { outputDir: string; scenarioId: string },
) {
  return (args ?? []).map((arg) =>
    arg
      .replaceAll("${outputDir}", context.outputDir)
      .replaceAll("${scenarioId}", context.scenarioId),
  );
}

function scriptSteps(
  scenario: QaTestFileScenario,
  context: { outputDir: string },
): QaScenarioCommandStep[] {
  const scenarioOutputDir = path.join(context.outputDir, scenario.id);
  const scriptArgs =
    scenario.execution.kind === "script"
      ? replaceScriptArgTokens(scenario.execution.args, {
          outputDir: scenarioOutputDir,
          scenarioId: scenario.id,
        })
      : [];
  return [
    {
      command: process.execPath,
      args: ["--import", "tsx", scenario.execution.path, ...scriptArgs],
    },
  ];
}

const testFileRunnerDefinitions: Record<QaTestFileExecutionKind, QaTestFileRunnerDefinition> = {
  script: {
    buildEvidenceSummary: buildScriptEvidenceSummary,
    buildSteps: scriptSteps,
  },
  vitest: {
    buildEvidenceSummary: buildVitestEvidenceSummary,
    buildSteps: vitestSteps,
  },
  playwright: {
    buildEvidenceSummary: buildPlaywrightEvidenceSummary,
    buildSteps: playwrightSteps,
  },
};

function formatCommand(step: QaScenarioCommandStep) {
  return [step.command, ...step.args].map(shellQuote).join(" ");
}

function buildScenarioEvidenceTarget(scenario: QaTestFileScenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    sourcePath: scenario.execution.path,
    primaryCoverageIds: scenario.coverage?.primary ?? [],
    secondaryCoverageIds: scenario.coverage?.secondary ?? [],
    docsRefs: scenario.docsRefs,
    codeRefs: scenario.codeRefs,
  };
}

function coverageForScenario(scenario: QaTestFileScenario) {
  return [
    ...(scenario.coverage?.primary ?? []).map((id) => ({ id, role: "primary" as const })),
    ...(scenario.coverage?.secondary ?? []).map((id) => ({ id, role: "secondary" as const })),
  ];
}

function withScenarioCoverage(
  entry: QaEvidenceSummaryJson["entries"][number],
  scenario: QaTestFileScenario,
) {
  return { ...entry, coverage: coverageForScenario(scenario) };
}

async function runScenarioCommandSteps(params: {
  commandTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  onCommandOutput?: QaScenarioCommandExecution["onOutput"];
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaTestFileScenario;
  steps: readonly QaScenarioCommandStep[];
}): Promise<QaTestFileScenarioResult> {
  const startedAt = Date.now();
  const logPath = path.join(params.outputDir, `${params.scenario.id}.log`);
  const logChunks: string[] = [];
  let failureMessage: string | undefined;
  for (const step of params.steps) {
    logChunks.push(`$ ${formatCommand(step)}\n`);
    try {
      const isNativeVitestStep =
        params.scenario.execution.kind !== "script" && step.args[0] === "scripts/run-vitest.mjs";
      if (isNativeVitestStep) {
        // A reused scenario output directory must not let a previous run's
        // passing report authenticate a child that emitted no report.
        await fs.rm(resolveNativeVitestReportPath(params.scenario, params.outputDir), {
          force: true,
        });
      }
      const timeoutMs =
        params.scenario.execution.kind === "script"
          ? (params.scenario.execution.timeoutMs ?? params.commandTimeoutMs)
          : params.commandTimeoutMs;
      const result = await params.runCommand({
        command: step.command,
        args: step.args,
        cwd: params.repoRoot,
        env: params.env,
        ...(params.scenario.execution.kind === "script" && params.onCommandOutput
          ? { onOutput: params.onCommandOutput }
          : {}),
        timeoutMs,
      });
      if (result.stdout) {
        logChunks.push(result.stdout);
      }
      if (result.stderr) {
        logChunks.push(result.stderr);
      }
      if (result.failureMessage || result.exitCode !== 0 || result.signal) {
        failureMessage =
          result.failureMessage ??
          (result.signal
            ? `${path.basename(step.command)} terminated by ${result.signal}`
            : `${path.basename(step.command)} exited with ${result.exitCode}`);
        break;
      }
      // Chromium installation and script producers do not execute Vitest tests.
      // Only the final native test command can prove an assertion actually ran.
      if (isNativeVitestStep) {
        failureMessage = await readNativeVitestExecutionFailure(params);
        if (failureMessage) {
          logChunks.push(`${failureMessage}\n`);
          break;
        }
      }
    } catch (error) {
      failureMessage = formatErrorMessage(error);
      logChunks.push(`${failureMessage}\n`);
      break;
    }
    logChunks.push("\n");
  }
  await fs.writeFile(logPath, logChunks.join(""), "utf8");
  const durationMs = Math.max(1, Date.now() - startedAt);
  return {
    scenario: params.scenario,
    status: failureMessage ? "fail" : "pass",
    durationMs,
    logPath,
    ...(failureMessage ? { failureMessage } : {}),
  };
}

async function runQaTestFileScenario(params: {
  env: NodeJS.ProcessEnv;
  commandTimeoutMs: number;
  onCommandOutput?: QaScenarioCommandExecution["onOutput"];
  outputDir: string;
  repoRoot: string;
  runCommand: QaScenarioCommandRunner;
  scenario: QaTestFileScenario;
}) {
  const requiresProducerEvidence =
    params.scenario.execution.kind === "script" && !isDockerE2eScenario(params.scenario);
  if (requiresProducerEvidence) {
    const scenarioOutputDir = path.join(params.outputDir, params.scenario.id);
    // The whole producer artifact root belongs to one command invocation. Clear
    // it so neither a stale index nor a stale bundle can authenticate a no-op.
    await fs.rm(scenarioOutputDir, { force: true, recursive: true });
    await fs.mkdir(scenarioOutputDir, { recursive: true });
  }
  const definition = testFileRunnerDefinitions[params.scenario.execution.kind];
  const result = await runScenarioCommandSteps({
    ...params,
    steps: definition.buildSteps(params.scenario, { outputDir: params.outputDir }),
  });
  if (params.scenario.execution.kind !== "script") {
    return result;
  }
  let producerEvidenceResult: Pick<QaTestFileScenarioResult, "producerEvidence">;
  try {
    producerEvidenceResult = await readScriptProducerEvidence({
      outputDir: params.outputDir,
      repoRoot: params.repoRoot,
      scenario: params.scenario,
      requireCurrentRunEvidence: requiresProducerEvidence,
    });
  } catch (error) {
    if (result.status !== "pass") {
      return result;
    }
    return {
      ...result,
      failureMessage: `Script producer evidence is invalid: ${formatErrorMessage(error)}`,
      status: "fail" as const,
    };
  }
  if (!producerEvidenceResult.producerEvidence) {
    if (requiresProducerEvidence && result.status === "pass") {
      return {
        ...result,
        failureMessage: "Script exited successfully without writing fresh producer QA evidence.",
        status: "fail" as const,
      };
    }
    return result;
  }
  if (result.status !== "pass") {
    return {
      ...result,
      ...producerEvidenceResult,
      includeFallbackEvidence: true,
    };
  }
  return {
    ...result,
    ...producerEvidenceResult,
    ...statusFromProducerEvidence({
      allowBlockedEvidence: params.scenario.execution.allowBlockedEvidence === true,
      producerEvidence: producerEvidenceResult.producerEvidence,
    }),
  };
}

function resolveScenarioTimeoutMs(scenario: QaTestFileScenario, commandTimeoutMs: number) {
  return scenario.execution.kind === "script"
    ? resolvePositiveTimerTimeoutMs(scenario.execution.timeoutMs, commandTimeoutMs)
    : commandTimeoutMs;
}

function buildExecutionUnits(params: {
  commandTimeoutMs: number;
  failFast: boolean;
  scenarios: readonly QaTestFileScenario[];
}): QaTestFileExecutionUnit[] {
  const scenarioOrder = new Map(params.scenarios.map((scenario, index) => [scenario, index]));
  const dockerBatchScenarios =
    !params.failFast && params.scenarios[0]?.execution.kind === "script"
      ? params.scenarios.filter(isDockerE2eScenario)
      : [];
  const dockerBatchGroups = new Map<number, typeof dockerBatchScenarios>();
  for (const scenario of dockerBatchScenarios) {
    const timeoutMs = resolveScenarioTimeoutMs(scenario, params.commandTimeoutMs);
    const group = dockerBatchGroups.get(timeoutMs) ?? [];
    group.push(scenario);
    dockerBatchGroups.set(timeoutMs, group);
  }
  const batchedScenarioIds = new Set(dockerBatchScenarios.map((scenario) => scenario.id));
  const units: QaTestFileExecutionUnit[] = [
    ...[...dockerBatchGroups].map(([timeoutMs, scenarios]) => ({
      kind: "docker-batch" as const,
      order: Math.min(...scenarios.map((scenario) => scenarioOrder.get(scenario) ?? 0)),
      scenarios,
      timeoutMs,
    })),
    ...params.scenarios
      .filter((scenario) => !batchedScenarioIds.has(scenario.id))
      .map((scenario) => ({
        kind: "scenario" as const,
        order: scenarioOrder.get(scenario) ?? 0,
        scenario,
        timeoutMs: resolveScenarioTimeoutMs(scenario, params.commandTimeoutMs),
      })),
  ];
  if (!params.failFast && params.scenarios[0]?.execution.kind === "script") {
    // Native producers stay serial because they may rebuild shared dist output.
    // Longest declared budgets run first so one late producer cannot starve at the suite deadline.
    units.sort((left, right) => right.timeoutMs - left.timeoutMs || left.order - right.order);
  } else {
    units.sort((left, right) => left.order - right.order);
  }
  return units;
}

function statusFromProducerEvidence(params: {
  allowBlockedEvidence: boolean;
  producerEvidence: QaEvidenceSummaryJson | undefined;
}): Pick<QaTestFileScenarioResult, "failureMessage" | "status"> {
  const { allowBlockedEvidence, producerEvidence } = params;
  if (!producerEvidence || producerEvidence.entries.length === 0) {
    return {
      failureMessage: "Script exited successfully without reporting an executed producer check.",
      status: "fail",
    };
  }
  const failedEntry = producerEvidence.entries.find((entry) => entry.result.status === "fail");
  const blockedEntry = producerEvidence.entries.find((entry) => entry.result.status === "blocked");
  if (failedEntry) {
    return {
      failureMessage:
        failedEntry.result.failure?.reason ?? `${failedEntry.test.id} reported failed`,
      status: "fail",
    };
  }
  const hasPassed = producerEvidence.entries.some((entry) => entry.result.status === "pass");
  if (blockedEntry && (!allowBlockedEvidence || !hasPassed)) {
    return {
      failureMessage:
        blockedEntry.result.failure?.reason ?? `${blockedEntry.test.id} reported blocked`,
      status: "blocked",
    };
  }
  if (producerEvidence.entries.some((entry) => entry.result.status === "skipped")) {
    return { status: "skipped" };
  }
  return { status: "pass" };
}

function resolveTestFileExecutionKind(scenarios: readonly QaTestFileScenario[]) {
  const kinds = new Set(scenarios.map((scenario) => scenario.execution.kind));
  if (kinds.size > 1) {
    throw new Error(
      "qa suite cannot mix script, Vitest, and Playwright scenarios in one invocation.",
    );
  }
  const [kind] = kinds;
  return kind;
}

function buildTestFileEvidence(params: {
  artifactPaths: { kind: string; path: string }[];
  generatedAt: string;
  kind: QaTestFileExecutionKind;
  primaryModel: string;
  providerMode: QaProviderMode;
  repoRoot: string;
  results: readonly QaTestFileScenarioResult[];
  evidenceMode?: QaScorecardEvidenceMode;
  env?: NodeJS.ProcessEnv;
}) {
  const producerEntries = params.results.flatMap((result) =>
    // Producer artifacts own execution facts; the scenario catalog remains the
    // sole owner of which semantic features those facts cover.
    (result.producerEvidence?.entries ?? []).map((entry) =>
      withScenarioCoverage(entry, result.scenario),
    ),
  );
  if (producerEntries.length > 0) {
    const definition = testFileRunnerDefinitions[params.kind];
    // Producer failures stay authoritative; parent terminal failures replace
    // colliding non-fail results without discarding producer execution facts.
    const producerEntryIds = new Set(producerEntries.map((entry) => entry.test.id));
    const fallbackResults = params.results.filter(
      (result) => !result.producerEvidence || result.includeFallbackEvidence,
    );
    const evidenceMode =
      params.evidenceMode ??
      (params.results.every((result) => result.producerEvidence?.evidenceMode === "slim")
        ? "slim"
        : "full");
    const fallbackEvidence =
      fallbackResults.length > 0
        ? definition.buildEvidenceSummary({
            artifactPaths: params.artifactPaths,
            evidenceMode,
            env: params.env,
            generatedAt: params.generatedAt,
            primaryModel: params.primaryModel,
            providerMode: params.providerMode,
            repoRoot: params.repoRoot,
            targets: fallbackResults.map((result) => buildScenarioEvidenceTarget(result.scenario)),
            results: fallbackResults.map((result) => ({
              id: result.scenario.id,
              status: result.status,
              durationMs: result.durationMs,
              failureMessage: result.failureMessage,
            })),
          })
        : undefined;
    return validateQaEvidenceSummaryJson({
      kind: QA_EVIDENCE_SUMMARY_KIND,
      schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
      generatedAt: params.generatedAt,
      evidenceMode,
      profile: resolveQaEvidenceProfile({ env: params.env }),
      entries: params.results.flatMap((result) => [
        ...(result.producerEvidence?.entries ?? []).map((entry) => {
          const coveredEntry = withScenarioCoverage(entry, result.scenario);
          const fallbackFailure = fallbackEvidence?.entries.find(
            (fallback) =>
              fallback.test.id === coveredEntry.test.id && fallback.result.status === "fail",
          );
          const resolvedEntry =
            coveredEntry.result.status !== "fail" && fallbackFailure
              ? Object.assign({}, coveredEntry, { result: fallbackFailure.result })
              : coveredEntry;
          if (evidenceMode !== "slim") {
            return resolvedEntry;
          }
          const { execution: _execution, ...withoutExecution } = resolvedEntry;
          return withoutExecution;
        }),
        ...(fallbackEvidence?.entries.filter(
          (entry) => entry.test.id === result.scenario.id && !producerEntryIds.has(entry.test.id),
        ) ?? []),
      ]),
    });
  }
  const definition = testFileRunnerDefinitions[params.kind];
  const evidence = definition.buildEvidenceSummary({
    artifactPaths: params.artifactPaths,
    evidenceMode: params.evidenceMode,
    env: params.env,
    generatedAt: params.generatedAt,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    repoRoot: params.repoRoot,
    targets: params.results.map((result) => buildScenarioEvidenceTarget(result.scenario)),
    results: params.results.map((result) => ({
      id: result.scenario.id,
      status: result.status,
      durationMs: result.durationMs,
      failureMessage: result.failureMessage,
    })),
  });
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode: evidence.evidenceMode,
    profile: evidence.profile,
    entries: evidence.entries,
  });
}

function buildScenarioArtifactPaths(params: {
  repoRoot: string;
  results: readonly QaTestFileScenarioResult[];
}) {
  return params.results.map((result) => ({
    kind: "log",
    path: toRepoRelativePath(params.repoRoot, result.logPath),
  }));
}

async function writeTestFileEvidenceFile(params: {
  evidence: unknown;
  outputDir: string;
  writeEvidenceFile?: boolean;
}): Promise<Pick<QaTestFileScenarioRunResult, "evidencePath">> {
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  if (params.writeEvidenceFile ?? true) {
    await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence, null, 2)}\n`, "utf8");
    await assertQaSuiteArtifactWritten("evidence", evidencePath);
  } else {
    await fs.rm(evidencePath, { force: true });
  }
  return { evidencePath };
}

export async function runQaTestFileScenarios(
  params: QaTestFileScenarioRunParams,
): Promise<QaTestFileScenarioRunResult> {
  const scenarios = params.scenarios.filter(isQaTestFileScenario);
  const kind = resolveTestFileExecutionKind(scenarios);
  if (!kind) {
    throw new Error("qa suite found no script, Vitest, or Playwright scenarios to run.");
  }
  await fs.mkdir(params.outputDir, { recursive: true });
  const runCommand = params.runCommand ?? runQaScenarioCommandLifecycle;
  const commandTimeoutMs = resolvePositiveTimerTimeoutMs(
    params.commandTimeoutMs,
    DEFAULT_QA_TEST_FILE_COMMAND_TIMEOUT_MS,
  );
  const env = params.envMode === "replace" ? (params.env ?? {}) : { ...process.env, ...params.env };
  const results: QaTestFileScenarioResult[] = [];
  const executionUnits = buildExecutionUnits({
    commandTimeoutMs,
    failFast: params.failFast === true,
    scenarios,
  });
  for (const unit of executionUnits) {
    if (unit.kind === "docker-batch") {
      params.progress?.(
        `native docker-batch start scenarios=${unit.scenarios.length} timeoutMs=${unit.timeoutMs}`,
      );
      const startedAt = Date.now();
      const batchResults = await runDockerE2eBatch({
        commandTimeoutMs: unit.timeoutMs,
        env,
        onCommandOutput: params.onCommandOutput,
        outputDir: params.outputDir,
        repoRoot: params.repoRoot,
        runCommand,
        scenarios: unit.scenarios,
      });
      results.push(...batchResults);
      params.progress?.(
        `native docker-batch finish passed=${batchResults.filter((result) => result.status === "pass").length} failed=${batchResults.filter((result) => result.status !== "pass").length} durationMs=${Math.max(1, Date.now() - startedAt)}`,
      );
      continue;
    }
    const scenarioId = sanitizeQaProgressValue(unit.scenario.id);
    params.progress?.(`native ${kind} start scenario=${scenarioId} timeoutMs=${unit.timeoutMs}`);
    const result = await runQaTestFileScenario({
      env,
      commandTimeoutMs,
      onCommandOutput: params.onCommandOutput,
      outputDir: params.outputDir,
      repoRoot: params.repoRoot,
      runCommand,
      scenario: unit.scenario,
    });
    results.push(result);
    params.progress?.(
      `native ${kind} finish scenario=${scenarioId} status=${result.status} durationMs=${result.durationMs}`,
    );
    if (params.failFast && result.status !== "pass") {
      break;
    }
  }
  const scenarioOrder = new Map(scenarios.map((scenario, index) => [scenario, index]));
  results.sort(
    (left, right) =>
      (scenarioOrder.get(left.scenario) ?? 0) - (scenarioOrder.get(right.scenario) ?? 0),
  );
  const generatedAt = new Date().toISOString();
  const artifactPaths = buildScenarioArtifactPaths({
    repoRoot: params.repoRoot,
    results,
  });
  const evidence = buildTestFileEvidence({
    artifactPaths,
    evidenceMode: params.evidenceMode,
    env,
    generatedAt,
    kind,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    repoRoot: params.repoRoot,
    results,
  });
  const paths = await writeTestFileEvidenceFile({
    evidence,
    outputDir: params.outputDir,
    writeEvidenceFile: params.writeEvidenceFile,
  });
  return {
    ...paths,
    evidence,
    executionKind: kind,
    outputDir: params.outputDir,
    results,
  };
}
