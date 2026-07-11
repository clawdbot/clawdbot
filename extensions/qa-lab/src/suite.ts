// Qa Lab plugin module implements suite behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createOpenClawCrablineChannelReportNotes,
  runOpenClawCrablineChannelDriverSmoke,
  type OpenClawCrablineChannelDriverSelection,
} from "@openclaw/crabline";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  renderQaMarkdownReport,
  type QaReportCheck,
  type QaReportScenario,
} from "openclaw/plugin-sdk/qa-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { assertQaSuiteArtifactWritten } from "./artifact-assertion.js";
import {
  buildQaSuiteEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import {
  startQaGatewayChild,
  type QaCliBackendAuthMode,
  type QaGatewayChildCommand,
} from "./gateway-child.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import {
  isQaFastModeEnabled,
  normalizeQaProviderMode,
  type QaProviderMode,
} from "./model-selection.js";
import {
  parseQaProgressBooleanEnv as parseQaSuiteBooleanEnv,
  sanitizeQaProgressValue as sanitizeQaSuiteProgressValue,
} from "./progress-format.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import {
  createQaTransportAdapter,
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
  type QaTransportAdapterFactory,
  type QaTransportFactoryContext,
  type QaTransportId,
} from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { defaultQaModelForMode } from "./run-config.js";
import {
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
  type RuntimeParityResult,
} from "./runtime-parity.js";
import {
  readQaBootstrapScenarioCatalog,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import type { QaScorecardChannelDriver, QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import {
  applyQaMergePatch,
  collectQaSuiteGatewayConfigPatch,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuiteTransportPolicy,
  collectQaSuitePluginIds,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteWorkerStartStaggerMs,
  resolveQaSuiteOutputDir,
  scenarioRequiresControlUi,
  selectQaFlowSuiteScenarios,
  shouldUseIsolatedQaSuiteScenarioWorkers,
  splitModelRef,
} from "./suite-planning.js";
import { createQaSuiteScenarioFlowApi } from "./suite-runtime-flow.js";
import { waitForGatewayHealthy, waitForTransportReady } from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { countQaSuiteFailedScenarios, type QaSuiteSummaryJson } from "./suite-summary.js";
import { closeQaWebSessions } from "./web-runtime.js";

type QaSuiteStep = {
  name: string;
  run: () => Promise<string | void>;
};

function resolveQaSuiteControlUiEnabled(params: {
  explicit?: boolean;
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
}) {
  return (
    params.explicit ?? params.scenarios.some((scenario) => scenarioRequiresControlUi(scenario))
  );
}

export type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail";
  steps: QaReportCheck[];
  details?: string;
  runtimeParity?: RuntimeParityResult;
};

type QaSuiteEnvironment = {
  lab: QaLabServerHandle;
  webSessionIds: Set<string>;
} & QaSuiteRuntimeEnv;

export type QaSuiteStartLabFn = (params?: QaLabServerStartParams) => Promise<QaLabServerHandle>;

async function createQaSuiteTransportAdapter(params: {
  adapterOptions?: QaSuiteRunParams["adapterOptions"];
  adapterFactories?: readonly QaTransportAdapterFactory[];
  channelDriver?: QaScorecardChannelDriver | null;
  channelId?: string;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  cleanupOnFailure?: () => Promise<void>;
  outputDir: string;
  transportPolicy?: NonNullable<QaSuiteRunParams["adapterOptions"]>["transportPolicy"];
  state: QaLabServerHandle["state"];
  transportId: QaTransportId;
}) {
  try {
    const usesLiveAdapter =
      params.channelDriver === "live" &&
      params.channelId !== undefined &&
      params.adapterFactories !== undefined;
    return await createQaTransportAdapter(
      {
        channelId: params.channelId ?? params.channelDriverSelection?.channel ?? params.transportId,
        driver: usesLiveAdapter
          ? "live"
          : params.channelDriverSelection
            ? "crabline"
            : params.transportId,
        outputDir: params.outputDir,
        adapterOptions: {
          ...params.adapterOptions,
          ...(params.transportPolicy
            ? {
                transportPolicy: {
                  ...params.adapterOptions?.transportPolicy,
                  ...params.transportPolicy,
                },
              }
            : {}),
        },
        state: params.state,
      },
      usesLiveAdapter ? params.adapterFactories : undefined,
    );
  } catch (error) {
    await params.cleanupOnFailure?.().catch(() => undefined);
    throw error;
  }
}

export type QaSuiteRunParams = {
  adapterOptions?: QaTransportFactoryContext["adapterOptions"];
  adapterFactories?: readonly QaTransportAdapterFactory[];
  channelId?: string;
  evidenceMode?: QaScorecardEvidenceMode;
  repoRoot?: string;
  sutOpenClawCommand?: QaGatewayChildCommand;
  outputDir?: string;
  providerMode?: QaProviderMode;
  transportId?: QaTransportId;
  channelDriver?: QaScorecardChannelDriver;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  scenarioIds?: string[];
  lab?: QaLabServerHandle;
  startLab?: QaSuiteStartLabFn;
  concurrency?: number;
  enabledPluginIds?: string[];
  controlUiEnabled?: boolean;
  transportReadyTimeoutMs?: number;
  workerStartStaggerMs?: number;
  forcedRuntime?: RuntimeId;
  runtimePair?: [RuntimeId, RuntimeId];
  captureRuntimeParityCell?: boolean;
  // Unified suite partitions consume child evidence in memory; only the
  // parent should write the aggregate qa-evidence.json artifact.
  writeEvidenceFile?: boolean;
};

function shouldLogQaSuiteProgress(env: NodeJS.ProcessEnv = process.env) {
  const override = parseQaSuiteBooleanEnv(env.OPENCLAW_QA_SUITE_PROGRESS);
  if (override !== undefined) {
    return override;
  }
  return parseQaSuiteBooleanEnv(env.CI) === true;
}

function resolveQaSuiteTransportReadyTimeoutMs(
  explicitTimeoutMs?: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    typeof explicitTimeoutMs === "number" &&
    Number.isFinite(explicitTimeoutMs) &&
    explicitTimeoutMs > 0
  ) {
    return Math.floor(explicitTimeoutMs);
  }
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  if (!raw) {
    return 120_000;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    return 120_000;
  }
  return parsed;
}

