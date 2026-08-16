import path from "node:path";
import {
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
  qaTransportSupportsModuleFlows,
} from "./qa-transport-registry.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { resolveRequestedQaSuiteModels } from "./suite-model-selection.js";
import {
  collectQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteOutputDir,
  selectQaFlowSuiteScenarios,
} from "./suite-planning.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import { shouldCaptureGatewayHeapCheckpoints } from "./suite-support.js";
import type { QaSuiteResolvedRunContext, QaSuiteResult, QaSuiteRunParams } from "./suite-types.js";
import {
  formatQaSuiteRunStartProgress,
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
  const enabledPluginIds = [
    ...new Set([
      ...collectQaSuitePluginIds(selectedScenarios),
      ...(params?.enabledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean),
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
  const concurrency = params?.failFast
    ? 1
    : normalizeQaSuiteConcurrency(
        params?.concurrency,
        selectedScenarios.length,
        params?.channelDriverSelection ? 1 : defaultQaSuiteConcurrencyForTransport(transportId),
      );
  const progressEnabled = shouldLogQaSuiteProgress();
  const context: QaSuiteResolvedRunContext = {
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
      adapterFactories: params.adapterFactories,
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
      mutateConfig: params.mutateConfig,
      writeEvidenceFile: params.writeEvidenceFile,
    });
  }
  return useIsolatedScenarioWorkers
    ? await runQaFlowSuiteIsolated(params, context, runQaFlowSuiteFromRuntime)
    : await runQaFlowSuiteStandard(params, context, runQaSuiteScenarioDefinitionForRuntime);
}
