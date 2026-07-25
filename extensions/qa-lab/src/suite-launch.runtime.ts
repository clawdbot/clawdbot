// Qa Lab plugin module implements suite launch behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRepoRootRelativeRef, toRepoRelativePath } from "./cli-paths.js";
import {
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  buildQaSuiteEvidenceSummary,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { isQaFastModeEnabled } from "./model-selection.js";
import { DEFAULT_QA_PROVIDER_MODE } from "./providers/index.js";
import {
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
} from "./qa-transport-registry.js";
import { renderQaMarkdownReport, type QaReportScenario } from "./report.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./run-config.js";
import {
  readQaBootstrapScenarioCatalog,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import {
  normalizeQaSuiteConcurrency,
  normalizeQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteOutputDir,
  resolveQaSuiteWorkerStartStaggerMs,
  scenarioRequiresIsolatedQaSuiteWorker,
} from "./suite-planning.js";
import {
  buildQaSuiteSummaryJson,
  type QaSuiteResult,
  type QaSuiteRunParams,
  type QaSuiteScenarioResult,
  type QaSuiteSummaryJson,
} from "./suite.js";
import {
  isQaTestFileScenario,
  runQaTestFileScenarios,
  type QaTestFileExecutionKind,
  type QaTestFileScenario,
  type QaTestFileScenarioRunResult,
} from "./test-file-scenario-runner.js";

export type QaSuiteRuntimeResult =
  | {
      executionKind: "flow";
      result: QaSuiteResult;
    }
  | {
      executionKind: "suite";
      result: QaUnifiedSuiteResult;
    };

type QaUnifiedSuiteResult = {
  evidencePath: string;
  outputDir: string;
  report: string;
  reportPath: string;
  scenarios: QaSuiteScenarioResult[];
  summaryPath: string;
};

type QaSuiteExecutionPlan =
  | {
      kind: "flow";
    }
  | {
      kind: "unified";
      scenarios: QaSeedScenarioWithSource[];
      flowScenarios: QaSeedScenarioWithSource[];
      testFileScenariosByKind: Map<QaTestFileExecutionKind, QaTestFileScenario[]>;
    };

const MAX_SHARED_FLOW_PARTITIONS = 4;
const MAX_ISOLATED_FLOW_CONCURRENCY = 8;
const ISOLATED_FLOW_WORKER_START_STAGGER_MS = 1_500;
const CREDENTIAL_POOL_UNAVAILABLE_CODES = new Set(["NO_CREDENTIAL_AVAILABLE", "POOL_EXHAUSTED"]);

type QaUnifiedPartitionResult = {
  evidenceSummaries: QaEvidenceSummaryJson[];
  scenarioResults: Array<{
    result: QaSuiteScenarioResult;
    scenarioId: string;
  }>;
};

type QaUnifiedPartitionTask = {
  exclusiveKey?: string;
  run: () => Promise<QaUnifiedPartitionResult>;
  weight: number;
};

type QaFlowChannelGroup = {
  channel: string | undefined;
  channelId: string | undefined;
  channelDriverSelection: QaSuiteRunParams["channelDriverSelection"];
  isolatesAdapterInstances?: boolean;
  scenarios: QaSeedScenarioWithSource[];
};

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
    const explicitChannel = runParams.channelId?.trim().toLowerCase();
    if (explicitChannel) {
      return [
        {
          channel: explicitChannel,
          channelId: explicitChannel,
          channelDriverSelection: runParams.channelDriverSelection,
          isolatesAdapterInstances: isolatesInstances(explicitChannel),
          scenarios: [...scenarios],
        },
      ];
    }
    const groups = new Map<string | undefined, QaSeedScenarioWithSource[]>();
    for (const scenario of scenarios) {
      const channel = normalizeQaSuiteScenarioChannel(scenario);
      const group = groups.get(channel) ?? [];
      group.push(scenario);
      groups.set(channel, group);
    }
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
  const { OPENCLAW_CRABLINE_DEFAULT_CHANNEL, resolveOpenClawCrablineChannelDriverSelection } =
    await import("@openclaw/crabline");
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
    return { kind: "flow" };
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
  const requiresFlowPartitions =
    channelGroups.length > 1 ||
    channelGroups.some(
      (group) => group.channelId !== undefined && group.channelId !== params?.channelId,
    ) ||
    (flowScenarios.length > 1 && flowScenarios.some(scenarioRequiresIsolatedQaSuiteWorker));
  if (testFileScenariosByKind.size === 0 && !requiresFlowPartitions) {
    return { kind: "flow" };
  }
  return {
    kind: "unified",
    scenarios: selectedScenarios,
    flowScenarios,
    testFileScenariosByKind,
  };
}
async function runQaTestFileSuiteFromRuntime(params: {
  runParams: QaSuiteRunParams | undefined;
  scenarios: readonly QaTestFileScenario[];
}): Promise<QaTestFileScenarioRunResult> {
  const runParams = params.runParams;
  if (runParams?.runtimePair) {
    throw new Error("--runtime-pair requires execution.kind: flow scenarios.");
  }
  if (runParams?.forcedRuntime) {
    throw new Error("forced runtime execution requires execution.kind: flow scenarios.");
  }
  if (runParams?.captureRuntimeParityCell) {
    throw new Error("runtime parity capture requires execution.kind: flow scenarios.");
  }
  const repoRoot = path.resolve(runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, runParams?.outputDir);
  const providerMode = normalizeQaProviderMode(runParams?.providerMode ?? DEFAULT_QA_PROVIDER_MODE);
  const primaryModel = runParams?.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  return await runQaTestFileScenarios({
    evidenceMode: runParams?.evidenceMode,
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
        reject(firstError);
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

function mergeQaEvidenceSummaries(params: {
  evidenceSummaries: readonly QaEvidenceSummaryJson[];
  generatedAt: string;
}) {
  const profiles = [
    ...new Set(
      params.evidenceSummaries
        .map((summary) => summary.profile?.trim())
        .filter((profile): profile is string => Boolean(profile)),
    ),
  ];
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode:
      params.evidenceSummaries.length > 0 &&
      params.evidenceSummaries.every((summary) => summary.evidenceMode === "slim")
        ? "slim"
        : "full",
    entries: params.evidenceSummaries.flatMap((summary) => summary.entries),
    profile: profiles.length === 1 ? profiles[0] : undefined,
  });
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
  const suiteStatus = result.status === "pass" ? "pass" : "fail";
  const stepStatus = result.status === "skipped" ? "skip" : suiteStatus;
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
  channelDriver: QaSuiteRunParams["channelDriver"];
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
  await fs.mkdir(params.outputDir, { recursive: true });
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
  await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence, null, 2)}\n`, "utf8");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
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
}): Promise<QaUnifiedSuiteResult> {
  if (params.plan.testFileScenariosByKind.size > 0) {
    rejectFlowOnlySuiteOptionsForUnifiedRun(params.runParams);
  }
  const startedAt = new Date();
  const repoRoot = path.resolve(params.runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params.runParams?.outputDir);
  const providerMode = normalizeQaProviderMode(
    params.runParams?.providerMode ?? DEFAULT_QA_PROVIDER_MODE,
  );
  const primaryModel =
    params.runParams?.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel =
    params.runParams?.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const fastMode =
    typeof params.runParams?.fastMode === "boolean"
      ? params.runParams.fastMode
      : isQaFastModeEnabled({ primaryModel, alternateModel });
  const transportId = normalizeQaTransportId(params.runParams?.transportId);
  const defaultConcurrency =
    params.runParams?.channelDriver === "crabline" || params.runParams?.channelDriverSelection
      ? 1
      : defaultQaSuiteConcurrencyForTransport(transportId);
  const concurrency = normalizeQaSuiteConcurrency(
    params.runParams?.concurrency,
    params.plan.scenarios.length,
    defaultConcurrency,
  );
  const evidenceSummaries: QaEvidenceSummaryJson[] = [];
  const scenarioResultsById = new Map<string, QaSuiteScenarioResult>();
  const sharedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const isolatedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const testFilePartitionTasks: QaUnifiedPartitionTask[] = [];
  const scriptPartitionTasks: QaUnifiedPartitionTask[] = [];
  const unavailableChannelCredentialDetails = new Map<string, string>();
  if (params.plan.flowScenarios.length > 0) {
    const channelGroups = (
      await resolveQaFlowChannelGroups(params.runParams, params.plan.flowScenarios)
    ).filter((group) => group.scenarios.length > 0);
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
      const sharedFlowPartitions = partitionSharedFlowScenarios(
        sharedFlowScenarios,
        usesContributedChannelDriver && !channelGroup.isolatesAdapterInstances ? 1 : concurrency,
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
        const buildCredentialUnavailableResult = (details: string): QaUnifiedPartitionResult => {
          const blockedResults = partition.scenarios.map((scenario) => ({
            name: scenario.title,
            status: "blocked" as const,
            details,
          }));
          return {
            evidenceSummaries: [
              buildQaSuiteEvidenceSummary({
                artifactPaths: [],
                evidenceMode: params.runParams?.evidenceMode,
                channelId: channelGroup.channelId ?? transportId,
                channelDriver:
                  params.runParams?.channelDriver ??
                  channelGroup.channelDriverSelection?.channelDriver,
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
                name: scenario.title,
                status: "fail",
                details,
                steps: [{ name: "Acquire channel credential", status: "fail", details }],
              },
            })),
          };
        };
        const task = {
          // One channel's credential and Gateway state stay serial unless each adapter create()
          // owns an isolated runtime. Distinct channels may always run together.
          exclusiveKey: channelDriverFlowRequiresExclusiveWorkers
            ? `channel:${channelGroup.channel ?? channelGroup.channelId ?? "default"}`
            : undefined,
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
            const scenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
            for (const [index, scenario] of partition.scenarios.entries()) {
              const scenarioResult = result.scenarios[index];
              if (scenarioResult) {
                scenarioResults.push({ scenarioId: scenario.id, result: scenarioResult });
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
  ) =>
    ({
      weight: 1,
      run: async () => {
        const testFileEvidenceSummaries: QaEvidenceSummaryJson[] = [];
        const testFileScenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
        for (const [kind, testFileScenarios] of scenariosByKind) {
          const result = await runQaTestFileSuiteFromRuntime({
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
          testFileScenarioResults.push(
            ...result.results.map((scenarioResult) => ({
              scenarioId: scenarioResult.scenario.id,
              result: testFileScenarioResultToSuiteScenario(scenarioResult, repoRoot),
            })),
          );
        }
        return {
          evidenceSummaries: testFileEvidenceSummaries,
          scenarioResults: testFileScenarioResults,
        };
      },
    }) satisfies QaUnifiedPartitionTask;
  const concurrentTestFileScenariosByKind = new Map(
    [...params.plan.testFileScenariosByKind].filter(([kind]) => kind !== "script"),
  );
  if (concurrentTestFileScenariosByKind.size > 0) {
    testFilePartitionTasks.push(createTestFilePartitionTask(concurrentTestFileScenariosByKind));
  }
  const scriptScenarios = params.plan.testFileScenariosByKind.get("script");
  if (scriptScenarios?.length) {
    scriptPartitionTasks.push(createTestFilePartitionTask(new Map([["script", scriptScenarios]])));
  }
  const concurrentPartitionTasks = [
    ...sharedFlowPartitionTasks,
    ...testFilePartitionTasks,
    ...isolatedFlowPartitionTasks,
  ];
  const concurrentPartitionResults = await runWeightedUnifiedPartitionTasks(
    concurrentPartitionTasks,
    concurrency,
  );
  // Script scenarios may rebuild the checkout's shared dist tree. Wait until every
  // flow Gateway has stopped so package postbuild cannot invalidate its loaded chunks.
  const scriptPartitionResults = await runWeightedUnifiedPartitionTasks(scriptPartitionTasks, 1);
  const partitionResults = [...concurrentPartitionResults, ...scriptPartitionResults];
  for (const partitionResult of partitionResults) {
    for (const scenarioResult of partitionResult.scenarioResults) {
      scenarioResultsById.set(scenarioResult.scenarioId, scenarioResult.result);
    }
    evidenceSummaries.push(...partitionResult.evidenceSummaries);
  }
  const finishedAt = new Date();
  const evidence = mergeQaEvidenceSummaries({
    evidenceSummaries,
    generatedAt: finishedAt.toISOString(),
  });
  const scenarios = params.plan.scenarios.map((scenario) => {
    const result = scenarioResultsById.get(scenario.id);
    if (result) {
      return result;
    }
    return {
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
    } satisfies QaSuiteScenarioResult;
  });
  return await writeUnifiedQaSuiteArtifacts({
    alternateModel,
    channelDriver: params.runParams?.channelDriver,
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
}

export async function runQaSuite(...args: [QaSuiteRunParams?]): Promise<QaSuiteRuntimeResult> {
  const runParams = args[0];
  const plan = await resolveSuiteExecutionPlan(runParams);
  if (plan.kind === "unified") {
    const result = await runUnifiedQaSuite({
      runParams,
      plan,
    });
    return {
      executionKind: "suite",
      result,
    };
  }
  return {
    executionKind: "flow",
    result: await runQaFlowSuiteFromRuntime(...args),
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