function writeQaSuiteProgress(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  process.stderr.write(`[qa-suite] ${message}\n`);
}

function formatQaSuiteRunStartProgress(params: {
  selectedScenarioCount: number;
  concurrency: number;
  transportId: QaTransportId;
  channelDriver?: QaScorecardChannelDriver | null;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
}) {
  const channelDriver = params.channelDriver ?? params.channelDriverSelection?.channelDriver;
  const channel = params.channelDriverSelection?.channel;
  const parts = [
    `run start: scenarios=${params.selectedScenarioCount}`,
    `concurrency=${params.concurrency}`,
    `transport=${sanitizeQaSuiteProgressValue(params.transportId)}`,
  ];
  if (channelDriver) {
    parts.push(`channelDriver=${sanitizeQaSuiteProgressValue(channelDriver)}`);
  }
  if (channel) {
    parts.push(`channel=${sanitizeQaSuiteProgressValue(channel)}`);
  }
  return parts.join(" ");
}

async function waitForQaLabReady(baseUrl: string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { response, release } = await fetchWithSsrFGuard({
        url: `${baseUrl}/readyz`,
        policy: { allowPrivateNetwork: true },
        auditContext: "qa-lab-suite-wait-for-lab-ready",
      });
      try {
        if (response.ok) {
          return;
        }
      } finally {
        await release();
      }
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for qa-lab ready`);
}

async function waitForQaLabReadyOrStopOwned(params: {
  lab: Pick<QaLabServerHandle, "listenUrl" | "stop">;
  ownsLab: boolean;
  timeoutMs?: number;
}) {
  try {
    await waitForQaLabReady(params.lab.listenUrl, params.timeoutMs);
  } catch (error) {
    if (params.ownsLab) {
      await params.lab.stop();
    }
    throw error;
  }
}

async function runQaSuiteCleanupSteps(steps: ReadonlyArray<() => Promise<void>>) {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwQaSuiteCleanupErrors(params: {
  cleanupErrors: unknown[];
  runFailed: boolean;
  runError: unknown;
}) {
  if (params.cleanupErrors.length === 0) {
    return;
  }
  if (params.cleanupErrors.length === 1 && !params.runFailed) {
    throw params.cleanupErrors[0];
  }
  throw new AggregateError(
    params.runFailed ? [params.runError, ...params.cleanupErrors] : params.cleanupErrors,
    params.runFailed ? "QA suite and cleanup failed" : "QA suite cleanup failed",
    params.runFailed ? { cause: params.runError } : undefined,
  );
}

function requireQaSuiteStartLab(startLab: QaSuiteStartLabFn | undefined): QaSuiteStartLabFn {
  if (startLab) {
    return startLab;
  }
  throw new Error(
    "QA suite requires startLab when no lab handle is provided; use the runtime launcher or pass startLab explicitly.",
  );
}

function shouldRunQaSuiteWithIsolatedScenarioWorkers(params: {
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
  concurrency: number;
  lab?: QaLabServerHandle;
  startLab?: QaSuiteStartLabFn;
}) {
  if (
    !shouldUseIsolatedQaSuiteScenarioWorkers({
      scenarios: params.scenarios,
      concurrency: params.concurrency,
    })
  ) {
    return false;
  }

  if (params.concurrency === 1 && params.lab && !params.startLab) {
    return false;
  }

  return true;
}

const QA_IMAGE_UNDERSTANDING_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAklEQVR4AewaftIAAAK4SURBVO3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+7ciPkoAAAAASUVORK5CYII=";

const QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACuklEQVR4Ae3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+2YE/z8AAAAASUVORK5CYII=";

const QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OoQEAAAyDsP7/9HYGJgJNdtuVDQAAAAAAACAHxH8AAAAAAACAHvBX0fhq85dN7QAAAABJRU5ErkJggg==";

function liveTurnTimeoutMs(
  env: Pick<QaSuiteRuntimeEnv, "providerMode" | "primaryModel" | "alternateModel">,
  fallbackMs: number,
) {
  return resolveQaLiveTurnTimeoutMs(env, fallbackMs);
}

export type QaSuiteResult = {
  evidence?: QaEvidenceSummaryJson;
  outputDir: string;
  evidencePath: string;
  reportPath: string;
  summaryPath: string;
  report: string;
  scenarios: QaSuiteScenarioResult[];
  watchUrl: string;
  runtimeParityCell?: RuntimeParityCell;
};

/**
 * One bounded retry for live-model flake: flow scenarios time out under model
 * latency spikes, so a first failure gets a single rerun. A retry pass keeps
 * the first attempt visible in details; a retry failure keeps the original
 * diagnostics so deterministic regressions still fail the suite.
 */
export async function runQaScenarioWithFlakeRetry(
  run: () => Promise<QaSuiteScenarioResult>,
  onRetry?: () => void,
): Promise<QaSuiteScenarioResult> {
  const first = await run();
  if (first.status !== "fail") {
    return first;
  }
  onRetry?.();
  const second = await run();
  if (second.status !== "pass") {
    return first;
  }
  return {
    ...second,
    details: [second.details, `passed on retry; first attempt: ${first.details ?? "failed"}`]
      .filter(Boolean)
      .join(" | "),
  };
}

async function runScenario(name: string, steps: QaSuiteStep[]): Promise<QaSuiteScenarioResult> {
  const stepResults: QaReportCheck[] = [];
  for (const step of steps) {
    try {
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] start scenario="${name}" step="${step.name}"`);
      }
      const details = await step.run();
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] pass scenario="${name}" step="${step.name}"`);
      }
      stepResults.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatErrorMessage(error);
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] fail scenario="${name}" step="${step.name}" details=${details}`);
      }
      stepResults.push({
        name: step.name,
        status: "fail",
        details,
      });
      return {
        name,
        status: "fail",
        steps: stepResults,
        details,
      };
    }
  }
  return {
    name,
    status: "pass",
    steps: stepResults,
  };
}

function createScenarioFlowApi(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  return createQaSuiteScenarioFlowApi({
    env,
    scenario,
    runScenario,
    splitModelRef,
    formatErrorMessage,
    liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs,
    constants: {
      imageUnderstandingPngBase64: QA_IMAGE_UNDERSTANDING_PNG_BASE64,
      imageUnderstandingLargePngBase64: QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64,
      imageUnderstandingValidPngBase64: QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64,
    },
  });
}

