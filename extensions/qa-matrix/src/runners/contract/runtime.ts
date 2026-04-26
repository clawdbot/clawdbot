import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { loadQaRuntimeModule } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { QaReportCheck } from "../../report.js";
import { renderQaMarkdownReport } from "../../report.js";
import { type QaProviderModeInput } from "../../run-config.js";
import {
  appendLiveLaneIssue,
  buildLiveLaneArtifactsError,
} from "../../shared/live-lane-helpers.js";
import { buildMatrixQaObservedEventsArtifact } from "../../substrate/artifacts.js";
import { provisionMatrixQaRoom, type MatrixQaProvisionResult } from "../../substrate/client.js";
import {
  buildMatrixQaConfig,
  buildMatrixQaConfigSnapshot,
  summarizeMatrixQaConfigSnapshot,
  type MatrixQaConfigOverrides,
  type MatrixQaConfigSnapshot,
} from "../../substrate/config.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { startMatrixQaHarness } from "../../substrate/harness.runtime.js";
import { resolveMatrixQaModels } from "./model-selection.js";
import type { MatrixQaSyncStreams } from "./scenario-runtime-shared.js";
import {
  MATRIX_QA_SCENARIOS,
  buildMatrixQaTopologyForScenarios,
  buildMatrixReplyDetails,
  findMatrixQaScenarios,
  runMatrixQaCanary,
  runMatrixQaScenario,
  type MatrixQaCanaryArtifact,
  type MatrixQaScenarioArtifacts,
} from "./scenarios.js";

type MatrixQaGatewayChild = {
  call(
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  restartAfterStateMutation?: (
    mutateState: (context: { stateDir: string }) => Promise<void>,
  ) => Promise<void>;
  restart(): Promise<void>;
  runtimeEnv?: NodeJS.ProcessEnv;
};

const DEFAULT_MATRIX_QA_RUN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MATRIX_QA_CLEANUP_TIMEOUT_MS = 90_000;

type MatrixQaLiveLaneGatewayHarness = {
  gateway: MatrixQaGatewayChild;
  stop(): Promise<void>;
};

function buildMatrixQaGatewayConfigKey(overrides?: MatrixQaConfigOverrides) {
  return JSON.stringify(overrides ?? null);
}

type MatrixQaScenarioResult = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
  id: string;
  status: "fail" | "pass";
  title: string;
};

type MatrixQaScheduledScenario = {
  originalIndex: number;
  scenario: (typeof MATRIX_QA_SCENARIOS)[number];
};

type MatrixQaScenarioConfigEntry = MatrixQaSummary["config"]["scenarios"][number];

type MatrixQaSummary = {
  checks: QaReportCheck[];
  config: {
    default: MatrixQaConfigSnapshot;
    scenarios: Array<{
      config: MatrixQaConfigSnapshot;
      id: string;
      title: string;
    }>;
  };
  counts: {
    failed: number;
    passed: number;
    total: number;
  };
  finishedAt: string;
  harness: {
    baseUrl: string;
    composeFile: string;
    dmRoomIds: string[];
    image: string;
    roomId: string;
    roomIds: string[];
    serverName: string;
  };
  canary?: MatrixQaCanaryArtifact;
  observedEventCount: number;
  observedEventsPath: string;
  reportPath: string;
  scenarios: MatrixQaScenarioResult[];
  startedAt: string;
  summaryPath: string;
  sutAccountId: string;
  timings: MatrixQaTimings;
  userIds: {
    driver: string;
    observer: string;
    sut: string;
  };
};

type MatrixQaArtifactPaths = {
  observedEvents: string;
  report: string;
  summary: string;
};

type MatrixQaScenarioTiming = {
  durationMs: number;
  gatewayBootMs: number;
  gatewayRestartMs: number;
  id: string;
  title: string;
  transportInterruptMs: number;
};

type MatrixQaTimings = {
  artifactWriteMs: number;
  canaryMs?: number;
  harnessBootMs: number;
  initialGatewayBootMs: number;
  provisioningMs: number;
  scenarioGatewayBootMs: number;
  scenarioRestartGatewayMs: number;
  scenarioTransportInterruptMs: number;
  scenarios: MatrixQaScenarioTiming[];
  totalMs: number;
};

