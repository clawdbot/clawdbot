import path from "node:path";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaLabLatestReport, QaLabScenarioOutcome } from "./lab-server.types.js";
import { sanitizeQaProgressValue as sanitizeQaSuiteProgressValue } from "./progress-format.js";
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
          channelDriver: params?.channelDriver,
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
  try {
    if (params?.channelDriver === "live") {
      // The parent only renders aggregate artifacts. Release its live credentials
      // before child workers acquire the same exclusive transport lease.
      parentTransportCleaned = true;
      await transportFactoryResult.cleanupWithoutGateway();
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
          const result: QaSuiteResult = await runQaFlowSuite(
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
          const scenarioResult: QaSuiteScenarioResult =
            result.scenarios[0] ??
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
            `scenario ${scenarioResult.status} (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
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
            `scenario fail (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
          );
          completedScenarioResults[index] = scenarioResult;
          writePartialArtifacts();
          return scenarioResult;
        }
      },
      {
        startStaggerMs: workerStartStaggerMs,
        shouldStop: (result) => params?.failFast === true && result.status === "fail",
      },
    );
    await artifactWriteQueue;
    const finishedAt = new Date();
    const failedCount = scenarios.filter((scenario) => scenario.status === "fail").length;
    const skippedCount = scenarios.filter((scenario) => scenario.status === "skip").length;
    lab.setScenarioRun({
      kind: "suite",
      status: "completed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      scenarios: [...liveScenarioOutcomes],
    });
    const { evidence, evidencePath, report, reportPath, summaryPath } = await writeQaSuiteArtifacts(
      {
        repoRoot,
        outputDir,
        startedAt,
        finishedAt,
        scenarios,
        scenarioDefinitions: selectedScenarios,
        evidenceMode: params?.evidenceMode,
        transport,
        providerMode,
        primaryModel,
        alternateModel,
        fastMode,
        concurrency,
        channelDriver: params?.channelDriver,
        channelDriverSelection: params?.channelDriverSelection,
        isolatedWorkers: true,
        writeEvidenceFile: params?.writeEvidenceFile,
        // When the caller supplied an explicit non-empty --scenario filter,
        // record the executed (post-selectQaFlowSuiteScenarios-normalized) ids
        // so the summary matches what actually ran. When the caller passed
        // nothing or an empty array ("no filter, full lane catalog"),
        // preserve the unfiltered = null semantic so the summary stays
        // distinguishable from an explicit all-scenarios selection.
        scenarioIds:
          params?.scenarioIds && params.scenarioIds.length > 0
            ? selectedScenarios.map((scenario) => scenario.id)
            : undefined,
      },
    );
    lab.setLatestReport({
      outputPath: reportPath,
      markdown: report,
      generatedAt: finishedAt.toISOString(),
    } satisfies QaLabLatestReport);
    writeQaSuiteProgress(
      progressEnabled,
      `run complete: passed=${scenarios.length - failedCount - skippedCount} failed=${failedCount} skipped=${skippedCount} total=${scenarios.length}`,
    );
    return {
      outputDir,
      evidence,
      evidencePath,
      reportPath,
      summaryPath,
      report,
      scenarios,
      watchUrl: lab.baseUrl,
    } satisfies QaSuiteResult;
  } catch (error) {
    isolatedRunFailed = true;
    isolatedRunError = error;
    throw error;
  } finally {
    const cleanupSteps: Array<() => Promise<void>> = [
      ...(!parentTransportCleaned ? [() => transportFactoryResult.cleanupWithoutGateway()] : []),
      () => disposeRegisteredAgentHarnesses(),
    ];
    if (ownsLab) {
      cleanupSteps.push(() => lab.stop());
    }
    const cleanupErrors = await runQaSuiteCleanupSteps(cleanupSteps);
    throwQaSuiteCleanupErrors({
      cleanupErrors,
      runFailed: isolatedRunFailed,
      runError: isolatedRunError,
    });
  }
}
