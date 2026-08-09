// Live proof for Codex native subagent monitoring against a real app-server:
// spawned-child lineage, detached completion delivery, and history recovery.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { codexNativeSubagentRunId } from "./native-subagent-task-mirror.js";
import type { JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const CodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.Monitor;

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_NATIVE_SUBAGENT === "1";
const describeLive = LIVE ? describe : describe.skip;

type RecordedDelivery = {
  childSessionId: string;
  status: string;
  result: string;
};

function createDeliveryRecorder(taskRecords: AgentHarnessTaskRecord[] = []) {
  const deliveries: RecordedDelivery[] = [];
  const taskRuntime = {
    tryCreateRunningTaskRun: (params: { runId?: string }) =>
      ({ runId: params.runId }) as AgentHarnessTaskRecord,
    recordTaskRunProgressByRunId: () => [],
    finalizeTaskRunByRunId: () => [],
    listTaskRecords: () => taskRecords,
    setDetachedTaskDeliveryStatusByRunId: () => [],
  };
  return {
    deliveries,
    runtime: {
      createAgentHarnessTaskRuntime: () => taskRuntime,
      deliverAgentHarnessTaskCompletion: async (params: RecordedDelivery) => {
        deliveries.push({
          childSessionId: params.childSessionId,
          status: params.status,
          result: params.result,
        });
        return { delivered: true, path: "steered" as const };
      },
    } as never,
  };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describeLive("codex native subagent monitor live", () => {
  it("delivers spawned subagent results live and recovers them from history", async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for this live test");
    }
    await withTempDir("openclaw-codex-native-subagent-", async (root) => {
      let client: CodexAppServerClient | undefined;
      try {
        const codexHome = path.join(root, "codex-home");
        const workspace = path.join(root, "workspace");
        await fs.mkdir(workspace, { recursive: true });
        const runtime = resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { homeScope: "user" } },
          env: {},
        });
        client = await createIsolatedCodexAppServerClient({
          startOptions: {
            ...runtime.start,
            env: { CODEX_HOME: codexHome },
            clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          },
          agentDir: path.join(root, "agent"),
          authProfileId: null,
          timeoutMs: 120_000,
        });
        await client.request(
          "account/login/start",
          { type: "apiKey", apiKey },
          { timeoutMs: 60_000 },
        );

        let parentThreadId = "";
        let parentTurnCompleted = false;
        client.addNotificationHandler((notification) => {
          if (notification.method !== "turn/completed") {
            return;
          }
          const params = isJsonObject(notification.params) ? notification.params : undefined;
          if (params?.threadId === parentThreadId) {
            parentTurnCompleted = true;
          }
        });

        const started = await client.request(
          "thread/start",
          {
            model: "gpt-5.5",
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            threadSource: "user",
            experimentalRawEvents: true,
            config: { "features.multi_agent": true },
          },
          { timeoutMs: 120_000 },
        );
        parentThreadId = started.thread.id;

        const streamed = createDeliveryRecorder();
        const monitor = new CodexNativeSubagentMonitor(client as never, streamed.runtime);
        monitor.registerParent({
          parentThreadId,
          requesterSessionKey: "live:streamed",
          taskRuntimeScope: {
            requesterSessionKey: "live:streamed",
          } as AgentHarnessTaskRuntimeScope,
          agentId: "live",
        });

        // Detached-child scenario: the parent replies immediately while the
        // child still owes its own model round (plus a sleep for margin), so
        // the parent turn completes first, like an OpenClaw run cleaning up
        // after yield while its native subagent is still working.
        await client.request(
          "turn/start",
          {
            threadId: parentThreadId,
            input: [
              {
                type: "text",
                text: "Spawn exactly one subagent with this exact task: 'First run the shell command sleep 20 and wait for it to finish. Then reply with exactly the word BANANA42.' Do not wait for the subagent to finish. Reply DONE immediately after spawning it.",
              },
            ],
          },
          { timeoutMs: 300_000 },
        );

        await waitFor(
          () => (parentTurnCompleted ? true : undefined),
          300_000,
          "parent turn completion",
        );
        // The child is still sleeping when the parent turn ends; delivery after
        // this point proves the detached path, not same-turn streaming.
        expect(streamed.deliveries).toHaveLength(0);

        const delivery = await waitFor(
          () => streamed.deliveries[0],
          420_000,
          "detached child completion delivery",
        );
        expect(delivery.status).toBe("succeeded");
        expect(delivery.result).toMatch(/BANANA42/iu);
        const childThreadId = delivery.childSessionId;

        // Canonical protocol shape: lineage plus terminal turn from history.
        const read = await client.request(
          "thread/read",
          { threadId: childThreadId, includeTurns: true },
          { timeoutMs: 60_000 },
        );
        expect((read.thread as unknown as JsonObject).parentThreadId).toBe(parentThreadId);
        const turns = read.thread.turns ?? [];
        expect(turns.at(-1)?.status).toBe("completed");

        const page = await client.request(
          "thread/turns/list",
          { threadId: childThreadId, limit: 1, sortDirection: "desc", itemsView: "full" },
          { timeoutMs: 60_000 },
        );
        const pageTurns = isJsonObject(page) && Array.isArray(page.data) ? page.data : [];
        const latestTurn = isJsonObject(pageTurns[0]) ? pageTurns[0] : undefined;
        expect(latestTurn?.status).toBe("completed");

        // Fresh-monitor recovery: no streamed state, only a persisted task row.
        const recoveryRunId = codexNativeSubagentRunId(childThreadId);
        const recovery = createDeliveryRecorder([
          {
            taskId: recoveryRunId,
            runtime: "subagent",
            taskKind: "codex-native",
            sourceId: recoveryRunId,
            requesterSessionKey: "live:recovery",
            ownerKey: "live:recovery",
            scopeKind: "session",
            agentId: "live",
            runId: recoveryRunId,
            label: "Codex subagent",
            task: "live recovery probe",
            status: "running",
            deliveryStatus: "not_applicable",
            notifyPolicy: "silent",
            createdAt: Date.now(),
          } as AgentHarnessTaskRecord,
        ]);
        const recoveryMonitor = new CodexNativeSubagentMonitor(client as never, recovery.runtime);
        recoveryMonitor.registerParent({
          parentThreadId,
          requesterSessionKey: "live:recovery",
          taskRuntimeScope: {
            requesterSessionKey: "live:recovery",
          } as AgentHarnessTaskRuntimeScope,
          agentId: "live",
        });
        const recovered = await waitFor(
          () => recovery.deliveries[0],
          120_000,
          "history-based completion recovery",
        );
        expect(recovered.childSessionId).toBe(childThreadId);
        expect(recovered.status).toBe("succeeded");
        expect(recovered.result).toMatch(/BANANA42/iu);
      } finally {
        await client?.closeAndWait();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    });
  }, 900_000);
});
