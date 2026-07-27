// QA Lab plugin module implements suite behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { QaEvidenceTiming, QaEvidenceSummaryJson } from "./evidence-summary.js";
import type { QaCliBackendAuthMode, QaGatewayChildCommand } from "./gateway-child.js";
import { startQaGatewayChild } from "./gateway-child.js";
import { discardIgnoredResponseBody } from "./ignored-response-body.js";
import type { QaLabServerHandle, QaLabServerStartParams } from "./lab-server.types.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import type { QaProviderMode } from "./model-selection.js";
import {
  parseQaProgressBooleanEnv as parseQaSuiteBooleanEnv,
  sanitizeQaProgressValue as sanitizeQaSuiteProgressValue,
} from "./progress-format.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import {
  createQaTransportAdapter,
  type QaTransportAdapterFactory,
  type QaTransportFactoryContext,
  type QaTransportId,
} from "./qa-transport-registry.js";
import type { QaReportCheck } from "./report.js";
import type { RuntimeId, RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver, QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import {
  type QaSuiteGatewayHeapSnapshot,
  type QaSuiteGatewayRssSample,
  writeQaSuiteArtifacts,
} from "./suite-artifacts.js";
import {
  scenarioRequiresControlUi,
  shouldUseIsolatedQaSuiteScenarioWorkers,
  splitModelRef,
} from "./suite-planning.js";
import type { QaSuiteRoundTripProbe } from "./suite-round-trip.js";
import {
  createQaSuiteScenarioStepRunner,
  runQaSuiteScenarioDefinition,
  runQaSuiteScenarioSteps,
} from "./suite-runtime-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import type { QaSuiteSummaryJson } from "./suite-summary.js";
import {
  appendNodeOption,
  buildQaGatewayHeapCheckpointRuntimeEnvPatch,
  buildQaIsolatedScenarioWorkerParams,
  buildQaRuntimeEnvPatch,
  mergeQaRuntimeEnvPatches,
  remapModelRefForForcedRuntime,
} from "./suite-support.js";

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
  status: "pass" | "fail" | "skip";
  steps: QaReportCheck[];
  details?: string;
  timing?: QaEvidenceTiming;
  runtimeParity?: RuntimeParityResult;
};

type QaSuiteEnvironment = {
  lab: QaLabServerHandle;
  webSessionIds: Set<string>;
} & QaSuiteRuntimeEnv;

export type QaSuiteStartLabFn = (params?: QaLabServerStartParams) => Promise<QaLabServerHandle>;

