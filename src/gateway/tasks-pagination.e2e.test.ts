import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TasksListResult } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { markTaskTerminalById } from "../tasks/runtime-internal.js";
import { reloadTaskRegistryFromStore } from "../tasks/task-registry.js";
import { saveTaskRegistryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const ISOLATED_ENV_KEYS = [
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
  resetTaskRegistryForTests({ persist: false });
  closeOpenClawAgentDatabasesForTest();
}

function snapshotTask(taskId: string, lastEventAt: number): TaskRecord {
  return {
    taskId,
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: `run-${taskId}`,
    task: `Task ${taskId}`,
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: lastEventAt,
    startedAt: lastEventAt,
    lastEventAt,
  };
}

async function listEveryTask(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  limit: number,
): Promise<string[]> {
  const taskIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request<TasksListResult>("tasks.list", {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    taskIds.push(...page.tasks.map((task) => task.id));
    cursor = page.nextCursor;
  } while (cursor);
  return taskIds;
}

describe("Gateway task pagination", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it(
    "restarts a traversal instead of returning mixed task order",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...ISOLATED_ENV_KEYS]);
      const tempHome = tempDirs.make("openclaw-task-pagination-");
      const stateDir = path.join(tempHome, ".openclaw");
      const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      const token = `task-pagination-${process.pid}`;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await Promise.all([
          fs.mkdir(stateDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        const initialTasks = [
          snapshotTask("task-a", 4_000),
          snapshotTask("task-b", 3_000),
          snapshotTask("task-c", 2_000),
          snapshotTask("task-d", 1_000),
        ];
        saveTaskRegistryStateToSqlite({
          tasks: new Map(initialTasks.map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        });
        reloadTaskRegistryFromStore();

        const config = {
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-task-pagination",
        });

        const baseline = await listEveryTask(gateway.client, 2);
        expect(new Set(baseline)).toEqual(new Set(["task-a", "task-b", "task-c", "task-d"]));
        expect(new Set(baseline).size).toBe(baseline.length);

        const page1 = await gateway.client.request<TasksListResult>("tasks.list", { limit: 2 });
        expect(page1.tasks.map((task) => task.id)).toEqual(baseline.slice(0, 2));
        expect(page1.nextCursor).toBeTypeOf("string");

        const reorderedTaskId = baseline.at(-1);
        if (!reorderedTaskId) {
          throw new Error("expected a task outside the first page");
        }
        markTaskTerminalById({
          taskId: reorderedTaskId,
          status: "succeeded",
          endedAt: Date.now(),
          terminalSummary: "Task moved ahead of the first page",
        });

        await expect(
          gateway.client.request<TasksListResult>("tasks.list", {
            limit: 2,
            cursor: page1.nextCursor,
          }),
        ).rejects.toMatchObject({
          gatewayCode: "INVALID_REQUEST",
          details: { code: "TASKS_LIST_CURSOR_STALE" },
        });

        const restarted = await listEveryTask(gateway.client, 2);
        expect(new Set(restarted)).toEqual(new Set(["task-a", "task-b", "task-c", "task-d"]));
        expect(new Set(restarted).size).toBe(restarted.length);
      } finally {
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "task pagination E2E complete" });
            }
          }
        } finally {
          try {
            resetGatewayState();
          } finally {
            envSnapshot.restore();
          }
        }
      }
    },
  );
});
