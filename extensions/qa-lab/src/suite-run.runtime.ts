import path from "node:path";
import {
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
  prepareQaTransportAdapterFactories,
  qaTransportSupportsModuleFlows,
} from "./qa-transport-registry.js";
import { captureQaRunComparisonIdentity } from "./run-comparability.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells } from "./scenario-lane.js";
import { invalidateQaSuiteArtifactGeneration } from "./suite-artifacts.js";
import { resolveRequestedQaSuiteModels } from "./suite-model-selection.js";
import {
  collectQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteOutputDir,
  resolveQaSuiteWorkerStartStaggerMs,
  selectQaFlowSuiteScenarios,
} from "./suite-planning.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import { shouldCaptureGatewayHeapCheckpoints } from "./suite-support.js";
import type { QaSuiteResolvedRunContext, QaSuiteResult, QaSuiteRunParams } from "./suite-types.js";
import {
  formatQaSuiteRunStartProgress,
  isQaSuiteNestedRun,
  markQaSuiteNestedRun,
  resolveQaSuiteTransportReadyTimeoutMs,
  runQaSuiteScenarioDefinitionForRuntime,
  shouldLogQaSuiteProgress,
  shouldRunQaSuiteWithIsolatedScenarioWorkers,
  writeQaSuiteProgress,
} from "./suite.js";

