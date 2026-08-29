// QA Lab plugin module implements suite launch behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { isRepoRootRelativeRef, toRepoRelativePath } from "./cli-paths.js";
import { QaSuiteArtifactError, QaSuiteInfraError } from "./errors.js";
import {
  QA_EVIDENCE_FILENAME,
  buildQaSuiteEvidenceSummary,
  mergeQaEvidenceSummaries,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { isQaFastModeEnabled } from "./model-selection.js";
import { resolveQaRuntimeModelPair } from "./model-selection.runtime.js";
import { DEFAULT_QA_PROVIDER_MODE } from "./providers/index.js";
import {
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
  type QaTransportDriver,
} from "./qa-transport-registry.js";
import { renderQaMarkdownReport, type QaReportScenario } from "./report.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./run-config.js";
import {
  readQaBootstrapScenarioCatalog,
  resolveQaScenarioRequiredProviderMode,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells, type QaScenarioExecutionCell } from "./scenario-lane.js";
import {
  invalidateQaSuiteArtifactGeneration,
  publishQaSuiteArtifactFiles,
} from "./suite-artifacts.js";
import {
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  normalizeQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteOutputDir,
  resolveQaSuiteWorkerStartStaggerMs,
  scenarioRequiresIsolatedQaSuiteWorker,
} from "./suite-planning.js";
import { createQaSuiteProgressController } from "./suite-progress.js";
import {
  buildQaSuiteSummaryJson,
  shouldLogQaSuiteProgress,
  type QaSuiteResult,
  type QaSuiteRunParams,
  type QaSuiteScenarioResult,
  type QaSuiteSummaryJson,
  writeQaSuiteProgress,
} from "./suite.js";
import * as dockerBatch from "./test-file-scenario-docker-batch.js";
import {
  isQaTestFileScenario,
  runQaTestFileScenarios,
  type QaTestFileExecutionKind,
  type QaTestFileScenario,
  type QaTestFileScenarioRunResult,
} from "./test-file-scenario-runner.js";

export type QaSuiteRuntimeResult = {
  expectedCells: QaScenarioExecutionCell[];
  observedCells: QaScenarioExecutionCell[];
} & (
  | {
      executionKind: "flow";
      result: QaSuiteResult;
    }
  | {
      executionKind: "suite";
      result: QaUnifiedSuiteResult;
    }
);

type QaUnifiedSuiteResult = {
  evidencePath: string;
  outputDir: string;
  report: string;
  reportPath: string;
  scenarios: QaSuiteScenarioResult[];
  summaryPath: string;
};

type QaSuiteExecutionPlan = {
  expectedCells: QaScenarioExecutionCell[];
  scenarios: QaSeedScenarioWithSource[];
} & (
  | {
      kind: "flow";
    }
  | {
      kind: "unified";
      channelGroups: QaFlowChannelGroup[];
      testFileScenariosByKind: Map<QaTestFileExecutionKind, QaTestFileScenario[]>;
    }
);

const MAX_SHARED_FLOW_PARTITIONS = 4;
const MAX_ISOLATED_FLOW_CONCURRENCY = 8;
// Three is the audited ceiling for concurrent Gateway and process-group lifecycles.
// Raising it risks cleanup overlap and shared port/listener contention.
const MAX_PARALLEL_SCRIPT_CONCURRENCY = 3;
const ISOLATED_FLOW_WORKER_START_STAGGER_MS = 1_500;
const QA_SUITE_INFRA_RETRY_LIMIT = 1;
const QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);
const CREDENTIAL_POOL_UNAVAILABLE_CODES = new Set(["NO_CREDENTIAL_AVAILABLE", "POOL_EXHAUSTED"]);

type QaUnifiedPartitionResult = {
  evidenceSummaries: QaEvidenceSummaryJson[];
  scenarioResults: Array<{
    result: QaSuiteScenarioResult;
    scenarioId: string;
  }>;
  startedScenarioIds: readonly string[];
  submittedScenarioIds: readonly string[];
};

type QaUnifiedPartitionTask = {
  channel?: string;
  channelId: string;
  exclusiveKey?: string;
  run: () => Promise<QaUnifiedPartitionResult>;
  scenarios: readonly QaSeedScenarioWithSource[];
  weight: number;
};

function summarizeQaEvidenceChannel(
  summaries: readonly QaEvidenceSummaryJson[],
): { id?: string; driver: QaTransportDriver } | undefined {
  const channels = summaries.flatMap((summary) =>
    summary.entries.map((entry) => entry.execution?.channel),
  );
  const first = channels[0];
  if (
    !first?.driver ||
    !["qa-channel", "crabline", "live"].includes(first.driver) ||
    channels.some((channel) => channel?.driver !== first.driver)
  ) {
    return undefined;
  }
  return {
    ...(channels.every((channel) => channel?.id === first.id) ? { id: first.id } : {}),
    driver: first.driver as QaTransportDriver,
  };
}

type QaFlowChannelGroup = {
  channel: string | undefined;
  channelId: string | undefined;
  channelDriverSelection: QaSuiteRunParams["channelDriverSelection"];
  isolatesAdapterInstances?: boolean;
  scenarios: QaSeedScenarioWithSource[];
};

function groupQaScenariosByExecutionCell(
  scenarios: readonly QaSeedScenarioWithSource[],
  cells: readonly QaScenarioExecutionCell[],
) {
  const scenariosById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const groups = new Map<string | undefined, QaSeedScenarioWithSource[]>();
  for (const cell of cells) {
    const channel = cell.channel ?? undefined;
    const group = groups.get(channel) ?? [];
    group.push(scenariosById.get(cell.scenarioId)!);
    groups.set(channel, group);
  }
  return groups;
}

function hasQaSuiteRetryableNetworkCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") {
      return false;
    }
    const record = current as { cause?: unknown; code?: unknown };
    if (
      typeof record.code === "string" &&
      QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES.has(record.code.toUpperCase())
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

function isQaSuiteInfraRetryableError(error: unknown) {
  if (error instanceof QaSuiteArtifactError || error instanceof QaSuiteInfraError) {
    return true;
  }
  return hasQaSuiteRetryableNetworkCode(error);
}

export async function runQaSuiteWithInfraRetry<Result>(
  run: () => Promise<Result>,
  maxRetries = QA_SUITE_INFRA_RETRY_LIMIT,
) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isQaSuiteInfraRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }
      process.stderr.write(
        `[qa-suite] infra retry ${attempt + 1}/${maxRetries}: ${formatErrorMessage(error)}\n`,
      );
    }
  }
  throw new Error("unreachable qa suite retry state");
}

