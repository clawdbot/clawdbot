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
import type { QaProviderMode } from "./providers/index.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import { shellQuote } from "./shell-quote.js";
import {
  killQaScenarioWindowsProcessTree,
  resetQaScenarioCommandCleanupTimings,
  runQaScenarioCommandLifecycle,
  setQaScenarioCommandCleanupTimings,
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
  failFast?: boolean;
  outputDir: string;
  primaryModel: string;
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
      args: ["scripts/ensure-playwright-chromium.mjs"],
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
  const blockingEntry = producerEvidence.entries.find(
    (entry) =>
      entry.result.status === "fail" ||
      (!allowBlockedEvidence && entry.result.status === "blocked"),
  );
  if (blockingEntry) {
    return {
      failureMessage:
        blockingEntry.result.failure?.reason ??
        `${blockingEntry.test.id} reported ${blockingEntry.result.status}`,
      status: blockingEntry.result.status,
    };
  }
  if (!producerEvidence.entries.some((entry) => entry.result.status === "pass")) {
    // Allowing blocked checks does not make an entirely unexecuted producer a successful run.
    const blockedEntry = producerEvidence.entries.find(
      (entry) => entry.result.status === "blocked",
    );
    if (blockedEntry) {
      return {
        failureMessage:
          blockedEntry.result.failure?.reason ?? `${blockedEntry.test.id} reported blocked`,
        status: "blocked",
      };
    }
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
    // Failed scripts still need generic fallback evidence unless their producer
    // already recorded that scenario identity at the authoritative boundary.
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
      entries: [
        ...producerEntries.map((entry) => {
          if (evidenceMode !== "slim") {
            return entry;
          }
          const { execution: _execution, ...withoutExecution } = entry;
          return withoutExecution;
        }),
        ...(fallbackEvidence?.entries.filter((entry) => !producerEntryIds.has(entry.test.id)) ??
          []),
      ],
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
  const env = {
    ...process.env,
    ...params.env,
  };
  const results: QaTestFileScenarioResult[] = [];
  const dockerBatchScenarios =
    kind === "script" && !params.failFast ? scenarios.filter(isDockerE2eScenario) : [];
  const dockerBatchGroups = new Map<number, typeof dockerBatchScenarios>();
  for (const scenario of dockerBatchScenarios) {
    const scenarioTimeoutMs = resolvePositiveTimerTimeoutMs(
      scenario.execution.timeoutMs,
      commandTimeoutMs,
    );
    const group = dockerBatchGroups.get(scenarioTimeoutMs) ?? [];
    group.push(scenario);
    dockerBatchGroups.set(scenarioTimeoutMs, group);
  }
  for (const [scenarioTimeoutMs, group] of dockerBatchGroups) {
    // A scheduler invocation shares one fallback lane timeout, so timeout overrides
    // stay in separate batches instead of borrowing another scenario's budget.
    results.push(
      ...(await runDockerE2eBatch({
        commandTimeoutMs: scenarioTimeoutMs,
        env,
        outputDir: params.outputDir,
        repoRoot: params.repoRoot,
        runCommand,
        scenarios: group,
      })),
    );
  }
  const dockerBatchScenarioIds = new Set(dockerBatchScenarios.map((scenario) => scenario.id));
  for (const scenario of scenarios) {
    if (dockerBatchScenarioIds.has(scenario.id)) {
      continue;
    }
    const result = await runQaTestFileScenario({
      env,
      commandTimeoutMs,
      outputDir: params.outputDir,
      repoRoot: params.repoRoot,
      runCommand,
      scenario,
    });
    results.push(result);
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

export const qaTestFileScenarioRunnerTesting = {
  killQaScenarioWindowsProcessTree,
  resetTimeoutCleanupTimings() {
    resetQaScenarioCommandCleanupTimings();
  },
  setTimeoutCleanupTimings(params: { forceSettleMs: number; killGraceMs: number }) {
    setQaScenarioCommandCleanupTimings(params);
  },
};