function shouldWriteMatrixQaProgress() {
  const override = process.env.OPENCLAW_QA_MATRIX_PROGRESS;
  if (override === "0") {
    return false;
  }
  if (override === "1") {
    return true;
  }
  return true;
}

function formatMatrixQaDurationMs(durationMs: number) {
  return durationMs >= 1_000 ? `${(durationMs / 1_000).toFixed(1)}s` : `${durationMs}ms`;
}

function writeMatrixQaProgress(message: string) {
  if (!shouldWriteMatrixQaProgress()) {
    return;
  }
  process.stderr.write(`[matrix-qa] ${message}\n`);
}

function parsePositiveMatrixQaEnvMs(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function createMatrixQaRunDeadline() {
  const timeoutMs = parsePositiveMatrixQaEnvMs(
    "OPENCLAW_QA_MATRIX_TIMEOUT_MS",
    DEFAULT_MATRIX_QA_RUN_TIMEOUT_MS,
  );
  return {
    timeoutMs,
    deadlineMs: Date.now() + timeoutMs,
  };
}

function remainingMatrixQaRunMs(deadline: { deadlineMs: number }) {
  return Math.max(1, deadline.deadlineMs - Date.now());
}

async function withMatrixQaTimeout<T>(
  label: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function withMatrixQaRunDeadline<T>(
  deadline: { deadlineMs: number; timeoutMs: number },
  label: string,
  task: () => Promise<T>,
) {
  return await withMatrixQaTimeout(label, remainingMatrixQaRunMs(deadline), task);
}

async function cleanupMatrixQaResource(params: {
  action: () => Promise<void>;
  label: string;
  recovery?: string;
}) {
  const timeoutMs = parsePositiveMatrixQaEnvMs(
    "OPENCLAW_QA_MATRIX_CLEANUP_TIMEOUT_MS",
    DEFAULT_MATRIX_QA_CLEANUP_TIMEOUT_MS,
  );
  try {
    await withMatrixQaTimeout(params.label, timeoutMs, params.action);
  } catch (error) {
    const recovery = params.recovery ? `\nRecovery: ${params.recovery}` : "";
    throw new Error(`${formatErrorMessage(error)}${recovery}`, { cause: error });
  }
}

function countMatrixQaStatuses(entries: Array<{ status: "fail" | "pass" | "skip" }>) {
  return {
    failed: entries.filter((entry) => entry.status === "fail").length,
    passed: entries.filter((entry) => entry.status === "pass").length,
  };
}

function formatMatrixQaScenarioDetails(params: { details: string; configSummary?: string }) {
  if (!params.configSummary) {
    return params.details;
  }
  return [`effective config: ${params.configSummary}`, params.details].join("\n");
}

function buildMatrixQaScenarioConfigEntry(params: {
  gatewayConfigParams: {
    driverUserId: string;
    homeserver: string;
    observerUserId: string;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
    topology: MatrixQaProvisionResult["topology"];
  };
  scenario: (typeof MATRIX_QA_SCENARIOS)[number];
}): {
  entry: MatrixQaScenarioConfigEntry;
  summary?: string;
} {
  const snapshot = buildMatrixQaConfigSnapshot({
    ...params.gatewayConfigParams,
    overrides: params.scenario.configOverrides,
  });
  return {
    entry: {
      config: snapshot,
      id: params.scenario.id,
      title: params.scenario.title,
    },
    summary:
      params.scenario.configOverrides === undefined
        ? undefined
        : summarizeMatrixQaConfigSnapshot(snapshot),
  };
}

function buildMatrixQaScenarioResult(params: {
  artifacts?: MatrixQaScenarioArtifacts;
  configSummary?: string;
  details: string;
  scenario: {
    id: string;
    title: string;
  };
  status: "fail" | "pass";
}): MatrixQaScenarioResult {
  return {
    artifacts: params.artifacts,
    id: params.scenario.id,
    title: params.scenario.title,
    status: params.status,
    details: formatMatrixQaScenarioDetails({
      details: params.details,
      configSummary: params.configSummary,
    }),
  };
}

function scheduleMatrixQaScenariosByConfig(
  scenarios: readonly (typeof MATRIX_QA_SCENARIOS)[number][],
): MatrixQaScheduledScenario[] {
  const grouped = new Map<string, MatrixQaScheduledScenario[]>();

  scenarios.forEach((scenario, originalIndex) => {
    const configKey = buildMatrixQaGatewayConfigKey(scenario.configOverrides);
    const existing = grouped.get(configKey);
    const scheduled = { originalIndex, scenario };
    if (existing) {
      existing.push(scheduled);
      return;
    }
    grouped.set(configKey, [scheduled]);
  });

  return [...grouped.values()].flat();
}

export type MatrixQaRunResult = {
  observedEventsPath: string;
  outputDir: string;
  reportPath: string;
  scenarios: MatrixQaScenarioResult[];
  summaryPath: string;
};

function buildMatrixQaSummary(params: {
  artifactPaths: MatrixQaArtifactPaths;
  canary?: MatrixQaCanaryArtifact;
  checks: QaReportCheck[];
  config: MatrixQaSummary["config"];
  finishedAt: string;
  harness: MatrixQaSummary["harness"];
  observedEventCount: number;
  scenarios: MatrixQaScenarioResult[];
  startedAt: string;
  sutAccountId: string;
  timings: MatrixQaTimings;
  userIds: MatrixQaSummary["userIds"];
}): MatrixQaSummary {
  const checkCounts = countMatrixQaStatuses(params.checks);
  const scenarioCounts = countMatrixQaStatuses(params.scenarios);

  return {
    checks: params.checks,
    config: params.config,
    counts: {
      total: params.checks.length + params.scenarios.length,
      passed: checkCounts.passed + scenarioCounts.passed,
      failed: checkCounts.failed + scenarioCounts.failed,
    },
    finishedAt: params.finishedAt,
    harness: params.harness,
    canary: params.canary,
    observedEventCount: params.observedEventCount,
    observedEventsPath: params.artifactPaths.observedEvents,
    reportPath: params.artifactPaths.report,
    scenarios: params.scenarios,
    startedAt: params.startedAt,
    summaryPath: params.artifactPaths.summary,
    sutAccountId: params.sutAccountId,
    timings: params.timings,
    userIds: params.userIds,
  };
}

async function measureMatrixQaStep<T>(step: () => Promise<T>) {
  const startedAtMs = Date.now();
  const result = await step();
  return {
    durationMs: Date.now() - startedAtMs,
    result,
  };
}

function isMatrixAccountReady(entry?: {
  connected?: boolean;
  healthState?: string;
  restartPending?: boolean;
  running?: boolean;
}): boolean {
  return (
    entry?.running === true &&
    entry.connected === true &&
    entry.restartPending !== true &&
    (entry.healthState === undefined || entry.healthState === "healthy")
  );
}

async function waitForMatrixChannelReady(
  gateway: MatrixQaGatewayChild,
  accountId: string,
  opts?: {
    pollMs?: number;
    timeoutMs?: number;
  },
) {
  const pollMs = opts?.pollMs ?? 500;
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            healthState?: string;
            restartPending?: boolean;
            running?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.matrix ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      if (isMatrixAccountReady(match)) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(pollMs);
  }
  throw new Error(`matrix account "${accountId}" did not become ready`);
}

async function patchMatrixQaGatewayConfig(params: {
  gateway: MatrixQaGatewayChild;
  patch: Record<string, unknown>;
  restartDelayMs?: number;
}) {
  const snapshot = (await params.gateway.call("config.get", {}, { timeoutMs: 60_000 })) as {
    hash?: string;
  };
  if (!snapshot.hash) {
    throw new Error("Matrix QA config patch requires config.get hash");
  }
  await params.gateway.call(
    "config.patch",
    {
      raw: JSON.stringify(params.patch, null, 2),
      baseHash: snapshot.hash,
      restartDelayMs: params.restartDelayMs ?? 0,
    },
    { timeoutMs: 60_000 },
  );
}

async function startMatrixQaLiveLaneGateway(params: {
  repoRoot: string;
  transport: {
    requiredPluginIds: readonly string[];
    createGatewayConfig: (params: {
      baseUrl: string;
    }) => Pick<OpenClawConfig, "channels" | "messages">;
  };
  transportBaseUrl: string;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode?: boolean;
  controlUiEnabled?: boolean;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}): Promise<MatrixQaLiveLaneGatewayHarness> {
  return (await loadQaRuntimeModule().startQaLiveLaneGateway(
    params,
  )) as MatrixQaLiveLaneGatewayHarness;
}

export async function runMatrixQaLive(params: {
  fastMode?: boolean;
  outputDir?: string;
  primaryModel?: string;
  providerMode?: QaProviderModeInput;
  repoRoot?: string;
  scenarioIds?: string[];
  sutAccountId?: string;
  alternateModel?: string;
}): Promise<MatrixQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `matrix-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const { providerMode, primaryModel, alternateModel } = resolveMatrixQaModels({
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
  });
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findMatrixQaScenarios(params.scenarioIds);
  const runSuffix = randomUUID().slice(0, 8);
  const topology = buildMatrixQaTopologyForScenarios({
    defaultRoomName: `OpenClaw Matrix QA ${runSuffix}`,
    scenarios,
  });
  const observedEvents: MatrixQaObservedEvent[] = [];
  const includeObservedEventContent = process.env.OPENCLAW_QA_MATRIX_CAPTURE_CONTENT === "1";
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const runStartedAtMs = Date.now();
  const runDeadline = createMatrixQaRunDeadline();
  writeMatrixQaProgress(
    `suite start scenarios=${scenarios.length} provider=${providerMode} output=${outputDir} timeout=${formatMatrixQaDurationMs(runDeadline.timeoutMs)}`,
  );

  const { durationMs: harnessBootMs, result: harness } = await measureMatrixQaStep(() =>
    withMatrixQaRunDeadline(runDeadline, "Matrix harness boot", () =>
      startMatrixQaHarness({
        outputDir: path.join(outputDir, "matrix-harness"),
        repoRoot,
      }),
    ),
  );
  writeMatrixQaProgress(
    `harness ready ${formatMatrixQaDurationMs(harnessBootMs)} baseUrl=${harness.baseUrl}`,
  );
  const { durationMs: provisioningMs, result: provisioning } = await (async () => {
    try {
      return await measureMatrixQaStep(() =>
        withMatrixQaRunDeadline(runDeadline, "Matrix topology provisioning", () =>
          provisionMatrixQaRoom({
            baseUrl: harness.baseUrl,
            driverLocalpart: `qa-driver-${runSuffix}`,
            observerLocalpart: `qa-observer-${runSuffix}`,
            registrationToken: harness.registrationToken,
            roomName: `OpenClaw Matrix QA ${runSuffix}`,
            sutLocalpart: `qa-sut-${runSuffix}`,
            topology,
          }),
        ),
      );
    } catch (error) {
      await cleanupMatrixQaResource({
        label: "Matrix homeserver cleanup after provisioning failure",
        action: () => harness.stop(),
        recovery: harness.stopCommand,
      }).catch(() => {});
      throw error;
    }
  })();
  writeMatrixQaProgress(
    `topology ready ${formatMatrixQaDurationMs(provisioningMs)} rooms=${provisioning.topology.rooms.length}`,
  );

  const checks: QaReportCheck[] = [
    {
      name: "Matrix harness ready",
      status: "pass",
      details: [
        `image: ${harness.image}`,
        `baseUrl: ${harness.baseUrl}`,
        `serverName: ${harness.serverName}`,
        `roomId: ${provisioning.roomId}`,
        `roomCount: ${provisioning.topology.rooms.length}`,
      ].join("\n"),
    },
  ];
  const scenarioResults: Array<MatrixQaScenarioResult | undefined> = Array.from({
    length: scenarios.length,
  });
  const cleanupErrors: string[] = [];
  let canaryArtifact: MatrixQaCanaryArtifact | undefined;
  let gatewayHarness: MatrixQaLiveLaneGatewayHarness | null = null;
  let gatewayHarnessKey: string | null = null;
  let canaryFailed = false;
  const syncState: { driver?: string; observer?: string } = {};
  const syncStreams: MatrixQaSyncStreams = {};
  let canaryMs: number | undefined;
  let initialGatewayBootMs = 0;
  let scenarioGatewayBootMs = 0;
  let scenarioRestartGatewayMs = 0;
  let scenarioTransportInterruptMs = 0;
  const scenarioTimings: MatrixQaScenarioTiming[] = [];
  const gatewayConfigParams = {
    driverUserId: provisioning.driver.userId,
    homeserver: harness.baseUrl,
    observerUserId: provisioning.observer.userId,
    sutAccessToken: provisioning.sut.accessToken,
    sutAccountId,
    sutDeviceId: provisioning.sut.deviceId,
    sutUserId: provisioning.sut.userId,
    topology: provisioning.topology,
  };
  const defaultConfigSnapshot = buildMatrixQaConfigSnapshot(gatewayConfigParams);
  const scenarioConfigSnapshots: MatrixQaScenarioConfigEntry[] = [];

  const scheduledScenarios = scheduleMatrixQaScenariosByConfig(scenarios);

  try {
    const ensureGatewayHarness = async (overrides?: MatrixQaConfigOverrides) => {
      const nextKey = buildMatrixQaGatewayConfigKey(overrides);
      if (gatewayHarness && gatewayHarnessKey === nextKey) {
        return {
          durationMs: 0,
          harness: gatewayHarness,
        };
      }
      if (gatewayHarness) {
        await cleanupMatrixQaResource({
          label: "Matrix live gateway cleanup before config switch",
          action: () => gatewayHarness!.stop(),
        });
        gatewayHarness = null;
        gatewayHarnessKey = nextKey;
      }
      writeMatrixQaProgress("gateway boot start");
      const { durationMs, result: started } = await measureMatrixQaStep(() =>
        withMatrixQaRunDeadline(runDeadline, "Matrix gateway boot", async () => {
          const nextHarness = await startMatrixQaLiveLaneGateway({
            repoRoot,
            transport: {
              requiredPluginIds: [],
              createGatewayConfig: () => ({}),
            },
            transportBaseUrl: "http://127.0.0.1:43123",
            providerMode,
            primaryModel,
            alternateModel,
            fastMode: params.fastMode,
            controlUiEnabled: false,
            mutateConfig: (cfg) =>
              buildMatrixQaConfig(cfg, {
                ...gatewayConfigParams,
                overrides,
              }),
          });
          await waitForMatrixChannelReady(nextHarness.gateway, sutAccountId);
          return nextHarness;
        }),
      );
      writeMatrixQaProgress(`gateway boot done ${formatMatrixQaDurationMs(durationMs)}`);
      gatewayHarness = started;
      gatewayHarnessKey = nextKey;
      return {
        durationMs,
        harness: started,
      };
    };

    {
      const ensured = await ensureGatewayHarness();
      gatewayHarness = ensured.harness;
      initialGatewayBootMs = ensured.durationMs;
    }
    checks.push({
      name: "Matrix channel ready",
      status: "pass",
      details: `accountId: ${sutAccountId}\nuserId: ${provisioning.sut.userId}`,
    });

    try {
      writeMatrixQaProgress("canary start");
      const canaryMeasured = await measureMatrixQaStep(() =>
        withMatrixQaRunDeadline(runDeadline, "Matrix canary", () =>
          runMatrixQaCanary({
            baseUrl: harness.baseUrl,
            driverAccessToken: provisioning.driver.accessToken,
            observedEvents,
            roomId: provisioning.roomId,
            syncState,
            syncStreams,
            sutUserId: provisioning.sut.userId,
            timeoutMs: 45_000,
          }),
        ),
      );
      canaryMs = canaryMeasured.durationMs;
      const canary = canaryMeasured.result;
      canaryArtifact = {
        driverEventId: canary.driverEventId,
        reply: canary.reply,
        token: canary.token,
      };
      checks.push({
        name: "Matrix canary",
        status: "pass",
        details: buildMatrixReplyDetails("reply", canary.reply).join("\n"),
      });
      writeMatrixQaProgress(`canary pass ${formatMatrixQaDurationMs(canaryMeasured.durationMs)}`);
    } catch (error) {
      canaryFailed = true;
      checks.push({
        name: "Matrix canary",
        status: "fail",
        details: formatErrorMessage(error),
      });
      writeMatrixQaProgress(`canary fail ${formatErrorMessage(error)}`);
    }

    if (!canaryFailed) {
      for (const { scenario, originalIndex } of scheduledScenarios) {
        const { entry: scenarioConfigEntry, summary: scenarioConfigSummary } =
          buildMatrixQaScenarioConfigEntry({
            gatewayConfigParams,
            scenario,
          });
        scenarioConfigSnapshots[originalIndex] = scenarioConfigEntry;
        let gatewayBootMs = 0;
        let gatewayRestartMs = 0;
        let transportInterruptMs = 0;
        try {
          writeMatrixQaProgress(`scenario start ${scenario.id}`);
          const scenarioGateway = await ensureGatewayHarness(scenario.configOverrides);
          gatewayBootMs = scenarioGateway.durationMs;
          scenarioGatewayBootMs += gatewayBootMs;
          const measuredScenario = await measureMatrixQaStep(() =>
            withMatrixQaRunDeadline(runDeadline, `Matrix scenario ${scenario.id}`, () =>
              runMatrixQaScenario(scenario, {
                baseUrl: harness.baseUrl,
                canary: canaryArtifact,
                driverAccessToken: provisioning.driver.accessToken,
                driverDeviceId: provisioning.driver.deviceId,
                driverPassword: provisioning.driver.password,
                driverUserId: provisioning.driver.userId,
                interruptTransport: async () => {
                  writeMatrixQaProgress(`transport interrupt start ${scenario.id}`);
                  const measuredInterrupt = await measureMatrixQaStep(async () => {
                    await harness.restartService();
                    await waitForMatrixChannelReady(scenarioGateway.harness.gateway, sutAccountId, {
                      timeoutMs: 90_000,
                    });
                  });
                  transportInterruptMs += measuredInterrupt.durationMs;
                  scenarioTransportInterruptMs += measuredInterrupt.durationMs;
                  writeMatrixQaProgress(
                    `transport interrupt done ${scenario.id} ${formatMatrixQaDurationMs(measuredInterrupt.durationMs)}`,
                  );
                },
                observedEvents,
                observerAccessToken: provisioning.observer.accessToken,
                observerDeviceId: provisioning.observer.deviceId,
                observerPassword: provisioning.observer.password,
                observerUserId: provisioning.observer.userId,
                gatewayRuntimeEnv: scenarioGateway.harness.gateway.runtimeEnv,
                gatewayStateDir: scenarioGateway.harness.gateway.runtimeEnv?.OPENCLAW_STATE_DIR,
                outputDir,
                restartGateway: async () => {
                  if (!gatewayHarness) {
                    throw new Error("Matrix restart scenario requires a live gateway");
                  }
                  writeMatrixQaProgress(`gateway restart start ${scenario.id}`);
                  const measuredRestart = await measureMatrixQaStep(async () => {
                    await scenarioGateway.harness.gateway.restart();
                    await waitForMatrixChannelReady(scenarioGateway.harness.gateway, sutAccountId);
                  });
                  gatewayRestartMs += measuredRestart.durationMs;
                  scenarioRestartGatewayMs += measuredRestart.durationMs;
                  writeMatrixQaProgress(
                    `gateway restart done ${scenario.id} ${formatMatrixQaDurationMs(measuredRestart.durationMs)}`,
                  );
                },
                restartGatewayAfterStateMutation: async (mutateState) => {
                  if (!gatewayHarness) {
                    throw new Error(
                      "Matrix persisted-state restart scenario requires a live gateway",
                    );
                  }
                  const restartAfterStateMutation =
                    scenarioGateway.harness.gateway.restartAfterStateMutation;
                  if (!restartAfterStateMutation) {
                    throw new Error(
                      "Matrix persisted-state restart scenario requires a hard restart callback",
                    );
                  }
                  writeMatrixQaProgress(`gateway hard restart start ${scenario.id}`);
                  const measuredRestart = await measureMatrixQaStep(async () => {
                    await restartAfterStateMutation(mutateState);
                    await waitForMatrixChannelReady(scenarioGateway.harness.gateway, sutAccountId);
                  });
                  gatewayRestartMs += measuredRestart.durationMs;
                  scenarioRestartGatewayMs += measuredRestart.durationMs;
                  writeMatrixQaProgress(
                    `gateway hard restart done ${scenario.id} ${formatMatrixQaDurationMs(measuredRestart.durationMs)}`,
                  );
                },
                restartGatewayWithQueuedMessage: async (queueMessage) => {
                  if (!gatewayHarness) {
                    throw new Error("Matrix restart catchup scenario requires a live gateway");
                  }
                  writeMatrixQaProgress(`gateway restart+queue start ${scenario.id}`);
                  const measuredRestart = await measureMatrixQaStep(async () => {
                    await scenarioGateway.harness.gateway.restart();
                    await sleep(250);
                    await queueMessage();
                    await waitForMatrixChannelReady(scenarioGateway.harness.gateway, sutAccountId);
                  });
                  gatewayRestartMs += measuredRestart.durationMs;
                  scenarioRestartGatewayMs += measuredRestart.durationMs;
                  writeMatrixQaProgress(
                    `gateway restart+queue done ${scenario.id} ${formatMatrixQaDurationMs(measuredRestart.durationMs)}`,
                  );
                },
                roomId: provisioning.roomId,
                sutAccountId,
                sutAccessToken: provisioning.sut.accessToken,
                sutDeviceId: provisioning.sut.deviceId,
                sutPassword: provisioning.sut.password,
                syncState,
                syncStreams,
                sutUserId: provisioning.sut.userId,
                timeoutMs: scenario.timeoutMs,
                topology: provisioning.topology,
                patchGatewayConfig: async (patch, opts) => {
                  await patchMatrixQaGatewayConfig({
                    gateway: scenarioGateway.harness.gateway,
                    patch,
                    restartDelayMs: opts?.restartDelayMs,
                  });
                },
              }),
            ),
          );
          const result = measuredScenario.result;
          scenarioTimings[originalIndex] = {
            durationMs: measuredScenario.durationMs,
            gatewayBootMs,
            gatewayRestartMs,
            id: scenario.id,
            title: scenario.title,
            transportInterruptMs,
          };
          scenarioResults[originalIndex] = buildMatrixQaScenarioResult({
            artifacts: result.artifacts,
            configSummary: scenarioConfigSummary,
            details: result.details,
            scenario,
            status: "pass",
          });
          writeMatrixQaProgress(
            `scenario pass ${scenario.id} ${formatMatrixQaDurationMs(measuredScenario.durationMs)}`,
          );
        } catch (error) {
          scenarioTimings[originalIndex] = {
            durationMs: 0,
            gatewayBootMs,
            gatewayRestartMs,
            id: scenario.id,
            title: scenario.title,
            transportInterruptMs,
          };
          scenarioResults[originalIndex] = buildMatrixQaScenarioResult({
            configSummary: scenarioConfigSummary,
            details: formatErrorMessage(error),
            scenario,
            status: "fail",
          });
          writeMatrixQaProgress(`scenario fail ${scenario.id} ${formatErrorMessage(error)}`);
        }
      }
    }
  } finally {
    if (gatewayHarness) {
      try {
        await cleanupMatrixQaResource({
          label: "Matrix live gateway cleanup",
          action: () => gatewayHarness!.stop(),
        });
      } catch (error) {
        appendLiveLaneIssue(cleanupErrors, "live gateway cleanup", error);
      }
    }
    try {
      await cleanupMatrixQaResource({
        label: "Matrix homeserver cleanup",
        action: () => harness.stop(),
        recovery: harness.stopCommand,
      });
    } catch (error) {
      appendLiveLaneIssue(cleanupErrors, "Matrix harness cleanup", error);
    }
  }
  const completedScenarioResults = scenarioResults.filter(
    (scenario): scenario is MatrixQaScenarioResult => scenario !== undefined,
  );
  if (cleanupErrors.length > 0) {
    checks.push({
      name: "Matrix cleanup",
      status: "fail",
      details: cleanupErrors.join("\n"),
    });
  }

  const finishedAtDate = new Date();
  const finishedAt = finishedAtDate.toISOString();
  const reportPath = path.join(outputDir, "matrix-qa-report.md");
  const summaryPath = path.join(outputDir, "matrix-qa-summary.json");
  const observedEventsPath = path.join(outputDir, "matrix-qa-observed-events.json");
  const artifactPaths = {
    observedEvents: observedEventsPath,
    report: reportPath,
    summary: summaryPath,
  } satisfies MatrixQaArtifactPaths;
  const report = renderQaMarkdownReport({
    title: "Matrix QA Report",
    startedAt: startedAtDate,
    finishedAt: finishedAtDate,
    checks,
    scenarios: completedScenarioResults.map((scenario) => ({
      details: scenario.details,
      name: scenario.title,
      status: scenario.status,
    })),
    notes: [
      `roomId: ${provisioning.roomId}`,
      `roomIds: ${provisioning.topology.rooms.map((room) => room.roomId).join(", ")}`,
      `default config: ${summarizeMatrixQaConfigSnapshot(defaultConfigSnapshot)}`,
      `driver: ${provisioning.driver.userId}`,
      `observer: ${provisioning.observer.userId}`,
      `sut: ${provisioning.sut.userId}`,
      `homeserver: ${harness.baseUrl}`,
      `image: ${harness.image}`,
      `timings: harness=${harnessBootMs}ms provisioning=${provisioningMs}ms gateway=${initialGatewayBootMs}ms canary=${canaryMs ?? 0}ms`,
    ],
  });
  const artifactWriteStartedAtMs = Date.now();
  const summary: MatrixQaSummary = buildMatrixQaSummary({
    artifactPaths,
    canary: canaryArtifact,
    checks,
    config: {
      default: defaultConfigSnapshot,
      scenarios: scenarioConfigSnapshots,
    },
    finishedAt,
    harness: {
      baseUrl: harness.baseUrl,
      composeFile: harness.composeFile,
      dmRoomIds: provisioning.topology.rooms
        .filter((room) => room.kind === "dm")
        .map((room) => room.roomId),
      image: harness.image,
      roomId: provisioning.roomId,
      roomIds: provisioning.topology.rooms.map((room) => room.roomId),
      serverName: harness.serverName,
    },
    observedEventCount: observedEvents.length,
    scenarios: completedScenarioResults,
    startedAt,
    sutAccountId,
    timings: {
      artifactWriteMs: 0,
      canaryMs,
      harnessBootMs,
      initialGatewayBootMs,
      provisioningMs,
      scenarioGatewayBootMs,
      scenarioRestartGatewayMs,
      scenarioTransportInterruptMs,
      scenarios: scenarioTimings,
      totalMs: Date.now() - runStartedAtMs,
    },
    userIds: {
      driver: provisioning.driver.userId,
      observer: provisioning.observer.userId,
      sut: provisioning.sut.userId,
    },
  });

  await fs.writeFile(reportPath, `${report}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(
    observedEventsPath,
    `${JSON.stringify(
      buildMatrixQaObservedEventsArtifact({
        includeContent: includeObservedEventContent,
        observedEvents,
      }),
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  summary.timings.artifactWriteMs = Date.now() - artifactWriteStartedAtMs;
  summary.timings.totalMs = Date.now() - runStartedAtMs;
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeMatrixQaProgress(
    `suite ${summary.counts.failed > 0 ? "fail" : "pass"} ${summary.counts.passed}/${summary.counts.total} total=${formatMatrixQaDurationMs(summary.timings.totalMs)}`,
  );

  const failedChecks = checks.filter(
    (check) => check.status === "fail" && check.name !== "Matrix cleanup",
  );
  const failedScenarios = completedScenarioResults.filter((scenario) => scenario.status === "fail");
  if (failedChecks.length > 0 || failedScenarios.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Matrix QA failed.",
        details: [
          ...failedChecks.map((check) => `check ${check.name}: ${check.details ?? "failed"}`),
          ...failedScenarios.map((scenario) => `scenario ${scenario.id}: ${scenario.details}`),
          ...cleanupErrors.map((error) => `cleanup: ${error}`),
        ],
        artifacts: artifactPaths,
      }),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Matrix QA cleanup failed after artifacts were written.",
        details: cleanupErrors,
        artifacts: artifactPaths,
      }),
    );
  }

  return {
    observedEventsPath,
    outputDir,
    reportPath,
    scenarios: completedScenarioResults,
    summaryPath,
  };
}

export const __testing = {
  buildMatrixQaSummary,
  scheduleMatrixQaScenariosByConfig,
  MATRIX_QA_SCENARIOS,
  buildMatrixQaConfig,
  buildMatrixQaConfigSnapshot,
  createMatrixQaRunDeadline,
  findMatrixQaScenarios,
  isMatrixAccountReady,
  patchMatrixQaGatewayConfig,
  resolveMatrixQaModels,
  shouldWriteMatrixQaProgress,
  summarizeMatrixQaConfigSnapshot,
  waitForMatrixChannelReady,
};