async function loadQaLabServerRuntime() {
  const { startQaLabServer } = await import("./lab-server.js");
  return startQaLabServer;
}

async function loadQaFlowSuiteRuntime() {
  const [{ runQaFlowSuite }, startLab] = await Promise.all([
    import("./suite.js"),
    loadQaLabServerRuntime(),
  ]);
  return async (params: QaSuiteRunParams | undefined) =>
    await runQaFlowSuite({
      ...params,
      startLab: params?.startLab ?? startLab,
    });
}

function resolveRequestedScenarios(params: {
  scenarioIds: readonly string[];
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
}) {
  const scenarioById = new Map(params.scenarios.map((scenario) => [scenario.id, scenario]));
  return params.scenarioIds.map((scenarioId) => {
    const scenario = scenarioById.get(scenarioId);
    if (!scenario) {
      throw new Error(`unknown QA scenario id(s): ${scenarioId}`);
    }
    return scenario;
  });
}

async function resolveQaFlowChannelGroups(
  runParams: QaSuiteRunParams | undefined,
  scenarios: readonly QaSeedScenarioWithSource[],
): Promise<QaFlowChannelGroup[]> {
  if (runParams?.adapterFactories) {
    const isolatesInstances = (channelId: string | undefined) => {
      if (!channelId || runParams.channelDriver !== "live") {
        return false;
      }
      return (
        runParams.adapterFactories?.find((factory) =>
          factory.matches({ channelId, driver: "live" }),
        )?.isolatesInstances === true
      );
    };
    const groups = groupQaScenariosByExecutionCell(
      scenarios,
      expandQaScenarioExecutionCells({
        scenarios,
        channelDriver: runParams.channelDriver ?? "qa-channel",
        channel: runParams.channelId,
        supportsChannel: (channelId) =>
          runParams.adapterFactories?.some((factory) =>
            factory.matches({ channelId, driver: "live" }),
          ) === true,
        expandChannels: runParams.expandScenarioChannels === true,
      }),
    );
    return [...groups].map(([channel, groupedScenarios]) => ({
      channel,
      channelId: channel,
      channelDriverSelection: runParams.channelDriverSelection,
      isolatesAdapterInstances: isolatesInstances(channel),
      scenarios: groupedScenarios,
    }));
  }
  if (runParams?.channelDriver !== "crabline") {
    return [
      {
        channel: runParams?.channelId ?? runParams?.channelDriverSelection?.channel,
        channelId: runParams?.channelId,
        channelDriverSelection: runParams?.channelDriverSelection,
        scenarios: [...scenarios],
      },
    ];
  }
  // Package-only live lanes mount the QA harness without its dev tree. Load
  // Crabline only for Crabline-owned runs so unrelated transports stay isolated.
  const {
    isCrablineServerChannel,
    OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
    resolveOpenClawCrablineChannelDriverSelection,
  } = await import("@openclaw/crabline");
  if (runParams.expandScenarioChannels) {
    const groups = groupQaScenariosByExecutionCell(
      scenarios,
      expandQaScenarioExecutionCells({
        scenarios,
        channelDriver: "crabline",
        channel: runParams.channelDriverSelection?.channel,
        defaultChannel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
        supportsChannel: isCrablineServerChannel,
        expandChannels: true,
      }),
    );
    return [...groups].map(([channel, groupedScenarios]) => ({
      channel,
      channelId: undefined,
      channelDriverSelection: channel
        ? resolveOpenClawCrablineChannelDriverSelection({ channel })
        : undefined,
      scenarios: groupedScenarios,
    }));
  }
  const channels = resolveQaSuiteScenarioChannels({
    defaultChannel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
    explicitChannel: runParams.channelDriverSelection?.channel,
    scenarios: [...scenarios],
  });
  const [singleChannel] = channels;
  if (channels.length === 1 && singleChannel) {
    return [
      {
        channel: singleChannel,
        channelId: undefined,
        channelDriverSelection:
          runParams.channelDriverSelection ??
          resolveOpenClawCrablineChannelDriverSelection({ channel: singleChannel }),
        scenarios: [...scenarios],
      },
    ];
  }
  // One Crabline process serves one channel. Mixed logical suites therefore
  // launch one flow partition per channel and aggregate them at this owner.
  return channels.map((channel) => ({
    channel,
    channelId: undefined,
    channelDriverSelection: resolveOpenClawCrablineChannelDriverSelection({ channel }),
    scenarios: scenarios.filter(
      (scenario) =>
        (normalizeQaSuiteScenarioChannel(scenario) ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL) ===
        channel,
    ),
  }));
}

async function resolveSuiteExecutionPlan(
  params: QaSuiteRunParams | undefined,
): Promise<QaSuiteExecutionPlan> {
  const scenarioIds = params?.scenarioIds ?? [];
  if (scenarioIds.length === 0) {
    return { kind: "flow", expectedCells: [], scenarios: [] };
  }
  const selectedScenarios = resolveRequestedScenarios({
    scenarioIds,
    scenarios: readQaBootstrapScenarioCatalog().scenarios,
  });
  const flowScenarios = selectedScenarios.filter((scenario) => !isQaTestFileScenario(scenario));
  const testFileScenariosByKind = new Map<QaTestFileExecutionKind, QaTestFileScenario[]>();
  for (const scenario of selectedScenarios) {
    if (!isQaTestFileScenario(scenario)) {
      continue;
    }
    const scenarios = testFileScenariosByKind.get(scenario.execution.kind) ?? [];
    scenarios.push(scenario);
    testFileScenariosByKind.set(scenario.execution.kind, scenarios);
  }
  const channelGroups = (await resolveQaFlowChannelGroups(params, flowScenarios)).filter(
    (group) => group.scenarios.length > 0,
  );
  const expectedCells = [
    ...channelGroups.flatMap((group) =>
      expandQaScenarioExecutionCells({
        scenarios: group.scenarios,
        channelDriver: params?.channelDriver ?? "qa-channel",
        channel: group.channel,
        expandChannels: false,
      }),
    ),
    ...expandQaScenarioExecutionCells({
      scenarios: [...testFileScenariosByKind.values()].flat(),
      channelDriver: params?.channelDriver ?? "qa-channel",
      expandChannels: false,
    }),
  ];
  const requiresFlowPartitions =
    channelGroups.length > 1 ||
    channelGroups.some(
      (group) => group.channelId !== undefined && group.channelId !== params?.channelId,
    ) ||
    flowScenarios.some(
      (scenario) => scenario.execution.kind === "flow" && scenario.execution.runtime !== undefined,
    ) ||
    (flowScenarios.length > 1 && flowScenarios.some(scenarioRequiresIsolatedQaSuiteWorker));
  if (testFileScenariosByKind.size === 0 && !requiresFlowPartitions) {
    return { kind: "flow", expectedCells, scenarios: selectedScenarios };
  }
  return {
    kind: "unified",
    channelGroups,
    expectedCells,
    scenarios: selectedScenarios,
    testFileScenariosByKind,
  };
}

