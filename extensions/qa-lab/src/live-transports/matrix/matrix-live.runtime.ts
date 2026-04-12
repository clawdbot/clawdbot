import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild } from "../../gateway-child.js";
import type { QaReportCheck } from "../../report.js";
import { renderQaMarkdownReport } from "../../report.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import { appendLiveLaneIssue, buildLiveLaneArtifactsError } from "../shared/live-lane-helpers.js";
import {
  provisionMatrixQaRoom,
  type MatrixQaObservedEvent,
  type MatrixQaProvisionResult,
} from "./matrix-driver-client.js";
import { startMatrixQaHarness } from "./matrix-harness.runtime.js";
import {
  MATRIX_QA_SCENARIOS,
  buildMatrixReplyDetails,
  findMatrixQaScenarios,
  runMatrixQaCanary,
  runMatrixQaScenario,
  type MatrixQaCanaryArtifact,
  type MatrixQaScenarioArtifacts,
} from "./matrix-live-scenarios.js";

type MatrixQaScenarioResult = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
  id: string;
  status: "fail" | "pass";
  title: string;
};

type MatrixQaSummary = {
  checks: QaReportCheck[];
  counts: {
    failed: number;
    passed: number;
    total: number;
  };
  finishedAt: string;
  harness: {
    baseUrl: string;
    composeFile: string;
    image: string;
    roomId: string;
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
  finishedAt: string;
  harness: MatrixQaSummary["harness"];
  observedEventCount: number;
  scenarios: MatrixQaScenarioResult[];
  startedAt: string;
  sutAccountId: string;
  userIds: MatrixQaSummary["userIds"];
}): MatrixQaSummary {
  return {
    checks: params.checks,
    counts: {
      total: params.checks.length + params.scenarios.length,
      passed:
        params.checks.filter((check) => check.status === "pass").length +
        params.scenarios.filter((scenario) => scenario.status === "pass").length,
      failed:
        params.checks.filter((check) => check.status === "fail").length +
        params.scenarios.filter((scenario) => scenario.status === "fail").length,
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

function buildMatrixQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    driverUserId: string;
    homeserver: string;
    roomId: string;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "matrix"])];
  return {
    ...baseCfg,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        matrix: { enabled: true },
      },
    },
    channels: {
      ...baseCfg.channels,
      matrix: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            accessToken: params.sutAccessToken,
            ...(params.sutDeviceId ? { deviceId: params.sutDeviceId } : {}),
            dm: { enabled: false },
            enabled: true,
            encryption: false,
            groupAllowFrom: [params.driverUserId],
            groupPolicy: "allowlist",
            groups: {
              [params.roomId]: {
                enabled: true,
                requireMention: true,
              },
            },
            homeserver: params.homeserver,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            replyToMode: "off",
            threadReplies: "inbound",
            userId: params.sutUserId,
          },
        },
      },
    },
  };
}

function buildObservedEventsArtifact(params: {
  includeContent: boolean;
  observedEvents: MatrixQaObservedEvent[];
}) {
  return params.observedEvents.map((event) =>
    params.includeContent
      ? event
      : {
          roomId: event.roomId,
          eventId: event.eventId,
          sender: event.sender,
          stateKey: event.stateKey,
          type: event.type,
          originServerTs: event.originServerTs,
          msgtype: event.msgtype,
          membership: event.membership,
          relatesTo: event.relatesTo,
          mentions: event.mentions,
          reaction: event.reaction,
        },
  );
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
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
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

  const providerMode = normalizeQaProviderMode(params.providerMode ?? "live-frontier");
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findMatrixQaScenarios(params.scenarioIds);
  const observedEvents: MatrixQaObservedEvent[] = [];
  const includeObservedEventContent = process.env.OPENCLAW_QA_MATRIX_CAPTURE_CONTENT === "1";
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const runSuffix = randomUUID().slice(0, 8);

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
      ].join("\n"),
    },
  ];
  const scenarioResults: MatrixQaScenarioResult[] = [];
  const cleanupErrors: string[] = [];
  let canaryArtifact: MatrixQaCanaryArtifact | undefined;
  let gatewayHarness: Awaited<ReturnType<typeof startQaLiveLaneGateway>> | null = null;
  let canaryFailed = false;
  const syncState: { driver?: string; observer?: string } = {};

  try {
    gatewayHarness = await startQaLiveLaneGateway({
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
          driverUserId: provisioning.driver.userId,
          homeserver: harness.baseUrl,
          roomId: provisioning.roomId,
          sutAccessToken: provisioning.sut.accessToken,
          sutAccountId,
          sutDeviceId: provisioning.sut.deviceId,
          sutUserId: provisioning.sut.userId,
        }),
    });
    await waitForMatrixChannelReady(gatewayHarness.gateway, sutAccountId);
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
      for (const scenario of scenarios) {
        try {
          const result = await runMatrixQaScenario(scenario, {
            baseUrl: harness.baseUrl,
            canary: canaryArtifact,
            driverAccessToken: provisioning.driver.accessToken,
            driverUserId: provisioning.driver.userId,
            observedEvents,
            observerAccessToken: provisioning.observer.accessToken,
            observerUserId: provisioning.observer.userId,
            restartGateway: async () => {
              if (!gatewayHarness) {
                throw new Error("Matrix restart scenario requires a live gateway");
              }
              await gatewayHarness.gateway.restart();
              await waitForMatrixChannelReady(gatewayHarness.gateway, sutAccountId);
            },
            roomId: provisioning.roomId,
            syncState,
            sutUserId: provisioning.sut.userId,
            timeoutMs: scenario.timeoutMs,
          });
          scenarioResults.push({
            artifacts: result.artifacts,
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: result.details,
          });
        } catch (error) {
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "fail",
            details: formatErrorMessage(error),
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
    scenarios: scenarioResults.map((scenario) => ({
      details: scenario.details,
      name: scenario.title,
      status: scenario.status,
    })),
    notes: [
      `roomId: ${provisioning.roomId}`,
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
    finishedAt,
    harness: {
      baseUrl: harness.baseUrl,
      composeFile: harness.composeFile,
      image: harness.image,
      roomId: provisioning.roomId,
      serverName: harness.serverName,
    },
    observedEventCount: observedEvents.length,
    scenarios: scenarioResults,
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
      buildObservedEventsArtifact({
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
  const failedScenarios = scenarioResults.filter((scenario) => scenario.status === "fail");
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
    scenarios: scenarioResults,
    summaryPath,
  };
}

export const __testing = {
  buildMatrixQaSummary,
  MATRIX_QA_SCENARIOS,
  buildMatrixQaConfig,
  buildObservedEventsArtifact,
  isMatrixAccountReady,
  waitForMatrixChannelReady,
};