export async function createQaSuiteTransportAdapter(params: {
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
  failFast?: boolean;
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
  roundTripProbe?: QaSuiteRoundTripProbe;
  // Unified suite partitions consume child evidence in memory; only the
  // parent should write the aggregate qa-evidence.json artifact.
  writeEvidenceFile?: boolean;
};

export function shouldLogQaSuiteProgress(env: NodeJS.ProcessEnv = process.env) {
  const override = parseQaSuiteBooleanEnv(env.OPENCLAW_QA_SUITE_PROGRESS);
  if (override !== undefined) {
    return override;
  }
  return parseQaSuiteBooleanEnv(env.CI) === true;
}

export function resolveQaSuiteTransportReadyTimeoutMs(
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

export function writeQaSuiteProgress(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  process.stderr.write(`[qa-suite] ${message}\n`);
}

export function formatQaSuiteRunStartProgress(params: {
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { response, release } = await fetchWithSsrFGuard({
        url: `${baseUrl}/readyz`,
        policy: { allowPrivateNetwork: true },
        timeoutMs: Math.max(1, deadline - Date.now()),
        auditContext: "qa-lab-suite-wait-for-lab-ready",
      });
      try {
        const ready = response.ok;
        await discardIgnoredResponseBody(response);
        if (ready) {
          return;
        }
      } finally {
        await release();
      }
    } catch {
      // retry
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(100, remainingMs));
    }
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for qa-lab ready`);
}

export async function waitForQaLabReadyOrStopOwned(params: {
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

export async function runQaSuiteCleanupSteps(steps: ReadonlyArray<() => Promise<void>>) {
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

export async function runQaFlowSuiteCleanupPlan(params: {
  closeWebSessions?: () => Promise<void>;
  cleanupTransportBeforeGatewayStop: () => Promise<void>;
  cleanupTransportAfterGatewayStop: () => Promise<void>;
  stopGateway?: () => Promise<void>;
  disposeAgentHarnesses: () => Promise<void>;
  stopProvider?: () => Promise<void>;
  finishLab: () => Promise<void>;
}) {
  const errors = await runQaSuiteCleanupSteps([
    ...(params.closeWebSessions ? [params.closeWebSessions] : []),
    // Drain transport HTTP work before stopping the gateway; otherwise a completed suite can
    // emit an unhandled response-close rejection during delivery.
    params.cleanupTransportBeforeGatewayStop,
  ]);
  let gatewayStopped = !params.stopGateway;
  if (params.stopGateway) {
    const gatewayErrors = await runQaSuiteCleanupSteps([params.stopGateway]);
    errors.push(...gatewayErrors);
    gatewayStopped = gatewayErrors.length === 0;
  }
  errors.push(
    ...(await runQaSuiteCleanupSteps([
      // Never release a credential-backed transport until gateway teardown proves
      // that the isolated runtime reached its terminal boundary.
      ...(gatewayStopped ? [params.cleanupTransportAfterGatewayStop] : []),
      params.disposeAgentHarnesses,
      ...(params.stopProvider ? [params.stopProvider] : []),
      params.finishLab,
    ])),
  );
  return errors;
}

export function throwQaSuiteCleanupErrors(params: {
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

export function requireQaSuiteStartLab(startLab: QaSuiteStartLabFn | undefined): QaSuiteStartLabFn {
  if (startLab) {
    return startLab;
  }
  throw new Error(
    "QA suite requires startLab when no lab handle is provided; use the runtime launcher or pass startLab explicitly.",
  );
}

export function shouldRunQaSuiteWithIsolatedScenarioWorkers(params: {
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

export async function runQaSuiteScenarioDefinitionForRuntime(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  return await runQaSuiteScenarioDefinition({
    env,
    scenario,
    runScenario: runQaSuiteScenarioSteps,
    splitModelRef,
    formatErrorMessage,
    liveTurnTimeoutMs: resolveQaLiveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs,
    constants: {
      imageUnderstandingPngBase64: QA_IMAGE_UNDERSTANDING_PNG_BASE64,
      imageUnderstandingLargePngBase64: QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64,
      imageUnderstandingValidPngBase64: QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64,
    },
  });
}

type QaGatewayHandle = Awaited<ReturnType<typeof startQaGatewayChild>>;

export function buildQaSuiteRuntimeMetrics(params: {
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

export async function captureGatewayHeapSnapshotCheckpoint(params: {
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

export { buildQaSuiteSummaryJson } from "./suite-artifacts.js";
export type { QaSuiteSummaryJsonParams } from "./suite-artifacts.js";
export type { QaSuiteSummaryJson } from "./suite-summary.js";

export async function runQaFlowSuite(params?: QaSuiteRunParams): Promise<QaSuiteResult> {
  const { runQaFlowSuiteFromRuntime } = await import("./suite-run.runtime.js");
  return await runQaFlowSuiteFromRuntime(params);
}

export const qaSuiteProgressTesting = {
  appendNodeOption,
  buildQaGatewayHeapCheckpointRuntimeEnvPatch,
  buildQaIsolatedScenarioWorkerParams,
  buildQaSuiteRuntimeMetrics,
  createQaSuiteTransportAdapter,
  createScenarioStepRunner: createQaSuiteScenarioStepRunner,
  formatQaSuiteRunStartProgress,
  buildQaRuntimeEnvPatch,
  mergeQaRuntimeEnvPatches,
  parseQaSuiteBooleanEnv,
  remapModelRefForForcedRuntime,
  runQaFlowSuiteCleanupPlan,
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
