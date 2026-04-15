import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { loadQaRuntimeModule } from "openclaw/plugin-sdk/qa-runtime";
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
  restart(): Promise<void>;
};

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

function countMatrixQaStatuses<T extends { status: "fail" | "pass" | "skip" }>(entries: T[]) {
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
    userIds: params.userIds,
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

  const harness = await startMatrixQaHarness({
    outputDir: path.join(outputDir, "matrix-harness"),
    repoRoot,
  });
  const provisioning: MatrixQaProvisionResult = await (async () => {
    try {
      return await provisionMatrixQaRoom({
        baseUrl: harness.baseUrl,
        driverLocalpart: `qa-driver-${runSuffix}`,
        observerLocalpart: `qa-observer-${runSuffix}`,
        registrationToken: harness.registrationToken,
        roomName: `OpenClaw Matrix QA ${runSuffix}`,
        sutLocalpart: `qa-sut-${runSuffix}`,
        topology,
      });
    } catch (error) {
      await harness.stop().catch(() => {});
      throw error;
    }
  })();

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
        return gatewayHarness;
      }
      if (gatewayHarness) {
        await gatewayHarness.stop();
        gatewayHarness = null;
        gatewayHarnessKey = null;
      }
      const started = await startMatrixQaLiveLaneGateway({
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
      await waitForMatrixChannelReady(started.gateway, sutAccountId);
      gatewayHarness = started;
      gatewayHarnessKey = nextKey;
      return started;
    };

    gatewayHarness = await ensureGatewayHarness();
    checks.push({
      name: "Matrix channel ready",
      status: "pass",
      details: `accountId: ${sutAccountId}\nuserId: ${provisioning.sut.userId}`,
    });

    try {
      const canary = await runMatrixQaCanary({
        baseUrl: harness.baseUrl,
        driverAccessToken: provisioning.driver.accessToken,
        observedEvents,
        roomId: provisioning.roomId,
        syncState,
        sutUserId: provisioning.sut.userId,
        timeoutMs: 45_000,
      });
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
    } catch (error) {
      canaryFailed = true;
      checks.push({
        name: "Matrix canary",
        status: "fail",
        details: formatErrorMessage(error),
      });
    }

    if (!canaryFailed) {
      for (const { scenario, originalIndex } of scheduledScenarios) {
        const { entry: scenarioConfigEntry, summary: scenarioConfigSummary } =
          buildMatrixQaScenarioConfigEntry({
            gatewayConfigParams,
            scenario,
          });
        scenarioConfigSnapshots[originalIndex] = scenarioConfigEntry;
        try {
          const scenarioGateway = await ensureGatewayHarness(scenario.configOverrides);
          const result = await runMatrixQaScenario(scenario, {
            baseUrl: harness.baseUrl,
            canary: canaryArtifact,
            driverAccessToken: provisioning.driver.accessToken,
            driverUserId: provisioning.driver.userId,
            interruptTransport: async () => {
              await harness.restartService();
              await waitForMatrixChannelReady(scenarioGateway.gateway, sutAccountId, {
                timeoutMs: 90_000,
              });
            },
            observedEvents,
            observerAccessToken: provisioning.observer.accessToken,
            observerUserId: provisioning.observer.userId,
            restartGateway: async () => {
              if (!gatewayHarness) {
                throw new Error("Matrix restart scenario requires a live gateway");
              }
              await scenarioGateway.gateway.restart();
              await waitForMatrixChannelReady(scenarioGateway.gateway, sutAccountId);
            },
            roomId: provisioning.roomId,
            sutAccessToken: provisioning.sut.accessToken,
            syncState,
            sutUserId: provisioning.sut.userId,
            timeoutMs: scenario.timeoutMs,
            topology: provisioning.topology,
          });
          scenarioResults[originalIndex] = buildMatrixQaScenarioResult({
            artifacts: result.artifacts,
            configSummary: scenarioConfigSummary,
            details: result.details,
            scenario,
            status: "pass",
          });
        } catch (error) {
          scenarioResults[originalIndex] = buildMatrixQaScenarioResult({
            configSummary: scenarioConfigSummary,
            details: formatErrorMessage(error),
            scenario,
            status: "fail",
          });
        }
      }
    }
  } finally {
    if (gatewayHarness) {
      try {
        await gatewayHarness.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupErrors, "live gateway cleanup", error);
      }
    }
    try {
      await harness.stop();
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
    ],
  });
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
    userIds: {
      driver: provisioning.driver.userId,
      observer: provisioning.observer.userId,
      sut: provisioning.sut.userId,
    },
  });

  await fs.writeFile(reportPath, `${report}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
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
  findMatrixQaScenarios,
  isMatrixAccountReady,
  resolveMatrixQaModels,
  summarizeMatrixQaConfigSnapshot,
  waitForMatrixChannelReady,
};