async function runQaTestFileSuiteFromRuntime(params: {
  env?: NodeJS.ProcessEnv;
  runParams: QaSuiteRunParams | undefined;
  scenarios: readonly QaTestFileScenario[];
}): Promise<QaTestFileScenarioRunResult> {
  const runParams = params.runParams;
  rejectFlowOnlySuiteOptionsForUnifiedRun(runParams);
  const repoRoot = path.resolve(runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, runParams?.outputDir);
  const providerMode = normalizeQaProviderMode(runParams?.providerMode ?? DEFAULT_QA_PROVIDER_MODE);
  const primaryModel = runParams?.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  return await runQaTestFileScenarios({
    evidenceMode: runParams?.evidenceMode,
    ...(params.env ? { env: params.env, envMode: "replace" as const } : {}),
    ...(runParams?.failFast ? { failFast: true } : {}),
    ...(shouldLogQaSuiteProgress()
      ? { progress: (message: string) => writeQaSuiteProgress(true, message) }
      : {}),
    repoRoot,
    outputDir,
    providerMode,
    primaryModel,
    scenarios: params.scenarios,
    writeEvidenceFile: runParams?.writeEvidenceFile,
  });
}

function rejectFlowOnlySuiteOptionsForUnifiedRun(runParams: QaSuiteRunParams | undefined) {
  if (runParams?.runtimePair) {
    throw new Error("--runtime-pair requires execution.kind: flow scenarios.");
  }
  if (runParams?.forcedRuntime) {
    throw new Error("forced runtime execution requires execution.kind: flow scenarios.");
  }
  if (runParams?.captureRuntimeParityCell) {
    throw new Error("runtime parity capture requires execution.kind: flow scenarios.");
  }
}

function suitePartitionOutputDir(outputDir: string, kind: "flow" | QaTestFileExecutionKind) {
  return path.join(outputDir, kind);
}

function flowSuitePartitionOutputDir(outputDir: string, partition: string) {
  return path.join(suitePartitionOutputDir(outputDir, "flow"), partition);
}

function partitionSharedFlowScenarios(
  scenarios: readonly QaSeedScenarioWithSource[],
  concurrency: number,
  maxPartitions = MAX_SHARED_FLOW_PARTITIONS,
) {
  const partitionCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    Math.max(1, Math.floor(maxPartitions)),
    scenarios.length,
  );
  const partitions = Array.from({ length: partitionCount }, (): QaSeedScenarioWithSource[] => []);
  for (const [index, scenario] of scenarios.entries()) {
    const partition = partitions[index % partitionCount];
    if (!partition) {
      throw new Error("failed to partition shared QA flow scenarios");
    }
    partition.push(scenario);
  }
  return partitions.filter((partition) => partition.length > 0);
}

async function runWeightedUnifiedPartitionTasks(
  tasks: readonly QaUnifiedPartitionTask[],
  maxWeight: number,
) {
  if (tasks.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.floor(maxWeight));
  const results: QaUnifiedPartitionResult[] = [];
  const pending = tasks.map((task, index) => ({ index, task }));
  const activeExclusiveKeys = new Set<string>();
  let activeWeight = 0;
  return await new Promise<QaUnifiedPartitionResult[]>((resolve, reject) => {
    let firstError: Error | undefined;
    let finished = false;
    const finishIfSettled = () => {
      if (finished || activeWeight > 0) {
        return;
      }
      finished = true;
      if (firstError) {
        reject(toErrorObject(firstError, "QA suite partition failed"));
        return;
      }
      resolve(results);
    };
    const launch = () => {
      if (firstError) {
        finishIfSettled();
        return;
      }
      while (pending.length > 0) {
        const pendingIndex = pending.findIndex(({ task }) => {
          const taskWeight = Math.max(1, Math.min(limit, Math.floor(task.weight)));
          return (
            (activeWeight === 0 || activeWeight + taskWeight <= limit) &&
            (!task.exclusiveKey || !activeExclusiveKeys.has(task.exclusiveKey))
          );
        });
        if (pendingIndex === -1) {
          return;
        }
        const pendingTask = pending.splice(pendingIndex, 1)[0];
        if (!pendingTask) {
          throw new Error("failed to select a pending QA suite partition task");
        }
        const { index, task } = pendingTask;
        const taskWeight = Math.max(1, Math.min(limit, Math.floor(task.weight)));
        activeWeight += taskWeight;
        if (task.exclusiveKey) {
          activeExclusiveKeys.add(task.exclusiveKey);
        }
        task.run().then(
          (result) => {
            results[index] = result;
            activeWeight -= taskWeight;
            if (task.exclusiveKey) {
              activeExclusiveKeys.delete(task.exclusiveKey);
            }
            if (pending.length === 0 && activeWeight === 0) {
              finishIfSettled();
              return;
            }
            launch();
          },
          (error: unknown) => {
            firstError = error instanceof Error ? error : new Error(String(error));
            activeWeight -= taskWeight;
            if (task.exclusiveKey) {
              activeExclusiveKeys.delete(task.exclusiveKey);
            }
            finishIfSettled();
          },
        );
      }
      if (activeWeight === 0) {
        finishIfSettled();
      }
    };
    launch();
  });
}

async function readQaSuiteEvidenceSummary(evidencePath: string) {
  return validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(evidencePath, "utf8")));
}

async function resolveQaSuiteResultEvidenceSummary(result: {
  evidence?: QaEvidenceSummaryJson;
  evidencePath: string;
  outputDir: string;
  repoRoot: string;
}) {
  const summary = result.evidence ?? (await readQaSuiteEvidenceSummary(result.evidencePath));
  const rebasedSummary = structuredClone(summary);
  for (const entry of rebasedSummary.entries) {
    if (!entry.execution) {
      continue;
    }
    for (const artifact of entry.execution.artifacts) {
      if (artifact.source !== "qa-suite" || !isRepoRootRelativeRef(artifact.path)) {
        continue;
      }
      artifact.path = toRepoRelativePath(
        result.repoRoot,
        path.resolve(result.outputDir, artifact.path),
      );
    }
  }
  return validateQaEvidenceSummaryJson(rebasedSummary);
}

function hasCredentialPoolUnavailableCode(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    ("code" in error && CREDENTIAL_POOL_UNAVAILABLE_CODES.has(String(error.code))) ||
    hasCredentialPoolUnavailableCode(error.cause)
  );
}