async function runScenarioDefinition(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  const api = createScenarioFlowApi(env, scenario);
  if (!scenario.execution.flow) {
    throw new Error(`scenario missing flow: ${scenario.id}`);
  }
  return await runScenarioFlow({
    api,
    flow: scenario.execution.flow,
    scenarioTitle: scenario.title,
  });
}

function isRuntimeParityPass(result: RuntimeParityResult) {
  return isRuntimeParityResultPass(result);
}

function formatRuntimeParityCellDetails(cell: RuntimeParityCell) {
  const errors = [cell.transportErrorClass, cell.runtimeErrorClass].filter(Boolean).join(", ");
  const sentinels = cell.sentinelFindings?.map((finding) => finding.kind).join(", ");
  return [
    `runtime=${cell.runtime}`,
    `wallMs=${cell.wallClockMs}`,
    `toolCalls=${cell.toolCalls.length}`,
    `finalChars=${cell.finalText.length}`,
    `tokens=${cell.usage.totalTokens}`,
    ...(errors ? [`errors=${errors}`] : []),
    ...(sentinels ? [`sentinels=${sentinels}`] : []),
  ].join(" ");
}

function buildRuntimeParityScenarioResult(params: {
  scenarioName: string;
  result: RuntimeParityResult;
}): QaSuiteScenarioResult {
  const driftStepStatus = isRuntimeParityPass(params.result) ? "pass" : "fail";
  const openclawCell = params.result.cells.openclaw;
  return {
    name: params.scenarioName,
    status: driftStepStatus,
    details: params.result.driftDetails ?? `runtime drift classified as ${params.result.drift}`,
    steps: [
      {
        name: openclawCell.runtime,
        status:
          openclawCell.runtimeErrorClass || openclawCell.transportErrorClass ? "fail" : "pass",
        details: formatRuntimeParityCellDetails(openclawCell),
      },
      {
        name: params.result.cells.codex.runtime,
        status:
          params.result.cells.codex.runtimeErrorClass ||
          params.result.cells.codex.transportErrorClass
            ? "fail"
            : "pass",
        details: formatRuntimeParityCellDetails(params.result.cells.codex),
      },
      {
        name: "runtime drift",
        status: driftStepStatus,
        details: params.result.driftDetails ?? params.result.drift,
      },
    ],
    runtimeParity: params.result,
  };
}

function createQaSuiteReportNotes(params: {
  transport: QaTransportAdapter;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  isolatedWorkers?: boolean;
}) {
  return [
    ...params.transport.createReportNotes(params),
    ...createOpenClawCrablineChannelReportNotes(params.channelDriverSelection),
  ];
}

function buildQaIsolatedScenarioWorkerParams(params: {
  repoRoot: string;
  outputDir: string;
  providerMode: QaProviderMode;
  transportId: QaTransportId;
  channelDriver?: QaScorecardChannelDriver;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];
  input?: QaSuiteRunParams;
  startLab: QaSuiteStartLabFn;
}): QaSuiteRunParams {
  return {
    adapterFactories: params.input?.adapterFactories,
    adapterOptions: params.input?.adapterOptions,
    channelId: params.input?.channelId,
    repoRoot: params.repoRoot,
    sutOpenClawCommand: params.input?.sutOpenClawCommand,
    outputDir: params.outputDir,
    providerMode: params.providerMode,
    transportId: params.transportId,
    channelDriver: params.channelDriver,
    channelDriverSelection: params.channelDriverSelection,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    fastMode: params.fastMode,
    thinkingDefault: params.input?.thinkingDefault,
    claudeCliAuthMode: params.input?.claudeCliAuthMode,
    scenarioIds: [params.scenario.id],
    enabledPluginIds: params.input?.enabledPluginIds,
    concurrency: 1,
    startLab: params.startLab,
    controlUiEnabled: scenarioRequiresControlUi(params.scenario),
    transportReadyTimeoutMs: params.input?.transportReadyTimeoutMs,
    workerStartStaggerMs: params.input?.workerStartStaggerMs,
    forcedRuntime: params.input?.forcedRuntime,
    writeEvidenceFile: params.input?.writeEvidenceFile,
  };
}

function normalizeQaSuiteModelRef(input: string | undefined, fallback: string) {
  const model = input?.trim();
  return model && model.length > 0 ? model : fallback;
}

function remapModelRefForForcedRuntime(params: {
  modelRef: string;
  providerMode: QaProviderMode;
  forcedRuntime?: RuntimeId;
}) {
  if (params.forcedRuntime !== "codex" || params.providerMode !== "mock-openai") {
    return params.modelRef;
  }
  const split = splitModelRef(params.modelRef);
  if (!split || split.provider !== "mock-openai") {
    return params.modelRef;
  }
  return `openai/${split.model}`;
}

function buildQaRuntimeEnvPatch(params: {
  providerMode: QaProviderMode;
  forcedRuntime?: RuntimeId;
  mockBaseUrl?: string;
}): NodeJS.ProcessEnv | undefined {
  const patch: NodeJS.ProcessEnv = {};
  if (params.forcedRuntime) {
    patch.OPENCLAW_BUILD_PRIVATE_QA = "1";
    patch.OPENCLAW_QA_FORCE_RUNTIME = params.forcedRuntime;
  }
  if (params.forcedRuntime !== "codex" || params.providerMode !== "mock-openai") {
    return Object.keys(patch).length > 0 ? patch : undefined;
  }
  const mockBaseUrl = params.mockBaseUrl?.trim().replace(/\/+$/u, "");
  if (!mockBaseUrl) {
    return Object.keys(patch).length > 0 ? patch : undefined;
  }
  // The forced codex lane uses the Codex app-server's native OpenAI provider
  // path, so pin the managed app-server to the QA mock endpoint instead of
  // leaking to the maintainer's real OpenAI config.
  patch.OPENCLAW_CODEX_APP_SERVER_ARGS = `app-server -c openai_base_url=${mockBaseUrl}/v1 --listen stdio://`;
  patch.OPENAI_API_KEY = "qa-mock-openai-key";
  patch.CODEX_API_KEY = "qa-mock-openai-key";
  return patch;
}

