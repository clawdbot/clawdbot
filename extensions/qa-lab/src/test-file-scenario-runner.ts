import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { assertQaSuiteArtifactWritten } from "./artifact-assertion.js";
import { isRepoRootRelativeRef, toRepoRelativePath } from "./cli-paths.js";
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

function vitestSteps(scenario: QaTestFileScenario): QaScenarioCommandStep[] {
  return [
    {
      command: process.execPath,
      args: ["scripts/run-vitest.mjs", scenario.execution.path, "--reporter=verbose"],
    },
  ];
}

function playwrightSteps(scenario: QaTestFileScenario): QaScenarioCommandStep[] {
  const testNamePattern =
    scenario.execution.kind === "playwright" ? scenario.execution.testNamePattern : undefined;
  const testNameArgs = testNamePattern ? ["--testNamePattern", testNamePattern] : [];
  return [
    {
      command: process.execPath,
      args: ["scripts/ensure-playwright-chromium.mjs", "--skip-ffmpeg"],
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
        "--reporter=verbose",
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
      const timeoutMs =
        params.scenario.execution.kind === "script"
          ? (params.scenario.execution.timeoutMs ?? params.commandTimeoutMs)
          : undefined;
      const result = await params.runCommand({
        command: step.command,
        args: step.args,
        cwd: params.repoRoot,
        env: params.env,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
  const definition = testFileRunnerDefinitions[params.scenario.execution.kind];
  const result = await runScenarioCommandSteps({
    ...params,
    steps: definition.buildSteps(params.scenario, { outputDir: params.outputDir }),
  });
  if (params.scenario.execution.kind !== "script") {
    return result;
  }
  const producerEvidenceResult = await readScriptProducerEvidence({
    outputDir: params.outputDir,
    repoRoot: params.repoRoot,
    scenario: params.scenario,
  });
  if (!producerEvidenceResult.producerEvidence) {
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
    return { status: "pass" };
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
  if (producerEvidence.entries.every((entry) => entry.result.status === "skipped")) {
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
  const producerEntries = params.results.flatMap(
    (result) => result.producerEvidence?.entries ?? [],
  );
  if (producerEntries.length > 0) {
    const definition = testFileRunnerDefinitions[params.kind];
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
        ...(fallbackEvidence?.entries ?? []),
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

async function readJsonFileIfExists(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${formatErrorMessage(error)}`, { cause: error });
  }
}

// Producer artifact paths follow one convention: relative paths resolve against the
// qa-evidence.json directory, absolute paths are taken as-is. Paths under the repo root
// become repo-relative; paths outside it stay absolute so downstream consumers never see
// `../` segments that would read as path traversal.
function resolveScriptProducerArtifactPath(params: {
  evidenceDir: string;
  repoRoot: string;
  artifactPath: string;
}) {
  const absolutePath = path.isAbsolute(params.artifactPath)
    ? params.artifactPath
    : path.join(params.evidenceDir, params.artifactPath);
  const repoRelativePath = toRepoRelativePath(params.repoRoot, absolutePath);
  return isRepoRootRelativeRef(repoRelativePath) ? repoRelativePath : path.normalize(absolutePath);
}

function normalizeScriptProducerEvidence(params: {
  evidence: QaEvidenceSummaryJson;
  evidencePath: string;
  repoRoot: string;
}): QaEvidenceSummaryJson {
  // Input is already validated by the caller; this only rewrites artifact path strings,
  // so the transformed shape stays schema-valid without re-parsing.
  const evidenceDir = path.dirname(params.evidencePath);
  return {
    ...params.evidence,
    entries: params.evidence.entries.map((entry) => ({
      ...entry,
      execution: entry.execution
        ? {
            ...entry.execution,
            artifacts: entry.execution.artifacts.map((artifact) => ({
              ...artifact,
              path: resolveScriptProducerArtifactPath({
                artifactPath: artifact.path,
                evidenceDir,
                repoRoot: params.repoRoot,
              }),
            })),
          }
        : undefined,
    })),
  };
}

async function readScriptProducerEvidence(params: {
  outputDir: string;
  repoRoot: string;
  scenario: QaTestFileScenario;
}): Promise<Pick<QaTestFileScenarioResult, "producerEvidence">> {
  const scenarioOutputDir = path.join(params.outputDir, params.scenario.id);
  const latestRun = (await readJsonFileIfExists(
    path.join(scenarioOutputDir, "latest-run.json"),
  )) as { qaEvidence?: unknown } | undefined;
  const candidates = [
    typeof latestRun?.qaEvidence === "string" ? latestRun.qaEvidence : undefined,
    path.join(scenarioOutputDir, QA_EVIDENCE_FILENAME),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const evidencePath = path.isAbsolute(candidate)
      ? candidate
      : path.join(scenarioOutputDir, candidate);
    const rawEvidence = await readJsonFileIfExists(evidencePath);
    if (!rawEvidence) {
      continue;
    }
    const evidence = validateQaEvidenceSummaryJson(rawEvidence);
    return {
      producerEvidence: normalizeScriptProducerEvidence({
        evidence,
        evidencePath,
        repoRoot: params.repoRoot,
      }),
    };
  }
  return {};
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
  for (const scenario of scenarios) {
    results.push(
      await runQaTestFileScenario({
        env,
        commandTimeoutMs,
        outputDir: params.outputDir,
        repoRoot: params.repoRoot,
        runCommand,
        scenario,
      }),
    );
  }
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
