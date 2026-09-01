import path from "node:path";
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabServerHandle,
} from "./lab-server.types.js";
import type { QaProviderMode } from "./model-selection.js";
import { sanitizeQaProgressValue as sanitizeQaSuiteProgressValue } from "./progress-format.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import type { QaTransportAdapterFactory, QaTransportId } from "./qa-transport-registry.js";
import {
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
} from "./runtime-parity.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver, QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import {
  collectQaSuiteTransportPolicy,
  mapQaSuiteWithConcurrency,
  resolveQaSuiteWorkerStartStaggerMs,
  scenarioRequiresControlUi,
} from "./suite-planning.js";
import { buildRuntimeParityScenarioResult } from "./suite-runtime-parity-result.js";
import { remapModelRefForForcedRuntime } from "./suite-support.js";
import type {
  QaSuiteRunParams,
  QaSuiteRunner,
  QaSuiteScenarioResult,
  QaSuiteStartLabFn,
  QaSuiteResult,
} from "./suite-types.js";
import {
  createQaSuiteTransportAdapter,
  markQaSuiteNestedRun,
  requireQaSuiteStartLab,
  runQaSuiteCleanupSteps,
  throwQaSuiteCleanupErrors,
  writeQaSuiteProgress,
} from "./suite.js";