function appendNodeOption(raw: string | undefined, option: string) {
  const parts = (raw ?? "").split(/\s+/u).filter(Boolean);
  return parts.includes(option) ? parts.join(" ") : [...parts, option].join(" ");
}

function shouldCaptureGatewayHeapCheckpoints(env: NodeJS.ProcessEnv = process.env) {
  return parseQaSuiteBooleanEnv(env.OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS) === true;
}

function buildQaGatewayHeapCheckpointRuntimeEnvPatch(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!shouldCaptureGatewayHeapCheckpoints(env)) {
    return undefined;
  }
  return {
    NODE_OPTIONS: appendNodeOption(env.NODE_OPTIONS, "--heapsnapshot-signal=SIGUSR2"),
  };
}

function mergeQaRuntimeEnvPatches(
  ...patches: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv | undefined {
  const merged: NodeJS.ProcessEnv = {};
  for (const patch of patches) {
    if (!patch) {
      continue;
    }
    Object.assign(merged, patch);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export type QaSuiteSummaryJsonParams = {
  scenarios: QaSuiteScenarioResult[];
  startedAt: Date;
  finishedAt: Date;
  metrics?: QaSuiteSummaryJson["metrics"];
  evidence?: QaSuiteSummaryJson["evidence"];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  channelDriver?: QaScorecardChannelDriver | null;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  scenarioIds?: readonly string[];
  runtimePair?: [RuntimeId, RuntimeId];
};

/**
 * Strongly-typed shape of `qa-suite-summary.json`. The GPT-5.6 Luna parity gate
 * (agentic-parity-report.ts, #64441) and any future parity wrapper can
 * import this type instead of re-declaring the shape, so changes to the
 * summary schema propagate through to every consumer at type-check time.
 */
export type { QaSuiteSummaryJson } from "./suite-summary.js";

type QaSuiteGatewayRssSample = NonNullable<
  NonNullable<QaSuiteSummaryJson["metrics"]>["gatewayProcessRssSamples"]
>[number];

type QaGatewayHandle = Awaited<ReturnType<typeof startQaGatewayChild>>;
type QaSuiteGatewayHeapSnapshot = NonNullable<
  NonNullable<QaSuiteSummaryJson["metrics"]>["gatewayHeapSnapshots"]
>[number];

/**
 * Pure-ish JSON builder for qa-suite-summary.json. Exported so the GPT-5.6 Luna
 * parity gate (agentic-parity-report.ts, #64441) and any future parity
 * runner can assert-and-trust the provider/model that produced a given
 * summary instead of blindly accepting the caller's candidateLabel /
 * baselineLabel. Without the `run` block, a maintainer who swaps candidate
 * and baseline summary paths could silently produce a mislabeled verdict.
 *
 * `scenarioIds` is only recorded when the caller passed a non-empty array
 * (an explicit scenario selection). A missing or empty array means "no
 * filter, full lane-selected catalog", which the summary encodes as `null`
 * so parity/report tooling doesn't mistake a full run for an explicit
 * empty selection.
 */
export function buildQaSuiteSummaryJson(params: QaSuiteSummaryJsonParams): QaSuiteSummaryJson {
  const primarySplit = splitModelRef(params.primaryModel);
  const alternateSplit = splitModelRef(params.alternateModel);
  return {
    scenarios: params.scenarios,
    counts: {
      total: params.scenarios.length,
      passed: params.scenarios.filter((scenario) => scenario.status === "pass").length,
      failed: countQaSuiteFailedScenarios(params.scenarios),
    },
    ...(params.metrics ? { metrics: params.metrics } : {}),
    ...(params.evidence ? { evidence: params.evidence } : {}),
    run: {
      startedAt: params.startedAt.toISOString(),
      finishedAt: params.finishedAt.toISOString(),
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      primaryProvider: primarySplit?.provider ?? null,
      primaryModelName: primarySplit?.model ?? null,
      alternateModel: params.alternateModel,
      alternateProvider: alternateSplit?.provider ?? null,
      alternateModelName: alternateSplit?.model ?? null,
      fastMode: params.fastMode,
      concurrency: params.concurrency,
      channelDriver: params.channelDriver ?? params.channelDriverSelection?.channelDriver ?? null,
      channel: params.channelDriverSelection?.channel ?? null,
      channelCapabilityMatrixPath: params.channelDriverSelection?.capabilityMatrixPath ?? null,
      channelDriverSmokePath: params.channelDriverSelection?.smokeArtifactPath ?? null,
      scenarioIds:
        params.scenarioIds && params.scenarioIds.length > 0 ? [...params.scenarioIds] : null,
      runtimePair: params.runtimePair ?? null,
    },
  };
}

async function runQaRuntimeParitySuite(params: {
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

  try {
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
          runCell: async (runtime) => {
            const cellOutputDir = path.join(
              params.outputDir,
              "runtime-cells",
              scenario.id,
              runtime,
            );
            const cellStartedAt = Date.now();
            const cellResult = await runQaFlowSuite({
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
              controlUiEnabled: scenarioRequiresControlUi(scenario),
              forcedRuntime: runtime,
              captureRuntimeParityCell: true,
            });
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
              scenarioStatus: scenarioResult.status,
              scenarioDetails: scenarioResult.details,
              cell: cellResult.runtimeParityCell ?? fallbackCell,
            };
          },
        });

        const result = buildRuntimeParityScenarioResult({
          scenarioName: scenario.title,
          result: parity,
        });
        liveScenarioOutcomes[index] = {
          id: scenario.id,
          name: scenario.title,
          status: result.status,
          details: result.details,
          steps: result.steps,
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
          `runtime pair ${result.status} (${index + 1}/${params.selectedScenarios.length}): ${scenarioIdForLog}`,
        );
        return result;
      },
      {
        startStaggerMs: resolveQaSuiteWorkerStartStaggerMs(params.concurrency),
      },
    );

    const finishedAt = new Date();
    const { evidence, evidencePath, report, reportPath, summaryPath } = await writeQaSuiteArtifacts(
      {
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
        channelDriver: params.channelDriver,
        channelDriverSelection: params.channelDriverSelection,
        scenarioIds:
          params.scenarioIds && params.scenarioIds.length > 0
            ? params.selectedScenarios.map((scenario) => scenario.id)
            : undefined,
        runtimePair: params.runtimePair,
      },
    );
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
      watchUrl: lab.baseUrl,
    } satisfies QaSuiteResult;
  } finally {
    await transportFactoryResult.cleanup();
    if (ownsLab) {
      await lab.stop();
    }
  }
}

