import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { createCronServiceState } from "../../../../src/cron/service/state.js";
import {
  tryCreateCronTaskRunHandle,
  tryFinishCronTaskRun,
} from "../../../../src/cron/service/task-runs.js";
import { saveCronStore } from "../../../../src/cron/store.js";
import type { CronJob } from "../../../../src/cron/types.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../../../../src/tasks/task-runtime.test-helpers.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const GATEWAY_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  resetTaskRegistryForTests({ persist: false });
}

function cronJob(params: {
  id: string;
  startedAtMs: number;
  enabled?: boolean;
  nextRunAtMs: number;
  recurring?: boolean;
}): CronJob {
  return {
    id: params.id,
    agentId: "main",
    name: params.id,
    enabled: params.enabled ?? true,
    createdAtMs: params.startedAtMs - 1,
    updatedAtMs: params.startedAtMs - 1,
    schedule: params.recurring
      ? { kind: "every", everyMs: 60_000, anchorMs: params.startedAtMs }
      : { kind: "at", at: new Date(params.startedAtMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Gateway startup recovery proof" },
    state: { runningAtMs: params.startedAtMs, nextRunAtMs: params.nextRunAtMs },
  };
}

describe("Gateway cron startup recovery", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it("reports lifecycle-owned retry and disable state through cron.list", async () => {
    const envSnapshot = captureEnv([...GATEWAY_ENV_KEYS]);
    const tempHome = tempDirs.make("openclaw-gateway-cron-recovery-");
    const stateDir = path.join(tempHome, ".openclaw");
    const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(bundledPluginsDir, { recursive: true }),
    ]);

    const token = `gateway-cron-recovery-${process.pid}`;
    for (const [key, value] of Object.entries({
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "0",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    })) {
      setTestEnvValue(key, value);
    }
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    closeOpenClawStateDatabaseForTest();
    resetTaskRegistryForTests({ persist: false });

    const startedAtMs = Date.now() - 30_000;
    const endedAtMs = startedAtMs + 2_000;
    const persistedRetryAtMs = Date.now() + 120_000;
    const historyRetryAtMs = Date.now() + 60_000;
    const jobs = [
      cronJob({
        id: "persisted-retry-without-history",
        startedAtMs,
        nextRunAtMs: persistedRetryAtMs,
      }),
      cronJob({ id: "persisted-retry", startedAtMs, nextRunAtMs: persistedRetryAtMs }),
      cronJob({ id: "history-retry", startedAtMs, nextRunAtMs: startedAtMs }),
      cronJob({
        id: "persisted-disable",
        startedAtMs,
        enabled: false,
        nextRunAtMs: startedAtMs,
      }),
      cronJob({
        id: "recurring-history",
        startedAtMs,
        nextRunAtMs: startedAtMs,
        recurring: true,
      }),
    ];
    const historyNextRunAtMs = new Map<string, number | undefined>([
      ["persisted-retry-without-history", undefined],
      ["persisted-retry", historyRetryAtMs],
      ["history-retry", historyRetryAtMs],
      ["persisted-disable", historyRetryAtMs],
      ["recurring-history", historyRetryAtMs],
    ]);
    const storePath = path.join(stateDir, "cron", "jobs.json");
    const executionState = createCronServiceState({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => endedAtMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });

    for (const job of jobs) {
      const taskRunId = tryCreateCronTaskRunHandle({
        state: executionState,
        job,
        startedAt: startedAtMs,
      })?.runId;
      if (!taskRunId) {
        throw new Error(`task history was not created for ${job.id}`);
      }
      tryFinishCronTaskRun(executionState, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: 'Session "agent:main:cron:recovery" changed while starting work. Retry.',
          runAtMs: startedAtMs,
          durationMs: endedAtMs - startedAtMs,
          nextRunAtMs: historyNextRunAtMs.get(job.id),
        },
      });
    }
    await saveCronStore(storePath, { version: 1, jobs });

    const config = {
      agents: {
        defaults: { workspace: path.join(tempHome, "workspace"), skipBootstrap: true },
        entries: { main: { default: true } },
      },
      gateway: { auth: { mode: "token", token } },
      plugins: { slots: { memory: "none" } },
    } satisfies OpenClawConfig;

    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath,
        token,
        clientDisplayName: "vitest-gateway-cron-startup-recovery",
      });
      await gateway.server.startupSettled;
      const response = await gateway.client.request<{
        jobs: Array<{ id: string; enabled: boolean; state: { nextRunAtMs?: number } }>;
      }>("cron.list", { includeDisabled: true });
      const recovered = new Map(response.jobs.map((job) => [job.id, job] as const));

      expect(recovered.get("persisted-retry-without-history")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: persistedRetryAtMs },
      });
      expect(recovered.get("persisted-retry")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: persistedRetryAtMs },
      });
      expect(recovered.get("history-retry")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: historyRetryAtMs },
      });
      expect(recovered.get("persisted-disable")?.enabled).toBe(false);
      expect(recovered.get("persisted-disable")?.state.nextRunAtMs).toBeUndefined();
      expect(recovered.get("recurring-history")).toMatchObject({
        enabled: true,
        state: { nextRunAtMs: historyRetryAtMs },
      });
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Gateway cron startup recovery test complete" });
      }
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
    }
  });
});