export async function runQaRuntimeParitySuite(params: {
  runQaFlowSuite: QaSuiteRunner;
  adapterOptions?: QaSuiteRunParams["adapterOptions"];
  adapterFactories?: readonly QaTransportAdapterFactory[];
  channelId?: string;
  evidenceMode?: QaScorecardEvidenceMode;
  repoRoot: string;
  outputDir: string;
  startedAt: Date;
  providerMode: QaProviderMode;
  transportId: QaTransportId;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  controlUiEnabled?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  enabledPluginIds?: string[];
  channelDriver?: QaScorecardChannelDriver | null;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  concurrency: number;
  selectedScenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
  startLab?: QaSuiteStartLabFn;
  lab?: QaLabServerHandle;
  progressEnabled: boolean;
  scenarioIds?: readonly string[];
  runtimePair: [RuntimeId, RuntimeId];
  mutateConfig?: QaSuiteRunParams["mutateConfig"];
  writeEvidenceFile?: boolean;
}) {
  const ownsLab = !params.lab;
  const startLab = requireQaSuiteStartLab(params.startLab);
  const lab =
    params.lab ??
    (await startLab({
      repoRoot: params.repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  const transportFactoryResult = await createQaSuiteTransportAdapter({
    adapterFactories: params.adapterFactories,
    channelDriver: params.channelDriver,
    channelId: params.channelId,
    channelDriverSelection: params.channelDriverSelection,
    adapterOptions: params.adapterOptions,
    cleanupOnFailure: ownsLab ? () => lab.stop() : undefined,
    outputDir: params.outputDir,
    transportPolicy: collectQaSuiteTransportPolicy(params.selectedScenarios),
    state: lab.state,
    transportId: params.transportId,
  });
  const transport = transportFactoryResult.adapter;
  const liveScenarioOutcomes: QaLabScenarioOutcome[] = params.selectedScenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.title,
    status: "pending",
  }));
  lab.setScenarioRun({
    kind: "suite",
    status: "running",
    startedAt: params.startedAt.toISOString(),
    scenarios: [...liveScenarioOutcomes],
  });

  let runFailed = false;
  let runError: unknown;
  let parentTransportCleaned = false;
  let terminalScenarios: QaSuiteScenarioResult[] | undefined;
  let publishTerminalResult: (() => Promise<QaSuiteResult>) | undefined;
  const startedScenarioIds = new Set<string>();
  try {
    if (params.channelDriver === "live") {
      // The parent only contributes aggregate metadata; release its exclusive
      // live credential before runtime cells acquire the same transport lease.
      await transportFactoryResult.cleanupWithoutGateway();
      parentTransportCleaned = true;
    }
    const scenarios = await mapQaSuiteWithConcurrency(
      params.selectedScenarios,
      params.concurrency,
      async (scenario, index): Promise<QaSuiteScenarioResult> => {
        const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
        writeQaSuiteProgress(
          params.progressEnabled,
          `runtime pair start (${index + 1}/${params.selectedScenarios.length}): ${scenarioIdForLog}`,
        );
        liveScenarioOutcomes[index] = {
          id: scenario.id,
          name: scenario.title,
          status: "running",
          startedAt: new Date().toISOString(),
        };
        lab.setScenarioRun({
          kind: "suite",
          status: "running",
          startedAt: params.startedAt.toISOString(),
          scenarios: [...liveScenarioOutcomes],
        });

        const parity = await runRuntimeParityScenario({
          scenarioId: scenario.id,
          runtimeParityUsage: scenario.runtimeParityUsage,
          runtimePair: params.runtimePair,
          runCell: async (runtime) => {
            const cellOutputDir = path.join(
              params.outputDir,
              "runtime-cells",
              scenario.id,
              runtime,
            );
            const cellStartedAt = Date.now();
            const cellResult = await params.runQaFlowSuite(
              markQaSuiteNestedRun({
                adapterFactories: params.adapterFactories,
                channelId: params.channelId,
                adapterOptions: params.adapterOptions,
                repoRoot: params.repoRoot,
                outputDir: cellOutputDir,
                providerMode: params.providerMode,
                transportId: params.transportId,
                channelDriver: params.channelDriver ?? undefined,
                channelDriverSelection: params.channelDriverSelection,
                primaryModel: remapModelRefForForcedRuntime({
                  modelRef: params.primaryModel,
                  providerMode: params.providerMode,
                  forcedRuntime: runtime,
                }),
                alternateModel: remapModelRefForForcedRuntime({
                  modelRef: params.alternateModel,
                  providerMode: params.providerMode,
                  forcedRuntime: runtime,
                }),
                fastMode: params.fastMode,
                thinkingDefault: params.thinkingDefault,
                claudeCliAuthMode: params.claudeCliAuthMode,
                scenarioIds: [scenario.id],
                concurrency: 1,
                enabledPluginIds: params.enabledPluginIds,
                startLab,
                controlUiEnabled: params.controlUiEnabled ?? scenarioRequiresControlUi(scenario),
                mutateConfig: params.mutateConfig,
                forcedRuntime: runtime,
                captureRuntimeParityCell: true,
                writeEvidenceFile: params.writeEvidenceFile,
              }),
            );
            for (const startedScenarioId of cellResult.startedScenarioIds) {
              startedScenarioIds.add(startedScenarioId);
            }
            const scenarioResult =
              cellResult.scenarios[0] ??
              ({
                name: scenario.title,
                status: "fail",
                details: "runtime parity cell returned no scenario result",
                steps: [
                  {
                    name: "runtime parity cell",
                    status: "fail",
                    details: "runtime parity cell returned no scenario result",
                  },
                ],
              } satisfies QaSuiteScenarioResult);
            const fallbackCell = {
              runtime,
              transcriptBytes: "",
              toolCalls: [],
              finalText: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
              wallClockMs: Math.max(1, Date.now() - cellStartedAt),
              runtimeErrorClass: "capture-missing",
              bootStateLines: [],
            } satisfies RuntimeParityCell;
            return {
              status: scenarioResult.status,
              details: scenarioResult.details,
              cell: cellResult.runtimeParityCell ?? fallbackCell,
            };
          },
        });

        const parityScenarioResult = buildRuntimeParityScenarioResult({
          scenarioName: scenario.title,
          result: parity,
        });
        liveScenarioOutcomes[index] = {
          id: scenario.id,
          name: scenario.title,
          status: parityScenarioResult.status,
          details: parityScenarioResult.details,
          steps: parityScenarioResult.steps,
          startedAt: liveScenarioOutcomes[index]?.startedAt,
          finishedAt: new Date().toISOString(),
        };
        lab.setScenarioRun({
          kind: "suite",
          status: "running",
          startedAt: params.startedAt.toISOString(),
          scenarios: [...liveScenarioOutcomes],
        });
        writeQaSuiteProgress(
          params.progressEnabled,
          `runtime pair ${parityScenarioResult.status} (${index + 1}/${params.selectedScenarios.length}): ${scenarioIdForLog}`,
        );
        return parityScenarioResult;
      },
      {
        startStaggerMs: resolveQaSuiteWorkerStartStaggerMs(params.concurrency),
      },
    );

    terminalScenarios = scenarios;
    publishTerminalResult = async () => {
      const finishedAt = new Date();
      const { evidence, evidencePath, report, reportPath, summaryPath } =
        await writeQaSuiteArtifacts({
          repoRoot: params.repoRoot,
          outputDir: params.outputDir,
          startedAt: params.startedAt,
          finishedAt,
          scenarios,
          scenarioDefinitions: params.selectedScenarios,
          evidenceMode: params.evidenceMode,
          transport,
          providerMode: params.providerMode,
          primaryModel: params.primaryModel,
          alternateModel: params.alternateModel,
          fastMode: params.fastMode,
          concurrency: params.concurrency,
          channel: params.channelId ?? params.channelDriverSelection?.channel ?? transport.id,
          channelDriver: transportFactoryResult.driver,
          channelDriverSelection: params.channelDriverSelection,
          scenarioIds:
            params.scenarioIds && params.scenarioIds.length > 0
              ? params.selectedScenarios.map((scenario) => scenario.id)
              : undefined,
          runtimePair: params.runtimePair,
          writeEvidenceFile: params.writeEvidenceFile,
        });
      lab.setLatestReport({
        outputPath: reportPath,
        markdown: report,
        generatedAt: finishedAt.toISOString(),
      } satisfies QaLabLatestReport);
      lab.setScenarioRun({
        kind: "suite",
        status: "completed",
        startedAt: params.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });
      return {
        outputDir: params.outputDir,
        evidence,
        evidencePath,
        reportPath,
        summaryPath,
        report,
        scenarios,
        startedScenarioIds: params.selectedScenarios
          .map((scenario) => scenario.id)
          .filter((scenarioId) => startedScenarioIds.has(scenarioId)),
        watchUrl: lab.baseUrl,
      } satisfies QaSuiteResult;
    };
  } catch (error) {
    runFailed = true;
    runError = error;
    throw error;
  } finally {
    const cleanupFailures = await runQaSuiteCleanupSteps([
      ...(!parentTransportCleaned
        ? [{ phase: "parent transport", run: () => transportFactoryResult.cleanupWithoutGateway() }]
        : []),
      ...(ownsLab ? [{ phase: "lab stop", run: () => lab.stop() }] : []),
    ]);
    throwQaSuiteCleanupErrors({
      cleanupFailures,
      runFailed,
      runError,
      scenarios: terminalScenarios,
    });
  }
  if (!publishTerminalResult) {
    throw new Error("QA runtime parity suite completed without a result");
  }
  const result = await publishTerminalResult();
  writeQaSuiteProgress(params.progressEnabled, "run complete");
  return result;
}