function isChannelCredentialPoolUnavailable(
  error: unknown,
  channelId: string | undefined,
): boolean {
  if (!channelId || !(error instanceof Error)) {
    return false;
  }
  return (
    (error.message.startsWith(`failed to create QA transport live:${channelId}:`) &&
      hasCredentialPoolUnavailableCode(error.cause)) ||
    isChannelCredentialPoolUnavailable(error.cause, channelId)
  );
}

function testFileScenarioResultToSuiteScenario(
  result: QaTestFileScenarioRunResult["results"][number],
  repoRoot: string,
): QaSuiteScenarioResult {
  const suiteStatus =
    result.status === "pass" ? "pass" : result.status === "skipped" ? "skip" : "fail";
  const stepStatus = suiteStatus;
  const logPath = toRepoRelativePath(repoRoot, result.logPath);
  const details = [
    `execution.kind=${result.scenario.execution.kind}`,
    `execution.path=${result.scenario.execution.path}`,
    `log=${logPath}`,
    ...(result.failureMessage ? [`failure=${result.failureMessage}`] : []),
  ].join("\n");
  return {
    name: result.scenario.title,
    status: suiteStatus,
    details,
    steps: [
      {
        name: `Run ${result.scenario.execution.kind} test file`,
        status: stepStatus,
        details,
      },
    ],
  };
}

function renderUnifiedQaSuiteReport(params: {
  finishedAt: Date;
  scenarios: readonly QaSuiteScenarioResult[];
  startedAt: Date;
}) {
  return renderQaMarkdownReport({
    title: "OpenClaw QA Scenario Suite",
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    checks: [],
    scenarios: params.scenarios.map((scenario) => ({
      name: scenario.name,
      status: scenario.status,
      details: scenario.details,
      steps: scenario.steps,
    })) satisfies QaReportScenario[],
  });
}

async function writeUnifiedQaSuiteArtifacts(params: {
  alternateModel: string;
  channel?: string;
  channelDriver?: QaTransportDriver;
  concurrency: number;
  evidence: QaEvidenceSummaryJson;
  fastMode: boolean;
  finishedAt: Date;
  outputDir: string;
  primaryModel: string;
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  runtimePair: QaSuiteRunParams["runtimePair"];
  scenarioIds: readonly string[];
  scenarios: readonly QaSuiteScenarioResult[];
  startedAt: Date;
}) {
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  const report = renderUnifiedQaSuiteReport({
    finishedAt: params.finishedAt,
    scenarios: params.scenarios,
    startedAt: params.startedAt,
  });
  const summary = buildQaSuiteSummaryJson({
    alternateModel: params.alternateModel,
    channel: params.channel,
    channelDriver: params.channelDriver,
    concurrency: params.concurrency,
    evidence: params.evidence,
    fastMode: params.fastMode,
    finishedAt: params.finishedAt,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    runtimePair: params.runtimePair,
    scenarioIds: params.scenarioIds,
    scenarios: [...params.scenarios],
    startedAt: params.startedAt,
  }) satisfies QaSuiteSummaryJson;
  await publishQaSuiteArtifactFiles({
    outputDir: params.outputDir,
    files: [
      { filePath: evidencePath, content: `${JSON.stringify(params.evidence, null, 2)}\n` },
      { filePath: reportPath, content: report },
      { filePath: summaryPath, content: `${JSON.stringify(summary, null, 2)}\n` },
    ],
  });
  return {
    evidencePath,
    outputDir: params.outputDir,
    report,
    reportPath,
    scenarios: [...params.scenarios],
    summaryPath,
  } satisfies QaUnifiedSuiteResult;
}