async function writeQaSuiteArtifacts(params: {
  repoRoot?: string;
  outputDir: string;
  startedAt: Date;
  finishedAt: Date;
  scenarios: QaSuiteScenarioResult[];
  scenarioDefinitions?: readonly QaSeedScenarioWithSource[];
  evidenceMode?: QaScorecardEvidenceMode;
  metrics?: QaSuiteSummaryJson["metrics"];
  transport: QaTransportAdapter;
  // Reuse the canonical QaProviderMode union instead of re-declaring it
  // inline. Loop 6 already unified `QaSuiteSummaryJsonParams.providerMode`
  // on this type; keeping the writer in sync prevents drift when model-
  // selection.ts adds a new provider mode.
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  channelDriver?: QaScorecardChannelDriver | null;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  isolatedWorkers?: boolean;
  scenarioIds?: readonly string[];
  runtimePair?: [RuntimeId, RuntimeId];
  writeEvidenceFile?: boolean;
}) {
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const crablineChannelDriverSelection = params.channelDriverSelection;
  const crablineChannelDriverSmoke = crablineChannelDriverSelection
    ? await runOpenClawCrablineChannelDriverSmoke({
        outputDir: params.outputDir,
        selection: crablineChannelDriverSelection,
      })
    : undefined;
  const crablineChannelDriverArtifactPaths = crablineChannelDriverSelection
    ? [
        {
          kind: "channel-capability-matrix",
          path: crablineChannelDriverSelection.capabilityMatrixPath,
        },
        {
          kind: "channel-driver-smoke",
          path: crablineChannelDriverSelection.smokeArtifactPath,
        },
      ]
    : [];
  const report = renderQaMarkdownReport({
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
    notes: createQaSuiteReportNotes(params),
  });
  const evidence =
    params.scenarioDefinitions && params.scenarioDefinitions.length > 0
      ? buildQaSuiteEvidenceSummary({
          artifactPaths: [
            { kind: "summary", path: path.basename(summaryPath) },
            { kind: "report", path: path.basename(reportPath) },
            ...crablineChannelDriverArtifactPaths,
          ],
          evidenceMode: params.evidenceMode,
          channelId: params.channelDriverSelection?.channel ?? params.transport.id,
          channelDriver: params.channelDriver ?? params.channelDriverSelection?.channelDriver,
          env: process.env,
          generatedAt: params.finishedAt.toISOString(),
          primaryModel: params.primaryModel,
          providerMode: params.providerMode,
          repoRoot: params.repoRoot,
          scenarioDefinitions: params.scenarioDefinitions,
          scenarioResults: params.scenarios,
        })
      : undefined;
  if (crablineChannelDriverSelection && crablineChannelDriverSmoke) {
    await fs.writeFile(
      path.join(params.outputDir, crablineChannelDriverSelection.capabilityMatrixPath),
      `${JSON.stringify(
        {
          version: 1,
          source: "openclaw/crabline",
          channelDriver: crablineChannelDriverSelection.channelDriver,
          selectedChannel: crablineChannelDriverSelection.channel,
          manifestPath: crablineChannelDriverSmoke.manifestPath,
          report: crablineChannelDriverSmoke.capabilityReport,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(params.outputDir, crablineChannelDriverSelection.smokeArtifactPath),
      `${JSON.stringify(
        {
          version: 1,
          source: "openclaw/crabline",
          channelDriver: crablineChannelDriverSelection.channelDriver,
          selectedChannel: crablineChannelDriverSelection.channel,
          manifestPath: crablineChannelDriverSmoke.manifestPath,
          smoke: crablineChannelDriverSmoke.smoke,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  const writeEvidenceFile = params.writeEvidenceFile ?? true;
  await fs.writeFile(reportPath, report, "utf8");
  if (evidence && writeEvidenceFile) {
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(buildQaSuiteSummaryJson(params), null, 2)}\n`,
    "utf8",
  );
  await assertQaSuiteArtifactWritten("report", reportPath);
  await assertQaSuiteArtifactWritten("summary", summaryPath);
  if (evidence && writeEvidenceFile) {
    await assertQaSuiteArtifactWritten("evidence", evidencePath);
  }
  return { evidence, evidencePath, report, reportPath, summaryPath };
}

function buildQaSuiteRuntimeMetrics(params: {
  startedAt: Date;
  finishedAt: Date;
  gatewayProcessCpuStartMs: number | null;
  gatewayProcessCpuEndMs: number | null;
  gatewayProcessRssStartBytes: number | null;
  gatewayProcessRssEndBytes: number | null;
  gatewayProcessRssSamples?: QaSuiteGatewayRssSample[];
  gatewayHeapSnapshots?: QaSuiteGatewayHeapSnapshot[];
}): QaSuiteSummaryJson["metrics"] {
  const wallMs = Math.max(1, params.finishedAt.getTime() - params.startedAt.getTime());
  const gatewayProcessRssSamples = params.gatewayProcessRssSamples ?? [];
  const gatewayHeapSnapshots = params.gatewayHeapSnapshots ?? [];
  const gatewayProcessRssPeakBytes =
    gatewayProcessRssSamples.length > 0
      ? Math.max(...gatewayProcessRssSamples.map((sample) => sample.gatewayProcessRssBytes))
      : params.gatewayProcessRssStartBytes === null || params.gatewayProcessRssEndBytes === null
        ? null
        : Math.max(params.gatewayProcessRssStartBytes, params.gatewayProcessRssEndBytes);
  const gatewayHeapSnapshotMetrics =
    gatewayHeapSnapshots.length === 0 ? {} : { gatewayHeapSnapshots };
  const rssMetrics =
    params.gatewayProcessRssStartBytes === null || params.gatewayProcessRssEndBytes === null
      ? gatewayHeapSnapshotMetrics
      : {
          gatewayProcessRssStartBytes: params.gatewayProcessRssStartBytes,
          gatewayProcessRssEndBytes: params.gatewayProcessRssEndBytes,
          gatewayProcessRssDeltaBytes:
            params.gatewayProcessRssEndBytes - params.gatewayProcessRssStartBytes,
          ...(gatewayProcessRssPeakBytes === null
            ? {}
            : {
                gatewayProcessRssPeakBytes,
                gatewayProcessRssPeakDeltaBytes:
                  gatewayProcessRssPeakBytes - params.gatewayProcessRssStartBytes,
              }),
          ...(gatewayProcessRssSamples.length === 0 ? {} : { gatewayProcessRssSamples }),
          ...gatewayHeapSnapshotMetrics,
        };
  if (params.gatewayProcessCpuStartMs === null || params.gatewayProcessCpuEndMs === null) {
    return { wallMs, ...rssMetrics };
  }
  const gatewayProcessCpuMs = Math.max(
    0,
    params.gatewayProcessCpuEndMs - params.gatewayProcessCpuStartMs,
  );
  return {
    wallMs,
    gatewayProcessCpuMs,
    gatewayCpuCoreRatio: Math.round((gatewayProcessCpuMs / wallMs) * 1000) / 1000,
    ...rssMetrics,
  };
}

function sanitizeQaHeapCheckpointLabel(label: string) {
  return label.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "checkpoint";
}

async function listGatewayHeapSnapshotFiles(tempRoot: string) {
  const entries = await fs.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".heapsnapshot")) {
      continue;
    }
    const pathName = path.join(tempRoot, entry.name);
    const stats = await fs.stat(pathName).catch(() => null);
    if (stats) {
      files.push({ pathName, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  return files.toSorted((left, right) => left.mtimeMs - right.mtimeMs);
}

async function waitForStableFileSize(pathName: string) {
  let lastSize = -1;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const stats = await fs.stat(pathName).catch(() => null);
    if (stats && stats.size > 0 && stats.size === lastSize) {
      return stats.size;
    }
    lastSize = stats?.size ?? -1;
    await sleep(250);
  }
  const stats = await fs.stat(pathName);
  return stats.size;
}

async function captureGatewayHeapSnapshotCheckpoint(params: {
  gateway: QaGatewayHandle;
  outputDir: string;
  label: string;
}): Promise<QaSuiteGatewayHeapSnapshot | undefined> {
  const before = new Set(
    (await listGatewayHeapSnapshotFiles(params.gateway.tempRoot)).map((file) => file.pathName),
  );
  await params.gateway.signalProcess("SIGUSR2");
  let snapshotPath: string | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const next = (await listGatewayHeapSnapshotFiles(params.gateway.tempRoot)).filter(
      (file) => !before.has(file.pathName),
    );
    snapshotPath = next.at(-1)?.pathName;
    if (snapshotPath) {
      break;
    }
    await sleep(250);
  }
  if (!snapshotPath) {
    return undefined;
  }

  const bytes = await waitForStableFileSize(snapshotPath);
  const snapshotsDir = path.join(params.outputDir, "artifacts", "gateway-heap-snapshots");
  await fs.mkdir(snapshotsDir, { recursive: true });
  const relativePath = path.join(
    "artifacts",
    "gateway-heap-snapshots",
    `${sanitizeQaHeapCheckpointLabel(params.label)}.heapsnapshot`,
  );
  await fs.copyFile(snapshotPath, path.join(params.outputDir, relativePath));
  return {
    label: params.label,
    at: new Date().toISOString(),
    path: relativePath,
    bytes,
  };
}

export async function runQaFlowSuite(params?: QaSuiteRunParams): Promise<QaSuiteResult> {
  const startedAt = new Date();
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const providerMode = normalizeQaProviderMode(
    params?.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const transportId = normalizeQaTransportId(params?.transportId);
  const primaryModel = normalizeQaSuiteModelRef(
    params?.primaryModel,
    defaultQaModelForMode(providerMode),
  );
  const alternateModel = normalizeQaSuiteModelRef(
    params?.alternateModel,
    defaultQaModelForMode(providerMode, true),
  );
  const fastMode =
    typeof params?.fastMode === "boolean"
      ? params.fastMode
      : isQaFastModeEnabled({ primaryModel, alternateModel });
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params?.outputDir);
  const catalog = readQaBootstrapScenarioCatalog();
  const selectedScenarios = selectQaFlowSuiteScenarios({
    scenarios: catalog.scenarios,
    scenarioIds: params?.scenarioIds,
    providerMode,
    primaryModel,
    channelDriver: params?.channelDriver ?? params?.channelDriverSelection?.channelDriver,
    claudeCliAuthMode: params?.claudeCliAuthMode,
  });
  const enabledPluginIds = [
    ...new Set([
      ...collectQaSuitePluginIds(selectedScenarios),
      ...(params?.enabledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean),
      ...(params?.forcedRuntime && params.forcedRuntime !== "openclaw"
        ? [params.forcedRuntime]
        : []),
    ]),
  ];
  const gatewayConfigPatch = collectQaSuiteGatewayConfigPatch(
    selectedScenarios,
    params?.adapterOptions?.sutAccountId?.trim() || "sut",
  );
  const gatewayRuntimeOptions = collectQaSuiteGatewayRuntimeOptions(selectedScenarios);
  const concurrency = normalizeQaSuiteConcurrency(
    params?.concurrency,
    selectedScenarios.length,
    params?.channelDriverSelection ? 1 : defaultQaSuiteConcurrencyForTransport(transportId),
  );
  const progressEnabled = shouldLogQaSuiteProgress();
  const gatewayHeapCheckpointsEnabled = shouldCaptureGatewayHeapCheckpoints();
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
      adapterFactories: params.adapterFactories,
      channelId: params.channelId,
      adapterOptions: params.adapterOptions,
      evidenceMode: params.evidenceMode,
      repoRoot,
      outputDir,
      startedAt,
      providerMode,
      transportId,
      channelDriverSelection: params?.channelDriverSelection,
      channelDriver: params?.channelDriver,
      primaryModel,
      alternateModel,
      fastMode,
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
    });
  }

  if (useIsolatedScenarioWorkers) {
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
      adapterOptions: params?.adapterOptions,
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
        scenario === undefined ? [] : [selectedScenarios[index]],
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
    try {
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
        { startStaggerMs: workerStartStaggerMs },
      );
      await artifactWriteQueue;
      const finishedAt = new Date();
      const failedCount = scenarios.filter((scenario) => scenario.status === "fail").length;
      lab.setScenarioRun({
        kind: "suite",
        status: "completed",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });
      const { evidence, evidencePath, report, reportPath, summaryPath } =
        await writeQaSuiteArtifacts({
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
        });
      lab.setLatestReport({
        outputPath: reportPath,
        markdown: report,
        generatedAt: finishedAt.toISOString(),
      } satisfies QaLabLatestReport);
      writeQaSuiteProgress(
        progressEnabled,
        `run complete: passed=${scenarios.length - failedCount} failed=${failedCount} total=${scenarios.length}`,
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
        () => transportFactoryResult.cleanup(),
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

  const ownsLab = !params?.lab;
  const startLab = params?.startLab;
  writeQaSuiteProgress(progressEnabled, "lab start");
  const lab =
    params?.lab ??
    (await requireQaSuiteStartLab(startLab)({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  writeQaSuiteProgress(progressEnabled, `lab ready: ${sanitizeQaSuiteProgressValue(lab.baseUrl)}`);
  await waitForQaLabReadyOrStopOwned({ lab, ownsLab });
  const transportFactoryResult = await createQaSuiteTransportAdapter({
    adapterFactories: params?.adapterFactories,
    channelDriver: params?.channelDriver,
    channelId: params?.channelId,
    channelDriverSelection: params?.channelDriverSelection,
    adapterOptions: params?.adapterOptions,
    cleanupOnFailure: ownsLab ? () => lab.stop() : undefined,
    outputDir,
    transportPolicy: collectQaSuiteTransportPolicy(selectedScenarios),
    state: lab.state,
    transportId,
  });
  const transport = transportFactoryResult.adapter;
  let mock: Awaited<ReturnType<typeof startQaProviderServer>> | undefined;
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let env: QaSuiteEnvironment | undefined;
  let preserveGatewayRuntimeDir: string | undefined;
  let runFailed = false;
  let runError: unknown;
  try {
    writeQaSuiteProgress(progressEnabled, `provider start: ${providerMode}`);
    const activeMock = await startQaProviderServer(providerMode);
    mock = activeMock;
    writeQaSuiteProgress(
      progressEnabled,
      `provider ready: ${sanitizeQaSuiteProgressValue(activeMock?.baseUrl ?? "live")}`,
    );
    writeQaSuiteProgress(progressEnabled, "gateway start");
    const activeGateway = await startQaGatewayChild({
      repoRoot,
      command: params?.sutOpenClawCommand,
      providerBaseUrl: activeMock ? `${activeMock.baseUrl}/v1` : undefined,
      transport,
      transportBaseUrl: lab.listenUrl,
      controlUiAllowedOrigins: [lab.listenUrl],
      providerMode,
      primaryModel,
      alternateModel,
      fastMode,
      thinkingDefault: params?.thinkingDefault,
      claudeCliAuthMode: params?.claudeCliAuthMode,
      controlUiEnabled: params?.controlUiEnabled ?? true,
      enabledPluginIds,
      forwardHostHome: gatewayRuntimeOptions?.forwardHostHome,
      mutateConfig: gatewayConfigPatch
        ? (cfg) => applyQaMergePatch(cfg, gatewayConfigPatch) as OpenClawConfig
        : undefined,
      runtimeEnvPatch: mergeQaRuntimeEnvPatches(
        buildQaRuntimeEnvPatch({
          providerMode,
          forcedRuntime: params?.forcedRuntime,
          mockBaseUrl: activeMock?.baseUrl,
        }),
        transport.createRuntimeEnvPatch?.(),
        buildQaGatewayHeapCheckpointRuntimeEnvPatch(),
      ),
    });
    gateway = activeGateway;
    writeQaSuiteProgress(
      progressEnabled,
      `gateway ready: ${sanitizeQaSuiteProgressValue(activeGateway.baseUrl)}`,
    );
    lab.setControlUi({
      controlUiProxyTarget: activeGateway.baseUrl,
      controlUiProxyToken: activeGateway.token,
    });
    const activeEnv: QaSuiteEnvironment = {
      lab,
      mock: activeMock,
      gateway: activeGateway,
      // YAML scenarios should see the full staged gateway config, not just
      // the transport fragment. Routing/session/plugin assertions depend on it.
      cfg: activeGateway.cfg,
      transport,
      repoRoot,
      providerMode,
      primaryModel,
      alternateModel,
      webSessionIds: new Set(),
    };
    env = activeEnv;

    const transportReadyTimeoutMs = resolveQaSuiteTransportReadyTimeoutMs(
      params?.transportReadyTimeoutMs,
    );
    // The gateway child already waits for /readyz before returning, but the
    // selected transport can still be finishing account startup. Pay that
    // readiness cost once here so the first scenario does not race bootstrap.
    await waitForTransportReady(activeEnv, transportReadyTimeoutMs).catch(async () => {
      await waitForGatewayHealthy(activeEnv, transportReadyTimeoutMs);
      await waitForTransportReady(activeEnv, transportReadyTimeoutMs);
    });
    await sleep(1_000);
    const scenarios: QaSuiteScenarioResult[] = [];
    const liveScenarioOutcomes: QaLabScenarioOutcome[] = selectedScenarios.map((scenario) => ({
      id: scenario.id,
      name: scenario.title,
      status: "pending",
    }));

    lab.setScenarioRun({
      kind: "suite",
      status: "running",
      startedAt: startedAt.toISOString(),
      scenarios: liveScenarioOutcomes,
    });

    const gatewayProcessRssSamples: QaSuiteGatewayRssSample[] = [];
    const sampleGatewayProcessRss = (label: string) => {
      const gatewayProcessRssBytes = activeGateway.getProcessRssBytes?.() ?? null;
      if (gatewayProcessRssBytes !== null) {
        gatewayProcessRssSamples.push({
          label,
          at: new Date().toISOString(),
          gatewayProcessRssBytes,
        });
      }
      return gatewayProcessRssBytes;
    };
    const gatewayProcessCpuStartMs = activeGateway.getProcessCpuMs?.() ?? null;
    const gatewayProcessRssStartBytes = sampleGatewayProcessRss("suite-start");
    const gatewayHeapSnapshots: QaSuiteGatewayHeapSnapshot[] = [];
    const captureGatewayHeapCheckpoint = async (label: string) => {
      if (!gatewayHeapCheckpointsEnabled) {
        return;
      }
      const snapshot = await captureGatewayHeapSnapshotCheckpoint({
        gateway: activeGateway,
        outputDir,
        label,
      });
      if (snapshot) {
        gatewayHeapSnapshots.push(snapshot);
      }
    };
    await captureGatewayHeapCheckpoint("suite-start");
    for (const [index, scenario] of selectedScenarios.entries()) {
      const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
      writeQaSuiteProgress(
        progressEnabled,
        `scenario start (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
      );
      sampleGatewayProcessRss(`scenario:${scenario.id}:start`);
      liveScenarioOutcomes[index] = {
        id: scenario.id,
        name: scenario.title,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      lab.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: startedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });

      const result = await runQaScenarioWithFlakeRetry(
        () => runScenarioDefinition(activeEnv, scenario),
        () =>
          writeQaSuiteProgress(
            progressEnabled,
            `scenario retry (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
          ),
      );
      sampleGatewayProcessRss(`scenario:${scenario.id}:finish`);
      scenarios.push(result);
      writeQaSuiteProgress(
        progressEnabled,
        `scenario ${result.status} (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
      );
      liveScenarioOutcomes[index] = {
        id: scenario.id,
        name: scenario.title,
        status: result.status,
        details: result.details,
        steps: result.steps,
        startedAt: liveScenarioOutcomes[index]?.startedAt,
        finishedAt: new Date().toISOString(),
      };
      lab.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: startedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });
    }

    const runtimeParityCell =
      params?.captureRuntimeParityCell &&
      params.forcedRuntime &&
      selectedScenarios.length === 1 &&
      scenarios.length > 0
        ? await captureRuntimeParityCell({
            runtime: params.forcedRuntime,
            gateway: activeGateway,
            scenarioResult: scenarios[0],
            wallClockMs: Math.max(1, Date.now() - startedAt.getTime()),
            mockBaseUrl: activeMock?.baseUrl,
          })
        : undefined;
    const finishedAt = new Date();
    await captureGatewayHeapCheckpoint("suite-finish");
    const metrics = buildQaSuiteRuntimeMetrics({
      startedAt,
      finishedAt,
      gatewayProcessCpuStartMs,
      gatewayProcessCpuEndMs: activeGateway.getProcessCpuMs?.() ?? null,
      gatewayProcessRssStartBytes,
      gatewayProcessRssEndBytes: sampleGatewayProcessRss("suite-finish"),
      gatewayProcessRssSamples,
      gatewayHeapSnapshots,
    });
    const failedCount = scenarios.filter((scenario) => scenario.status === "fail").length;
    if (
      scenarios.some((scenario) => scenario.status === "fail") ||
      gatewayRuntimeOptions?.preserveDebugArtifacts === true
    ) {
      preserveGatewayRuntimeDir = path.join(outputDir, "artifacts", "gateway-runtime");
    }
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
        metrics,
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
        isolatedWorkers: false,
        writeEvidenceFile: params?.writeEvidenceFile,
        // Same "filtered → executed list, unfiltered → null" convention as
        // the concurrent-path writeQaSuiteArtifacts call above.
        scenarioIds:
          params?.scenarioIds && params.scenarioIds.length > 0
            ? selectedScenarios.map((scenario) => scenario.id)
            : undefined,
      },
    );
    const latestReport = {
      outputPath: reportPath,
      markdown: report,
      generatedAt: finishedAt.toISOString(),
    } satisfies QaLabLatestReport;
    lab.setLatestReport(latestReport);
    writeQaSuiteProgress(
      progressEnabled,
      `run complete: passed=${scenarios.length - failedCount} failed=${failedCount} total=${scenarios.length}`,
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
      ...(runtimeParityCell ? { runtimeParityCell } : {}),
    } satisfies QaSuiteResult;
  } catch (error) {
    runFailed = true;
    runError = error;
    preserveGatewayRuntimeDir = path.join(outputDir, "artifacts", "gateway-runtime");
    throw error;
  } finally {
    const cleanupSteps: Array<() => Promise<void>> = [];
    const activeEnv = env;
    if (activeEnv) {
      cleanupSteps.push(() => closeQaWebSessions(activeEnv.webSessionIds));
    }
    const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1" || false;
    const activeGateway = gateway;
    if (activeGateway) {
      cleanupSteps.push(() =>
        activeGateway.stop({
          keepTemp,
          preserveToDir: keepTemp ? undefined : preserveGatewayRuntimeDir,
        }),
      );
    }
    cleanupSteps.push(
      () => transportFactoryResult.cleanup(),
      () => disposeRegisteredAgentHarnesses(),
    );
    const activeMock = mock;
    if (activeMock) {
      cleanupSteps.push(() => activeMock.stop());
    }
    if (ownsLab) {
      cleanupSteps.push(() => lab.stop());
    } else {
      cleanupSteps.push(async () => {
        lab.setControlUi({
          controlUiUrl: null,
          controlUiProxyTarget: null,
        });
      });
    }
    const cleanupErrors = await runQaSuiteCleanupSteps(cleanupSteps);
    throwQaSuiteCleanupErrors({ cleanupErrors, runFailed, runError });
  }
}

export const qaSuiteProgressTesting = {
  appendNodeOption,
  buildQaGatewayHeapCheckpointRuntimeEnvPatch,
  buildQaIsolatedScenarioWorkerParams,
  buildQaSuiteRuntimeMetrics,
  createQaSuiteTransportAdapter,
  formatQaSuiteRunStartProgress,
  buildQaRuntimeEnvPatch,
  mergeQaRuntimeEnvPatches,
  parseQaSuiteBooleanEnv,
  remapModelRefForForcedRuntime,
  runQaSuiteCleanupSteps,
  throwQaSuiteCleanupErrors,
  resolveQaSuiteControlUiEnabled,
  scenarioRequiresControlUi,
  resolveQaSuiteTransportReadyTimeoutMs,
  sanitizeQaSuiteProgressValue,
  shouldRunQaSuiteWithIsolatedScenarioWorkers,
  shouldLogQaSuiteProgress,
  waitForQaLabReadyOrStopOwned,
  writeQaSuiteArtifacts,
};
