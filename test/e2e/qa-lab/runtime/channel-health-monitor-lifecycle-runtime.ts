import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChannelAccountSnapshot,
  ChannelId,
} from "../../../../src/channels/plugins/types.public.js";
import { startChannelHealthMonitor } from "../../../../src/gateway/channel-health-monitor.js";
import {
  evaluateChannelHealth,
  type ChannelHealthPolicy,
} from "../../../../src/gateway/channel-health-policy.js";
import type { ChannelRuntimeSnapshot } from "../../../../src/gateway/server-channel-runtime.types.js";
import type { ChannelManager } from "../../../../src/gateway/server-channels.js";
import { resetLogger, setLoggerOverride } from "../../../../src/logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../../../src/logging/test-helpers/diagnostic-log-capture.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/channel-health-monitor-lifecycle-runtime.ts";
const SCENARIO_PATH = "qa/scenarios/observability/channel-health-monitor-lifecycle.yaml";

type MonitorProof = {
  graceRespected: boolean;
  operationOrder: string[];
  restartLog: string;
  policyReasons: string[];
  singleFlight: boolean;
  settledRearmed: boolean;
  cooldownBounded: boolean;
  hourlyCapLogged: boolean;
  failureRecovered: boolean;
  shutdownStoppedChecks: boolean;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function snapshot(account: ChannelAccountSnapshot): ChannelRuntimeSnapshot {
  return {
    channels: { "qa-channel": account },
    channelAccounts: { "qa-channel": { monitored: account } },
  };
}

function policyReason(value: Record<string, unknown>, policy: ChannelHealthPolicy): string {
  return evaluateChannelHealth(value, policy).reason;
}

async function captureMonitorLogs(
  run: () => Promise<Omit<MonitorProof, "restartLog" | "hourlyCapLogged">>,
) {
  // openclaw-temp-dir: standalone producer removes this log root in its finally block
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-health-monitor-proof-"));
  const capture = createDiagnosticLogRecordCapture();
  setLoggerOverride({
    level: "info",
    consoleLevel: "silent",
    file: path.join(logDir, "monitor.log"),
  });
  try {
    const proof = await run();
    await capture.flush();
    const messages = capture.records.map((record) => record.message);
    const restartLog =
      messages.find((message) =>
        message.includes(
          "[qa-channel:monitored] health-monitor: restarting (reason: disconnected)",
        ),
      ) ?? "";
    return {
      ...proof,
      restartLog,
      hourlyCapLogged: messages.some((message) =>
        message.includes("health-monitor: hit 1 restarts/hour limit, skipping"),
      ),
    };
  } finally {
    capture.cleanup();
    setLoggerOverride(null);
    resetLogger();
    await fs.rm(logDir, { recursive: true, force: true });
  }
}

export async function runChannelHealthMonitorLifecycleProof(): Promise<MonitorProof> {
  return await captureMonitorLogs(async () => {
    const now = Date.now();
    const policy = {
      channelId: "qa-channel" as ChannelId,
      now,
      channelConnectGraceMs: 100,
      staleEventThresholdMs: 100,
    };
    const policyReasons = [
      policyReason(
        { running: true, connected: false, lastStartAt: now - 20, enabled: true, configured: true },
        policy,
      ),
      policyReason(
        {
          running: true,
          connected: true,
          lastStartAt: now - 1_000,
          lastTransportActivityAt: now - 1_000,
          enabled: true,
          configured: true,
        },
        policy,
      ),
      policyReason(
        {
          running: true,
          connected: false,
          busy: true,
          activeRuns: 1,
          lastRunActivityAt: now - 1_000,
          activeRunStartedAt: now - 1_000,
          enabled: true,
          configured: true,
        },
        policy,
      ),
      policyReason(
        {
          running: true,
          connected: false,
          busy: true,
          activeRuns: 1,
          lastRunActivityAt: now - 26 * 60_000,
          activeRunStartedAt: now - 26 * 60_000,
          enabled: true,
          configured: true,
        },
        policy,
      ),
    ];

    const operations: string[] = [];
    let snapshotCalls = 0;
    let activeSnapshots = 0;
    let maxActiveSnapshots = 0;
    let failNextSnapshot = true;
    let account: ChannelAccountSnapshot = {
      accountId: "monitored",
      running: true,
      connected: false,
      enabled: true,
      configured: true,
      lastStartAt: now - 1_000,
    };
    const manager = {
      getRuntimeSnapshot() {
        snapshotCalls += 1;
        activeSnapshots += 1;
        maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
        try {
          if (failNextSnapshot) {
            failNextSnapshot = false;
            throw new Error("controlled snapshot failure");
          }
          operations.push("snapshot");
          return snapshot(account);
        } finally {
          activeSnapshots -= 1;
        }
      },
      async stopChannel(channelId: ChannelId, accountId: string, options: { manual: boolean }) {
        operations.push(`stop:${channelId}:${accountId}:${String(options.manual)}`);
        await sleep(35);
      },
      resetRestartAttempts(channelId: ChannelId, accountId: string) {
        operations.push(`reset:${channelId}:${accountId}`);
      },
      async startChannel(channelId: ChannelId, accountId: string) {
        operations.push(`start:${channelId}:${accountId}`);
        account = {
          ...account,
          running: true,
          connected: true,
          lastStartAt: Date.now(),
          lastTransportActivityAt: Date.now(),
        };
      },
      getAutostartSuppression: () => null,
      recoverAutostartSuppression: async () => false,
      isAmbientAutostartSuppressed: () => false,
      isHealthMonitorEnabled: () => true,
      isManuallyStopped: () => false,
      isAutoRestartScheduled: () => false,
    } as unknown as ChannelManager;

    const monitor = startChannelHealthMonitor({
      channelManager: manager,
      checkIntervalMs: 20,
      cooldownCycles: 2,
      maxRestartsPerHour: 1,
      timing: {
        monitorStartupGraceMs: 250,
        channelConnectGraceMs: 0,
        staleEventThresholdMs: 100,
      },
    });

    await sleep(40);
    const graceRespected = snapshotCalls === 0;
    await waitFor(() => operations.includes("start:qa-channel:monitored"), "first restart");
    await waitFor(() => snapshotCalls >= 3, "settled rearm");
    const callsAfterRecovery = snapshotCalls;
    await sleep(55);
    const settledRearmed = snapshotCalls > callsAfterRecovery;
    const failureRecovered = operations.filter((entry) => entry === "snapshot").length >= 2;

    account = {
      ...account,
      connected: false,
      lastStartAt: Date.now() - 1_000,
    };
    await sleep(90);
    const startCount = operations.filter((entry) => entry.startsWith("start:")).length;
    const cooldownBounded = startCount === 1;

    monitor.shutdown();
    await monitor.waitForIdle();
    const callsAtShutdown = snapshotCalls;
    await sleep(50);

    return {
      graceRespected,
      operationOrder: operations.filter((entry) => entry !== "snapshot"),
      policyReasons,
      singleFlight: maxActiveSnapshots === 1,
      settledRearmed,
      cooldownBounded,
      failureRecovered,
      shutdownStoppedChecks: snapshotCalls === callsAtShutdown,
    };
  });
}

function parseArtifactBase(argv: readonly string[]) {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

export async function main(argv = process.argv.slice(2)) {
  const artifactBase = parseArtifactBase(argv);
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const writer = createQaScriptEvidenceWriter({
    artifactBase,
    logFileName: "channel-health-monitor-lifecycle.log",
    primaryModel: "none",
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: "channel-health-monitor-lifecycle",
      title: "Channel health monitor lifecycle",
      sourcePath: SCENARIO_PATH,
      docsRefs: ["docs/gateway/health.md"],
      codeRefs: [SOURCE_PATH, "src/gateway/channel-health-monitor.ts"],
    },
  });
  const startedAt = Date.now();
  try {
    const proof = await runChannelHealthMonitorLifecycleProof();
    const expectedOrder = [
      "stop:qa-channel:monitored:false",
      "reset:qa-channel:monitored",
      "start:qa-channel:monitored",
    ];
    const failures = [
      !proof.graceRespected && "startup grace was not respected",
      proof.operationOrder.slice(0, 3).join("|") !== expectedOrder.join("|") &&
        `restart order was ${proof.operationOrder.join(",")}`,
      !proof.restartLog && "restart reason log was not captured",
      proof.policyReasons.join("|") !==
        ["startup-connect-grace", "stale-socket", "busy", "stuck"].join("|") &&
        `policy reasons were ${proof.policyReasons.join(",")}`,
      !proof.singleFlight && "checks overlapped",
      !proof.settledRearmed && "settled check did not rearm",
      !proof.cooldownBounded && "cooldown/hour cap allowed another restart",
      !proof.hourlyCapLogged && "hourly cap warning was not captured",
      !proof.failureRecovered && "loop did not recover from snapshot failure",
      !proof.shutdownStoppedChecks && "checks continued after shutdown",
    ].filter((value): value is string => Boolean(value));
    writer.appendLog(`${JSON.stringify(proof, null, 2)}\n`);
    await writer.write({
      status: failures.length === 0 ? "pass" : "fail",
      durationMs: Date.now() - startedAt,
      details:
        failures.length === 0
          ? "production monitor lifecycle boundaries passed"
          : failures.join("; "),
    });
    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  } catch (error) {
    writer.appendLog(`${error instanceof Error ? error.stack : String(error)}\n`);
    await writer.write({
      status: "fail",
      durationMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