async function runUnifiedQaSuite(params: {
  plan: Extract<QaSuiteExecutionPlan, { kind: "unified" }>;
  runParams: QaSuiteRunParams | undefined;
}): Promise<QaUnifiedSuiteResult & { observedCells: QaScenarioExecutionCell[] }> {
  if (params.plan.testFileScenariosByKind.size > 0) {
    rejectFlowOnlySuiteOptionsForUnifiedRun(params.runParams);
  }
  const startedAt = new Date();
  const repoRoot = path.resolve(params.runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params.runParams?.outputDir);
  await invalidateQaSuiteArtifactGeneration(outputDir);
  // Only an explicitly selected single flow may replace the unified suite's mock default.
  const [selectedScenario] = params.plan.scenarios;
  const selectedProviderMode =
    params.runParams?.providerMode === undefined &&
    params.runParams?.scenarioIds?.length === 1 &&
    params.plan.scenarios.length === 1 &&
    selectedScenario?.execution.kind === "flow"
      ? resolveQaScenarioRequiredProviderMode(selectedScenario)
      : undefined;
  const providerMode = normalizeQaProviderMode(
    params.runParams?.providerMode ?? selectedProviderMode ?? DEFAULT_QA_PROVIDER_MODE,
  );
  const progress = params.runParams?.lab
    ? createQaSuiteProgressController({
        lab: params.runParams.lab,
        scenarios: params.plan.scenarios,
        startedAt: startedAt.toISOString(),
      })
    : undefined;
  progress?.start();
  const { primaryModel, alternateModel } = resolveQaRuntimeModelPair({
    providerMode,
    primaryModel: params.runParams?.primaryModel,
    alternateModel: params.runParams?.alternateModel,
  });
  const fastMode =
    typeof params.runParams?.fastMode === "boolean"
      ? params.runParams.fastMode
      : isQaFastModeEnabled({ primaryModel, alternateModel });
  const transportId = normalizeQaTransportId(params.runParams?.transportId);
  const defaultConcurrency =
    params.runParams?.channelDriver === "crabline" || params.runParams?.channelDriverSelection
      ? 1
      : defaultQaSuiteConcurrencyForTransport(transportId);
  const failFast = params.runParams?.failFast === true;
  const concurrency = failFast
    ? 1
    : normalizeQaSuiteConcurrency(
        params.runParams?.concurrency,
        params.plan.scenarios.length,
        defaultConcurrency,
      );
  const evidenceSummaries: QaEvidenceSummaryJson[] = [];
  const scenarioResultsById = new Map<string, QaSuiteScenarioResult[]>();
  const observedCellsByKey = new Map<string, QaScenarioExecutionCell>();
  const recordObservedScenarios = (
    scenarios: readonly QaSeedScenarioWithSource[],
    channel?: string,
  ) => {
    for (const cell of expandQaScenarioExecutionCells({
      scenarios,
      channelDriver: params.runParams?.channelDriver ?? "qa-channel",
      channel,
      expandChannels: false,
    })) {
      observedCellsByKey.set(JSON.stringify(cell), cell);
    }
  };
  const sharedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const isolatedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const testFilePartitionTasks: QaUnifiedPartitionTask[] = [];
  const serialScriptPartitionTasks: QaUnifiedPartitionTask[] = [];
  const parallelScriptPartitionTasks: QaUnifiedPartitionTask[] = [];
  const unavailableChannelCredentialDetails = new Map<string, string>();
  let preparedScriptEnv: Readonly<NodeJS.ProcessEnv> | undefined;
  if (params.plan.channelGroups.length > 0) {
    const channelGroups = params.plan.channelGroups;
    const runFlowSuite = await loadQaFlowSuiteRuntime();
    for (const channelGroup of channelGroups) {
      const sharedFlowScenarios = channelGroup.scenarios.filter(
        (scenario) => !scenarioRequiresIsolatedQaSuiteWorker(scenario),
      );
      const isolatedFlowScenarios = channelGroup.scenarios.filter(
        scenarioRequiresIsolatedQaSuiteWorker,
      );
      const runtimeFlowScenarios = isolatedFlowScenarios.flatMap((scenario) =>
        scenario.execution.kind === "flow" && scenario.execution.runtime
          ? [{ runtime: scenario.execution.runtime, scenario }]
          : [],
      );
      const runtimeScenarioSet = new Set(runtimeFlowScenarios.map(({ scenario }) => scenario));
      const ordinaryIsolatedFlowScenarios = isolatedFlowScenarios.filter(
        (scenario) => !runtimeScenarioSet.has(scenario),
      );
      const channelId = channelGroup.channelId;
      const usesContributedChannelDriver = Boolean(
        channelId &&
        params.runParams?.channelDriver === "live" &&
        params.runParams.adapterFactories?.find((factory) =>
          factory.matches({ channelId, driver: "live" }),
        ),
      );
      // Isolated adapters may use the caller's full suite budget; every partition
      // still has weight one in the global scheduler below.
      // A rejected worker cannot return its completed prefix or active scenario.
      // Single-scenario fail-fast tasks keep retries and failure evidence attributable.
      const sharedFlowPartitions = failFast
        ? sharedFlowScenarios.map((scenario) => [scenario])
        : partitionSharedFlowScenarios(
            sharedFlowScenarios,
            usesContributedChannelDriver && !channelGroup.isolatesAdapterInstances
              ? 1
              : concurrency,
            channelGroup.isolatesAdapterInstances ? concurrency : MAX_SHARED_FLOW_PARTITIONS,
          );
      // Channel-driver flow workers each launch a gateway plus transport harness.
      // Serializing their isolated workers keeps state-mutating smoke checks from
      // flaking under concurrent child gateways while preserving non-driver speed.
      const channelDriverFlowRequiresExclusiveWorkers =
        Boolean(channelGroup.channelDriverSelection || usesContributedChannelDriver) &&
        !channelGroup.isolatesAdapterInstances;
      const isolatedFlowConcurrencyLimit = channelDriverFlowRequiresExclusiveWorkers
        ? 1
        : MAX_ISOLATED_FLOW_CONCURRENCY;
      const isolatedFlowConcurrency = Math.min(
        concurrency,
        isolatedFlowConcurrencyLimit,
        ordinaryIsolatedFlowScenarios.length,
      );
      const isolatedFlowPartitions =
        isolatedFlowConcurrency === 1 && ordinaryIsolatedFlowScenarios.length > 1
          ? ordinaryIsolatedFlowScenarios.map((scenario, index) => ({
              kind: `isolated-${index + 1}`,
              scenarios: [scenario],
              concurrency: 1,
            }))
          : [
              {
                kind: "isolated",
                scenarios: ordinaryIsolatedFlowScenarios,
                concurrency: isolatedFlowConcurrency,
              },
            ];
      const flowPartitions = [
        ...sharedFlowPartitions.map((scenarios, index) => ({
          kind: sharedFlowPartitions.length === 1 ? "shared" : `shared-${index + 1}`,
          scenarios,
          concurrency: 1,
        })),
        ...isolatedFlowPartitions,
        ...runtimeFlowScenarios.map(({ runtime, scenario }, index) => ({
          kind: `runtime-${runtime}-${index + 1}`,
          scenarios: [scenario],
          concurrency: 1,
        })),
      ].filter((partition) => partition.scenarios.length > 0);
      for (const partition of flowPartitions) {
        const isolatedPartition =
          partition.kind === "isolated" || partition.kind.startsWith("isolated-");
        const partitionName = [
          channelGroups.length > 1 ? channelGroup.channel : undefined,
          flowPartitions.length > 1 ? partition.kind : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join("-");
        const taskChannelId =
          channelGroup.channelId ??
          channelGroup.channelDriverSelection?.channel ??
          channelGroup.channel ??
          transportId;
        const buildCredentialUnavailableResult = (details: string): QaUnifiedPartitionResult => {
          const blockedResults = partition.scenarios.map((scenario) => ({
            name:
              params.runParams?.expandScenarioChannels && channelGroup.channel
                ? `${scenario.title} [${channelGroup.channel}]`
                : scenario.title,
            status: "blocked" as const,
            details,
          }));
          return {
            evidenceSummaries: [
              buildQaSuiteEvidenceSummary({
                artifactPaths: [],
                evidenceMode: params.runParams?.evidenceMode,
                channelId: taskChannelId,
                env: process.env,
                generatedAt: new Date().toISOString(),
                primaryModel,
                providerMode,
                repoRoot,
                scenarioDefinitions: partition.scenarios,
                scenarioResults: blockedResults,
              }),
            ],
            scenarioResults: partition.scenarios.map((scenario) => ({
              scenarioId: scenario.id,
              result: {
                name:
                  params.runParams?.expandScenarioChannels && channelGroup.channel
                    ? `${scenario.title} [${channelGroup.channel}]`
                    : scenario.title,
                status: "fail",
                details,
                steps: [{ name: "Acquire channel credential", status: "fail", details }],
              },
            })),
            startedScenarioIds: partition.scenarios.map((scenario) => scenario.id),
            submittedScenarioIds: partition.scenarios.map((scenario) => scenario.id),
          };
        };
        const task = {
          channel: channelGroup.channel,
          channelId: taskChannelId,
          // One channel's credential and Gateway state stay serial unless each adapter create()
          // owns an isolated runtime. Distinct channels may always run together.
          exclusiveKey: channelDriverFlowRequiresExclusiveWorkers
            ? `channel:${channelGroup.channel ?? channelGroup.channelId ?? "default"}`
            : undefined,
          scenarios: partition.scenarios,
          weight: partition.concurrency,
          run: async () => {
            const unavailableDetails = channelGroup.channelId
              ? unavailableChannelCredentialDetails.get(channelGroup.channelId)
              : undefined;
            if (unavailableDetails) {
              return buildCredentialUnavailableResult(unavailableDetails);
            }
            const result = await runFlowSuite({
              ...params.runParams,
              ...(progress
                ? {
                    lab: progress.createPartitionLab(
                      partition.scenarios.map((scenario) => scenario.id),
                    ),
                  }
                : {}),
              outputDir: partitionName
                ? flowSuitePartitionOutputDir(outputDir, partitionName)
                : suitePartitionOutputDir(outputDir, "flow"),
              writeEvidenceFile: false,
              providerMode,
              primaryModel,
              alternateModel,
              fastMode,
              forcedRuntime:
                partition.scenarios.length === 1 &&
                partition.scenarios[0]?.execution.kind === "flow"
                  ? (partition.scenarios[0].execution.runtime ?? params.runParams?.forcedRuntime)
                  : params.runParams?.forcedRuntime,
              concurrency: partition.concurrency,
              channelId: channelGroup.channelId,
              channelDriverSelection: channelGroup.channelDriverSelection,
              workerStartStaggerMs: isolatedPartition
                ? (params.runParams?.workerStartStaggerMs ??
                  resolveQaSuiteWorkerStartStaggerMs(
                    partition.concurrency,
                    process.env,
                    ISOLATED_FLOW_WORKER_START_STAGGER_MS,
                  ))
                : params.runParams?.workerStartStaggerMs,
              scenarioIds: partition.scenarios.map((scenario) => scenario.id),
            }).catch((error: unknown) => {
              if (!isChannelCredentialPoolUnavailable(error, channelGroup.channelId)) {
                throw error;
              }
              // Preserve other channels' evidence, but keep the suite failed: maturity
              // docs must not publish until every required channel can run.
              const details = `channel credential unavailable: ${formatErrorMessage(error)}`;
              if (channelDriverFlowRequiresExclusiveWorkers && channelGroup.channelId) {
                unavailableChannelCredentialDetails.set(channelGroup.channelId, details);
              }
              return buildCredentialUnavailableResult(details);
            });
            if ("evidenceSummaries" in result) {
              return result;
            }
            const startedScenarioIdSet = new Set(result.startedScenarioIds);
            recordObservedScenarios(
              partition.scenarios.filter((scenario) => startedScenarioIdSet.has(scenario.id)),
              channelGroup.channel,
            );
            const scenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
            for (const [index, scenario] of partition.scenarios.entries()) {
              const scenarioResult = result.scenarios[index];
              if (scenarioResult) {
                scenarioResults.push({
                  scenarioId: scenario.id,
                  result:
                    params.runParams?.expandScenarioChannels && channelGroup.channel
                      ? {
                          ...scenarioResult,
                          name: `${scenarioResult.name} [${channelGroup.channel}]`,
                        }
                      : scenarioResult,
                });
              }
            }
            return {
              evidenceSummaries: [
                await resolveQaSuiteResultEvidenceSummary({
                  ...result,
                  repoRoot,
                }),
              ],
              scenarioResults,
              startedScenarioIds: result.startedScenarioIds,
              submittedScenarioIds: partition.scenarios.map((scenario) => scenario.id),
            };
          },
        } satisfies QaUnifiedPartitionTask;
        if (isolatedPartition) {
          isolatedFlowPartitionTasks.push(task);
        } else {
          sharedFlowPartitionTasks.push(task);
        }
      }
    }
  }
  const createTestFilePartitionTask = (
    scenariosByKind: ReadonlyMap<QaTestFileExecutionKind, QaTestFileScenario[]>,
  ) => {
    const taskScenarios = [...scenariosByKind.values()].flat();
    return {
      channelId: transportId,
      scenarios: taskScenarios,
      weight: 1,
      run: async () => {
        const testFileEvidenceSummaries: QaEvidenceSummaryJson[] = [];
        const testFileScenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
        const testFileStartedScenarioIds: string[] = [];
        for (const [kind, testFileScenarios] of scenariosByKind) {
          progress?.markRunning(
            (failFast ? testFileScenarios.slice(0, 1) : testFileScenarios).map(
              (scenario) => scenario.id,
            ),
          );
          const result = await runQaTestFileSuiteFromRuntime({
            env: kind === "script" ? preparedScriptEnv : undefined,
            runParams: {
              ...params.runParams,
              outputDir: suitePartitionOutputDir(outputDir, kind),
              writeEvidenceFile: false,
              providerMode,
              primaryModel,
              scenarioIds: testFileScenarios.map((scenario) => scenario.id),
            },
            scenarios: testFileScenarios,
          });
          testFileEvidenceSummaries.push(
            await resolveQaSuiteResultEvidenceSummary({
              ...result,
              repoRoot,
            }),
          );
          const scenarioResults = result.results.map((scenarioResult) => ({
            scenarioId: scenarioResult.scenario.id,
            result: testFileScenarioResultToSuiteScenario(scenarioResult, repoRoot),
          }));
          testFileScenarioResults.push(...scenarioResults);
          progress?.recordResults(scenarioResults);
          const resultsByScenarioId = new Map(
            result.results.map((scenarioResult) => [scenarioResult.scenario.id, scenarioResult]),
          );
          let shouldStopNativeKinds = false;
          for (const scenario of testFileScenarios) {
            testFileStartedScenarioIds.push(scenario.id);
            const scenarioResult = resultsByScenarioId.get(scenario.id);
            // The first missing or non-pass native result owns the stop; later
            // scenarios and execution kinds have not started and must stay absent.
            if (failFast && (!scenarioResult || scenarioResult.status !== "pass")) {
              shouldStopNativeKinds = true;
              break;
            }
          }
          if (shouldStopNativeKinds) {
            break;
          }
        }
        recordObservedScenarios(
          taskScenarios.filter((scenario) => testFileStartedScenarioIds.includes(scenario.id)),
        );
        return {
          evidenceSummaries: testFileEvidenceSummaries,
          scenarioResults: testFileScenarioResults,
          startedScenarioIds: testFileStartedScenarioIds,
          submittedScenarioIds: [...scenariosByKind.values()].flatMap((scenarios) =>
            scenarios.map((scenario) => scenario.id),
          ),
        };
      },
    } satisfies QaUnifiedPartitionTask;
  };
  const concurrentTestFileScenariosByKind = new Map(
    [...params.plan.testFileScenariosByKind].filter(([kind]) => kind !== "script"),
  );
  if (concurrentTestFileScenariosByKind.size > 0) {
    if (failFast) {
      for (const [kind, scenarios] of concurrentTestFileScenariosByKind) {
        for (const scenario of scenarios) {
          testFilePartitionTasks.push(createTestFilePartitionTask(new Map([[kind, [scenario]]])));
        }
      }
    } else {
      testFilePartitionTasks.push(createTestFilePartitionTask(concurrentTestFileScenariosByKind));
    }
  }
  const scriptScenarios = params.plan.testFileScenariosByKind
    .get("script")
    ?.filter((scenario) => scenario.execution.kind === "script");
  if (scriptScenarios?.length) {
    const isParallelSafeScript = (scenario: QaTestFileScenario) =>
      scenario.execution.kind === "script" && scenario.execution.parallelSafe === true;
    if (failFast) {
      for (const scenario of scriptScenarios) {
        serialScriptPartitionTasks.push(
          createTestFilePartitionTask(new Map([["script", [scenario]]])),
        );
      }
    } else {
      const serialScenarios = scriptScenarios.filter((scenario) => !isParallelSafeScript(scenario));
      if (serialScenarios.length > 0) {
        serialScriptPartitionTasks.push(
          createTestFilePartitionTask(new Map([["script", serialScenarios]])),
        );
      }
      for (const scenario of scriptScenarios) {
        if (isParallelSafeScript(scenario)) {
          parallelScriptPartitionTasks.push(
            createTestFilePartitionTask(new Map([["script", [scenario]]])),
          );
        }
      }
    }
  }
  const concurrentPartitionTasks = [
    ...sharedFlowPartitionTasks,
    ...testFilePartitionTasks,
    ...isolatedFlowPartitionTasks,
  ];
  const scenarioDefinitionsById = new Map(
    params.plan.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const startedScenarioIds = new Set<string>();
  const runFailFastPartition = async (task: QaUnifiedPartitionTask) => {
    const partition = await task.run();
    const resultsByScenarioId = new Map(
      partition.scenarioResults.map((scenario) => [scenario.scenarioId, scenario]),
    );
    const expectedScenarioIds: string[] = [];
    for (const scenarioId of partition.startedScenarioIds) {
      expectedScenarioIds.push(scenarioId);
      const scenarioResult = resultsByScenarioId.get(scenarioId);
      // A missing started result is itself the failure boundary; including the
      // remaining submitted partition would invent work that never started.
      if (!scenarioResult || scenarioResult.result.status !== "pass") {
        break;
      }
    }
    for (const scenarioId of expectedScenarioIds) {
      startedScenarioIds.add(scenarioId);
    }
    const expectedScenarioIdSet = new Set(expectedScenarioIds);
    const partitionScenarioIdSet = new Set(partition.submittedScenarioIds);
    const missingScenarioDefinitions = expectedScenarioIds.flatMap((scenarioId) => {
      if (resultsByScenarioId.has(scenarioId)) {
        return [];
      }
      const scenario = scenarioDefinitionsById.get(scenarioId);
      return scenario ? [scenario] : [];
    });
    const missingScenarioEvidence =
      missingScenarioDefinitions.length > 0
        ? (() => {
            const channel = summarizeQaEvidenceChannel(partition.evidenceSummaries);
            return [
              buildQaSuiteEvidenceSummary({
                artifactPaths: [],
                evidenceMode: params.runParams?.evidenceMode,
                channelDriver: channel?.driver,
                channelId: channel?.id ?? task.channelId,
                env: process.env,
                generatedAt: new Date().toISOString(),
                primaryModel,
                providerMode,
                repoRoot,
                scenarioDefinitions: missingScenarioDefinitions,
                scenarioResults: missingScenarioDefinitions.map((scenario) => ({
                  name: scenario.title,
                  status: "fail" as const,
                  details: "suite partition returned no scenario result",
                })),
              }),
            ];
          })()
        : [];
    return {
      ...partition,
      evidenceSummaries: [
        ...partition.evidenceSummaries.map((summary) => ({
          ...summary,
          // Preserve producer-owned evidence IDs, but remove scenario evidence
          // belonging to the submitted partition's unstarted fail-fast tail.
          entries: summary.entries.filter(
            (entry) =>
              !partitionScenarioIdSet.has(entry.test.id) ||
              (expectedScenarioIdSet.has(entry.test.id) && resultsByScenarioId.has(entry.test.id)),
          ),
        })),
        ...missingScenarioEvidence,
      ],
      scenarioResults: partition.scenarioResults.filter((scenario) =>
        expectedScenarioIdSet.has(scenario.scenarioId),
      ),
      startedScenarioIds: expectedScenarioIds,
    } satisfies QaUnifiedPartitionResult;
  };
  const partitionFailed = (partition: QaUnifiedPartitionResult) => {
    if (partition.scenarioResults.some((scenario) => scenario.result.status === "fail")) {
      return true;
    }
    const returnedScenarioIds = new Set(
      partition.scenarioResults.map((scenario) => scenario.scenarioId),
    );
    return partition.startedScenarioIds.some((scenarioId) => !returnedScenarioIds.has(scenarioId));
  };
  const capturePartitionFailure = (
    task: Pick<QaUnifiedPartitionTask, "channelId" | "scenarios">,
    error: unknown,
    started = true,
  ): QaUnifiedPartitionResult => {
    const scenarios = task.scenarios;
    const details = `suite partition failed: ${formatErrorMessage(error)}`;
    const scenarioResults = scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      result: {
        name: scenario.title,
        status: "fail" as const,
        details,
        steps: [{ name: "suite partition", status: "fail" as const, details }],
      },
    }));
    return {
      evidenceSummaries: [
        buildQaSuiteEvidenceSummary({
          artifactPaths: [],
          evidenceMode: params.runParams?.evidenceMode,
          channelId: task.channelId,
          env: process.env,
          generatedAt: new Date().toISOString(),
          primaryModel,
          providerMode,
          repoRoot,
          scenarioDefinitions: scenarios,
          scenarioResults: scenarioResults.map(({ result }) => result),
        }),
      ],
      scenarioResults,
      startedScenarioIds: started ? scenarios.map((scenario) => scenario.id) : [],
      submittedScenarioIds: task.scenarios.map((scenario) => scenario.id),
    };
  };
  const runPartitionTasks = async (tasks: readonly QaUnifiedPartitionTask[], maxWeight: number) => {
    // Retry inside the scheduled task so its weight and exclusive key stay held;
    // one failed channel must not replay partitions that already completed.
    const retryingTasks = tasks.map((task) => ({
      ...task,
      run: async () => {
        try {
          return await runQaSuiteWithInfraRetry(task.run);
        } catch (error) {
          // Failed partitions still own durable failure evidence; rejecting here would
          // discard completed siblings and prevent the unified artifacts from existing.
          return capturePartitionFailure(task, error);
        }
      },
    }));
    return failFast
      ? await mapQaSuiteWithConcurrency(retryingTasks, 1, runFailFastPartition, {
          shouldStop: partitionFailed,
        })
      : await runWeightedUnifiedPartitionTasks(retryingTasks, maxWeight);
  };
  const concurrentPartitionResults = await runPartitionTasks(concurrentPartitionTasks, concurrency);
  const concurrentFailed = failFast && concurrentPartitionResults.some(partitionFailed);
  let scriptPreparationFailure: QaUnifiedPartitionResult | undefined;
  if (!concurrentFailed && scriptScenarios?.some(dockerBatch.isDockerE2eScenario)) {
    try {
      preparedScriptEnv = await dockerBatch.prepareDockerE2eEnvironment({
        env: process.env,
        outputDir,
        repoRoot,
        scenarios: scriptScenarios,
      });
    } catch (error) {
      scriptPreparationFailure = capturePartitionFailure(
        { channelId: transportId, scenarios: scriptScenarios },
        new Error(`Docker candidate preparation failed: ${formatErrorMessage(error)}`),
        false,
      );
      progress?.recordResults(scriptPreparationFailure.scenarioResults);
    }
  }
  // Unmarked scripts may rebuild shared checkout state. Run them exclusively
  // after every flow and native partition settles, then start only audited peers.
  const serialScriptPartitionResults =
    concurrentFailed || scriptPreparationFailure
      ? []
      : await runPartitionTasks(serialScriptPartitionTasks, 1);
  const parallelScriptPartitionResults =
    scriptPreparationFailure || (failFast && serialScriptPartitionResults.some(partitionFailed))
      ? []
      : await runPartitionTasks(
          parallelScriptPartitionTasks,
          Math.min(concurrency, MAX_PARALLEL_SCRIPT_CONCURRENCY),
        );
  const partitionResults = [
    ...concurrentPartitionResults,
    ...(scriptPreparationFailure ? [scriptPreparationFailure] : []),
    ...serialScriptPartitionResults,
    ...parallelScriptPartitionResults,
  ];
  for (const partitionResult of partitionResults) {
    for (const scenarioResult of partitionResult.scenarioResults) {
      const results = scenarioResultsById.get(scenarioResult.scenarioId) ?? [];
      results.push(scenarioResult.result);
      scenarioResultsById.set(scenarioResult.scenarioId, results);
    }
    evidenceSummaries.push(...partitionResult.evidenceSummaries);
  }
  const finishedAt = new Date();
  const mergedEvidence = mergeQaEvidenceSummaries({
    evidenceSummaries,
    generatedAt: finishedAt.toISOString(),
  });
  const scenarioOrder = new Map(
    params.plan.scenarios.map((scenario, index) => [scenario.id, index]),
  );
  const evidence = {
    ...mergedEvidence,
    entries: mergedEvidence.entries.toSorted(
      (left, right) =>
        (scenarioOrder.get(left.test.id) ?? Number.MAX_SAFE_INTEGER) -
        (scenarioOrder.get(right.test.id) ?? Number.MAX_SAFE_INTEGER),
    ),
  };
  const channel = summarizeQaEvidenceChannel([evidence]);
  const scenarios = params.plan.scenarios.flatMap((scenario) => {
    const results = scenarioResultsById.get(scenario.id);
    if (results?.length) {
      return results;
    }
    if (failFast && !startedScenarioIds.has(scenario.id)) {
      return [];
    }
    return [
      {
        name: scenario.title,
        status: "fail",
        details: "suite partition returned no scenario result",
        steps: [
          {
            name: "suite partition",
            status: "fail",
            details: "suite partition returned no scenario result",
          },
        ],
      } satisfies QaSuiteScenarioResult,
    ];
  });
  const unifiedResult = await writeUnifiedQaSuiteArtifacts({
    alternateModel,
    channel: channel?.id,
    channelDriver: channel?.driver,
    concurrency,
    evidence,
    fastMode,
    finishedAt,
    outputDir,
    primaryModel,
    providerMode,
    runtimePair: params.runParams?.runtimePair,
    scenarioIds: params.plan.scenarios.map((scenario) => scenario.id),
    scenarios,
    startedAt,
  });
  const progressResults = params.plan.scenarios.flatMap((scenario) => {
    const results = scenarioResultsById.get(scenario.id);
    if (results?.length) {
      const status: QaSuiteScenarioResult["status"] = results.some(
        (result) => result.status === "fail",
      )
        ? "fail"
        : results.some((result) => result.status === "skip")
          ? "skip"
          : "pass";
      return [
        {
          scenarioId: scenario.id,
          result: {
            name: scenario.title,
            status,
            steps: results.flatMap((result) => result.steps),
          },
        },
      ];
    }
    if (failFast && !startedScenarioIds.has(scenario.id)) {
      return [];
    }
    return [
      {
        scenarioId: scenario.id,
        result: {
          name: scenario.title,
          status: "fail" as const,
          details: "suite partition returned no scenario result",
          steps: [],
        },
      },
    ];
  });
  progress?.complete(progressResults, finishedAt.toISOString());
  params.runParams?.lab?.setLatestReport({
    outputPath: unifiedResult.reportPath,
    markdown: unifiedResult.report,
    generatedAt: finishedAt.toISOString(),
  });
  return {
    ...unifiedResult,
    observedCells: [...observedCellsByKey.values()].toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  };
}

export async function runQaSuite(...args: [QaSuiteRunParams?]): Promise<QaSuiteRuntimeResult> {
  const runParams = args[0];
  const plan = await resolveSuiteExecutionPlan(runParams);
  if (plan.kind === "unified") {
    const { observedCells, ...result } = await runUnifiedQaSuite({
      runParams,
      plan,
    });
    return {
      executionKind: "suite",
      expectedCells: plan.expectedCells,
      observedCells,
      result,
    };
  }
  const result = await runQaSuiteWithInfraRetry(() => runQaFlowSuiteFromRuntime(...args));
  const startedScenarioIds = new Set(result.startedScenarioIds);
  return {
    executionKind: "flow",
    expectedCells: plan.expectedCells,
    observedCells: plan.expectedCells.filter((cell) => startedScenarioIds.has(cell.scenarioId)),
    result,
  };
}

export async function runQaFlowSuiteFromRuntime(
  ...args: [QaSuiteRunParams?]
): Promise<QaSuiteResult> {
  return await (
    await loadQaFlowSuiteRuntime()
  )(args[0]);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
