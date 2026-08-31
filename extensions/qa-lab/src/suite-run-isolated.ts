import path from "node:path";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaLabLatestReport, QaLabScenarioOutcome } from "./lab-server.types.js";
import {
  formatQaScenarioFailureSuffix,
  sanitizeQaProgressValue as sanitizeQaSuiteProgressValue,
} from "./progress-format.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { mapQaSuiteWithConcurrency, resolveQaSuiteWorkerStartStaggerMs } from "./suite-planning.js";
import { buildQaIsolatedScenarioWorkerParams } from "./suite-support.js";
import type {
  QaSuiteResolvedRunContext,
  QaSuiteResult,
  QaSuiteRunner,
  QaSuiteRunParams,
  QaSuiteScenarioResult,
} from "./suite-types.js";
import {
  createQaSuiteTransportAdapter,
  markQaSuiteNestedRun,
  requireQaSuiteStartLab,
  runQaSuiteCleanupSteps,
  throwQaSuiteCleanupErrors,
  writeQaSuiteProgress,
} from "./suite.js";

export async function runQaFlowSuiteIsolated(
  params: QaSuiteRunParams | undefined,
  context: QaSuiteResolvedRunContext,
  runQaFlowSuite: QaSuiteRunner,
): Promise<QaSuiteResult> {
  const {
    startedAt,
    repoRoot,
    outputDir,
    transportId,
    selectedScenarios,
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    concurrency,
    progressEnabled,
  } = context;
  const ownsLab = !params?.lab;
  const startLab = requireQaSuiteStartLab(params?.startLab);
  const lab =
    params?.lab ??
    (await startLab({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  const transportFactoryResult = await createQaSuiteTransportAdapter({
    adapterFactories: params?.adapterFactories,
    channelDriver: params?.channelDriver,
    channelId: params?.channelId,
    channelDriverSelection: params?.channelDriverSelection,
    adapterOptions: {
      ...params?.adapterOptions,
      scenarioIds: selectedScenarios.map((scenario) => scenario.id),
    },
    cleanupOnFailure: ownsLab ? () => lab.stop() : undefined,
    outputDir,
    state: lab.state,
    transportId,
  });
  const transport = transportFactoryResult.adapter;
  const liveScenarioOutcomes: QaLabScenarioOutcome[] = selectedScenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.title,
    status: "pending",
  }));
  const updateScenarioRun = () =>
    lab.setScenarioRun({
      kind: "suite",
      status: "running",
      startedAt: startedAt.toISOString(),
      scenarios: [...liveScenarioOutcomes],
    });
  const completedScenarioResults: Array<QaSuiteScenarioResult | undefined> = Array.from({
    length: selectedScenarios.length,
  });
  const startedScenarioIds = new Set<string>();
  let artifactWriteQueue = Promise.resolve();
  const writePartialArtifacts = () => {
    const partialScenarios = completedScenarioResults.filter(
      (scenario): scenario is QaSuiteScenarioResult => scenario !== undefined,
    );
    const completedScenarioDefinitions = completedScenarioResults.flatMap((scenario, index) =>
      scenario === undefined || selectedScenarios[index] === undefined
        ? []
        : [selectedScenarios[index]],
    );
    if (partialScenarios.length === 0) {
      return;
    }
    artifactWriteQueue = artifactWriteQueue
      .then(async () => {
        const partialFinishedAt = new Date();
        const { report, reportPath } = await writeQaSuiteArtifacts({
          status: "running",
          repoRoot,
          outputDir,
          startedAt,
          finishedAt: partialFinishedAt,
          scenarios: partialScenarios,
          scenarioDefinitions: completedScenarioDefinitions,
          evidenceMode: params?.evidenceMode,
          transport,
          providerMode,
          primaryModel,
          alternateModel,
          fastMode,
          concurrency,
          channel: params?.channelId ?? params?.channelDriverSelection?.channel ?? transport.id,
          channelDriver: transportFactoryResult.driver,
          isolatedWorkers: true,
          writeEvidenceFile: false,
          scenarioIds:
            params?.scenarioIds && params.scenarioIds.length > 0
              ? selectedScenarios.map((scenario) => scenario.id)
              : undefined,
        });
        lab.setLatestReport({
          outputPath: reportPath,
          markdown: report,
          generatedAt: partialFinishedAt.toISOString(),
        } satisfies QaLabLatestReport);
      })
      .catch((error: unknown) => {
        writeQaSuiteProgress(
          progressEnabled,
          `partial artifact write failed: ${sanitizeQaSuiteProgressValue(formatErrorMessage(error))}`,
        );
      });
  };

  let isolatedRunFailed = false;
  let isolatedRunError: unknown;
  let parentTransportCleaned = false;
  let completionProgress: string | undefined;
  let terminalScenarios: QaSuiteScenarioResult[] | undefined;
  try {
    if (params?.channelDriver === "live") {
      // The parent only renders aggregate artifacts. Release its live credentials
      // before child workers acquire the same exclusive transport lease.
      await transportFactoryResult.cleanupWithoutGateway();
      parentTransportCleaned = true;
    }
    updateScenarioRun();
    const workerStartStaggerMs =
      params?.workerStartStaggerMs ?? resolveQaSuiteWorkerStartStaggerMs(concurrency);
    writeQaSuiteProgress(progressEnabled, `scenario start stagger=${workerStartStaggerMs}ms`);
    const scenarios: QaSuiteScenarioResult[] = await mapQaSuiteWithConcurrency(
      selectedScenarios,
      concurrency,
      async (scenario, index): Promise<QaSuiteScenarioResult> => {
        const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
        writeQaSuiteProgress(
          progressEnabled,
          `scenario start (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
        );
        liveScenarioOutcomes[index] = {
          id: scenario.id,
          name: scenario.title,
          status: "running",
          startedAt: new Date().toISOString(),
        };
        updateScenarioRun();
        try {
          const scenarioOutputDir = path.join(outputDir, "scenarios", scenario.id);
          const workerParams = markQaSuiteNestedRun(
            buildQaIsolatedScenarioWorkerParams({
              repoRoot,
              outputDir: scenarioOutputDir,
              providerMode,
              transportId,
              channelDriver: params?.channelDriver,
              channelDriverSelection: params?.channelDriverSelection,
              primaryModel,
              alternateModel,
              fastMode,
              startLab,
              scenario,
              input: params,
            }),
          );
          startedScenarioIds.add(scenario.id);
          const childSuiteResult: QaSuiteResult = await runQaFlowSuite(workerParams);
          for (const scenarioId of childSuiteResult.startedScenarioIds) {
            startedScenarioIds.add(scenarioId);
          }
          const scenarioResult: QaSuiteScenarioResult =
            childSuiteResult.scenarios[0] ??
            ({
              name: scenario.title,
              status: "fail",
              details: "isolated scenario run returned no scenario result",
              steps: [
                {
                  name: "isolated scenario worker",
                  status: "fail",
                  details: "isolated scenario run returned no scenario result",
                },
              ],
            } satisfies QaSuiteScenarioResult);
          liveScenarioOutcomes[index] = {
            id: scenario.id,
            name: scenario.title,
            status: scenarioResult.status,
            details: scenarioResult.details,
            steps: scenarioResult.steps,
            startedAt: liveScenarioOutcomes[index]?.startedAt,
            finishedAt: new Date().toISOString(),
          };
          updateScenarioRun();
          writeQaSuiteProgress(
            progressEnabled,
            `scenario ${scenarioResult.status} (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}${formatQaScenarioFailureSuffix(scenarioResult)}`,
          );
          completedScenarioResults[index] = scenarioResult;
          writePartialArtifacts();
          return scenarioResult;
        } catch (error) {
          const details = formatErrorMessage(error);
          const scenarioResult = {
            name: scenario.title,
            status: "fail",
            details,
            steps: [
              {
                name: "isolated scenario worker",
                status: "fail",
                details,
              },
            ],
          } satisfies QaSuiteScenarioResult;
          liveScenarioOutcomes[index] = {
            id: scenario.id,
            name: scenario.title,
            status: "fail",
            details,
            steps: scenarioResult.steps,
            startedAt: liveScenarioOutcomes[index]?.startedAt,
            finishedAt: new Date().toISOString(),
          };
          updateScenarioRun();
          writeQaSuiteProgress(
            progressEnabled,
            `scenario fail (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}${formatQaScenarioFailureSuffix(scenarioResult)}`,
          );
          completedScenarioResults[index] = scenarioResult;
          writePartialArtifacts();
          return scenarioResult;
        }
      },
      {
        startStaggerMs: workerStartStaggerMs,
        shouldStop: (scenarioResult) =>
          params?.failFast === true && scenarioResult.status === "fail",
      },
    );
    await artifactWriteQueue;
    terminalScenarios = scenarios;
    completionProgress = "run complete";
  } catch (error) {
    isolatedRunFailed = true;
    isolatedRunError = error;
    throw error;
  } finally {
    const cleanupSteps = [
      ...(!parentTransportCleaned
        ? [{ phase: "parent transport", run: () => transportFactoryResult.cleanupWithoutGateway() }]
        : []),
      { phase: "agent harnesses", run: () => disposeRegisteredAgentHarnesses() },
    ];
    if (ownsLab) {
      cleanupSteps.push({ phase: "lab stop", run: () => lab.stop() });
    }
    const cleanupFailures = await runQaSuiteCleanupSteps(cleanupSteps);
    throwQaSuiteCleanupErrors({
      cleanupFailures,
      runFailed: isolatedRunFailed,
      runError: isolatedRunError,
      scenarios: terminalScenarios,
    });
  }
  if (!terminalScenarios || !completionProgress) {
    throw new Error("QA suite completed without terminal result metadata");
  }
  const terminalFinishedAt = new Date();
  const { evidence, evidencePath, report, reportPath, summaryPath } = await writeQaSuiteArtifacts({
    repoRoot,
    outputDir,
    startedAt,
    finishedAt: terminalFinishedAt,
    scenarios: terminalScenarios,
    scenarioDefinitions: selectedScenarios,
    evidenceMode: params?.evidenceMode,
    transport,
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    concurrency,
    channel: params?.channelId ?? params?.channelDriverSelection?.channel ?? transport.id,
    channelDriver: transportFactoryResult.driver,
    channelDriverSelection: params?.channelDriverSelection,
    isolatedWorkers: true,
    writeEvidenceFile: params?.writeEvidenceFile,
    scenarioIds:
      params?.scenarioIds && params.scenarioIds.length > 0
        ? selectedScenarios.map((scenario) => scenario.id)
        : undefined,
  });
  lab.setLatestReport({
    outputPath: reportPath,
    markdown: report,
    generatedAt: terminalFinishedAt.toISOString(),
  } satisfies QaLabLatestReport);
  lab.setScenarioRun({
    kind: "suite",
    status: "completed",
    startedAt: startedAt.toISOString(),
    finishedAt: terminalFinishedAt.toISOString(),
    scenarios: [...liveScenarioOutcomes],
  });
  const result = {
    outputDir,
    evidence,
    evidencePath,
    reportPath,
    summaryPath,
    report,
    scenarios: terminalScenarios,
    startedScenarioIds: [...startedScenarioIds],
    watchUrl: lab.baseUrl,
  } satisfies QaSuiteResult;
  writeQaSuiteProgress(progressEnabled, completionProgress);
  return result;
}