export async function runQaFlowSuiteFromRuntime(params?: QaSuiteRunParams): Promise<QaSuiteResult> {
  const startedAt = new Date();
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const catalog = readQaBootstrapScenarioCatalog();
  const requestedModels = resolveRequestedQaSuiteModels({
    ...params,
    scenarios: catalog.scenarios,
  });
  const transportId = normalizeQaTransportId(params?.transportId);
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params?.outputDir);
  const channelDriver = params?.channelDriver ?? params?.channelDriverSelection?.channelDriver;
  const selectedScenarios = selectQaFlowSuiteScenarios({
    scenarios: catalog.scenarios,
    scenarioIds: params?.scenarioIds,
    providerMode: requestedModels.providerMode,
    primaryModel: requestedModels.primaryModel,
    channelDriver,
    channel: params?.channelId ?? params?.channelDriverSelection?.channel,
    claudeCliAuthMode: params?.claudeCliAuthMode,
    resolveModuleFlowSupport: (channel) =>
      qaTransportSupportsModuleFlows(params?.adapterFactories, {
        channelId: channel ?? params?.channelId ?? transportId,
        driver: channelDriver ?? transportId,
      }),
  });
  if (selectedScenarios.length === 0) {
    throw new Error(
      "QA suite selected no runnable scenarios; check the scenario catalog and provider, model, or channel filters.",
    );
  }
  const { alternateModel, fastMode, primaryModel, providerMode } = requestedModels;
  if (
    params?.roundTripProbe &&
    !selectedScenarios.some((scenario) => scenario.id === params.roundTripProbe?.scenarioId)
  ) {
    throw new Error(
      `QA round-trip probe scenario is not selected: ${params.roundTripProbe.scenarioId}`,
    );
  }
  if (params?.roundTripProbe && params.runtimePair) {
    throw new Error("QA round-trip probes are not supported with runtime-pair runs.");
  }
  await invalidateQaSuiteArtifactGeneration(outputDir);
  const concurrency = params?.failFast
    ? 1
    : normalizeQaSuiteConcurrency(
        params?.concurrency,
        selectedScenarios.length,
        params?.channelDriverSelection ? 1 : defaultQaSuiteConcurrencyForTransport(transportId),
      );
  const preparedParams = {
    ...params,
    transportReadyTimeoutMs: resolveQaSuiteTransportReadyTimeoutMs(params?.transportReadyTimeoutMs),
    workerStartStaggerMs:
      params?.workerStartStaggerMs ?? resolveQaSuiteWorkerStartStaggerMs(concurrency),
    adapterFactories: await prepareQaTransportAdapterFactories({
      factories: params?.adapterFactories,
      driver: channelDriver,
      cells: expandQaScenarioExecutionCells({
        scenarios: selectedScenarios,
        channelDriver: channelDriver ?? transportId,
        channel: params?.channelId ?? params?.channelDriverSelection?.channel,
        expandChannels: false,
      }),
    }),
  };
  // Preparation copies params, so carry the child's publication ownership to the new object.
  if (isQaSuiteNestedRun(params)) {
    markQaSuiteNestedRun(preparedParams);
  }
  const requestedPluginIds = [
    ...new Set([
      ...collectQaSuitePluginIds(selectedScenarios),
      ...(params?.enabledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean),
    ]),
  ];
  const enabledPluginIds = [
    ...new Set([
      ...requestedPluginIds,
      ...(params?.forcedRuntime && params.forcedRuntime !== "openclaw"
        ? [params.forcedRuntime]
        : []),
    ]),
  ];
  const gatewayConfigPatches = collectQaSuiteGatewayConfigPatches(
    selectedScenarios,
    params?.adapterOptions?.sutAccountId?.trim() ||
      (channelDriver === "crabline" ? "default" : "sut"),
  );
  const gatewayRuntimeOptions = collectQaSuiteGatewayRuntimeOptions(selectedScenarios);
  const usesCanonicalLab =
    !params?.lab &&
    (!params?.startLab || params.startLab === (await import("./lab-server.js")).startQaLabServer);
  const progressEnabled = shouldLogQaSuiteProgress();
  const context: QaSuiteResolvedRunContext = {
    // Injected lab, SUT, adapter, and config implementations are not bound to this revision.
    comparisonIdentity:
      !usesCanonicalLab ||
      params?.runtimePair ||
      params?.sutOpenClawCommand ||
      params?.mutateConfig ||
      params?.adapterFactories?.length ||
      params?.adapterOptions
        ? undefined
        : captureQaRunComparisonIdentity({
            repoRoot,
            scenarios: selectedScenarios,
            harness: params?.forcedRuntime ?? "openclaw",
            runProfile: {
              os: process.platform,
              architecture: process.arch,
              nodeVersion: process.version,
              transportId,
              channelDriver,
              channel: params?.channelId ?? params?.channelDriverSelection?.channel,
              providerMode,
              fastMode,
              concurrency,
              transportReadyTimeoutMs: preparedParams.transportReadyTimeoutMs,
              workerStartStaggerMs: preparedParams.workerStartStaggerMs,
              // The selected runtime's implicit plugin is a comparison dimension, not a task setting.
              enabledPluginIds: requestedPluginIds,
              thinking: params?.thinkingDefault,
              cliAuthMode: params?.claudeCliAuthMode,
              controlUiEnabled: params?.controlUiEnabled,
              failFast: params?.failFast,
              roundTripProbe: params?.roundTripProbe,
              agentIdentity: catalog.agentIdentityMarkdown,
              kickoffTask: catalog.kickoffTask,
            },
          }),
    startedAt,
    repoRoot,
    outputDir,
    transportId,
    selectedScenarios,
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    channelDriver,
    enabledPluginIds,
    gatewayConfigPatches,
    gatewayRuntimeOptions,
    concurrency,
    progressEnabled,
    gatewayHeapCheckpointsEnabled: shouldCaptureGatewayHeapCheckpoints(),
  };
  writeQaSuiteProgress(
    progressEnabled,
    formatQaSuiteRunStartProgress({
      selectedScenarioCount: selectedScenarios.length,
      concurrency,
      transportId,
      channelDriver: params?.channelDriver,
      channelDriverSelection: params?.channelDriverSelection,
    }),
  );
  const useIsolatedScenarioWorkers = shouldRunQaSuiteWithIsolatedScenarioWorkers({
    scenarios: selectedScenarios,
    concurrency,
    lab: params?.lab,
    startLab: params?.startLab,
  });
  if (params?.runtimePair) {
    return await runQaRuntimeParitySuite({
      runQaFlowSuite: runQaFlowSuiteFromRuntime,
      adapterFactories: preparedParams.adapterFactories,
      channelId: params.channelId,
      adapterOptions: params.adapterOptions,
      evidenceMode: params.evidenceMode,
      repoRoot,
      outputDir,
      startedAt,
      providerMode,
      transportId,
      channelDriverSelection: params.channelDriverSelection,
      channelDriver: params.channelDriver,
      primaryModel,
      alternateModel,
      fastMode,
      controlUiEnabled: params.controlUiEnabled,
      thinkingDefault: params.thinkingDefault,
      claudeCliAuthMode: params.claudeCliAuthMode,
      enabledPluginIds: params.enabledPluginIds,
      concurrency,
      selectedScenarios,
      startLab: params.startLab,
      lab: params.lab,
      progressEnabled,
      scenarioIds: params.scenarioIds,
      runtimePair: params.runtimePair,
      sutOpenClawCommand: params.sutOpenClawCommand,
      mutateConfig: params.mutateConfig,
      writeEvidenceFile: params.writeEvidenceFile,
    });
  }
  return useIsolatedScenarioWorkers
    ? await runQaFlowSuiteIsolated(preparedParams, context, runQaFlowSuiteFromRuntime)
    : await runQaFlowSuiteStandard(preparedParams, context, runQaSuiteScenarioDefinitionForRuntime);
}
