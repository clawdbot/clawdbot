import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  TasksCancelResult,
  TasksGetResult,
  TasksListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../../../../src/config/config.js";
import { resetConfigOverrides } from "../../../../src/config/runtime-overrides.js";
import { clearSessionStoreCacheForTest } from "../../../../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import { resetAgentEventsForTest } from "../../../../src/infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../../src/infra/system-events.js";
import { resetTaskRegistryForTests } from "../../../../src/tasks/task-runtime.test-helpers.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const ISOLATED_GATEWAY_ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

let sequence = 0;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  resetTaskRegistryForTests({ persist: false });
}

function writeResponsesEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function writeAssistantResponse(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: nextId("provider-message"),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeResponsesEvents(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: nextId("provider-response"),
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

describe("Gateway task and automation RPCs", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it(
    "persists cron CRUD, wakes the heartbeat, and controls an agent-created task",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...ISOLATED_GATEWAY_ENV_KEYS]);
      const tempHome = tempDirs.make("openclaw-gateway-automation-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledPluginsDir = path.join(tempHome, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      await Promise.all([
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(path.dirname(configPath), { recursive: true }),
      ]);
      await fs.writeFile(
        path.join(workspaceDir, "HEARTBEAT.md"),
        "Handle pending system events, then reply with a concise acknowledgement.\n",
      );

      const token = nextId("gateway-automation-token");
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
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");

      const taskPrompt = nextId("create-tracked-task");
      const wakeText = nextId("wake-heartbeat");
      const providerRequests: Array<Record<string, unknown>> = [];
      let releaseTaskResponse: (() => void) | undefined;
      const taskResponseGate = new Promise<void>((resolve) => {
        releaseTaskResponse = resolve;
      });
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          providerRequests.push(body);
          const serialized = JSON.stringify(body);
          if (providerRequests.length === 1 && serialized.includes(taskPrompt)) {
            await taskResponseGate;
            writeAssistantResponse(response, "Tracked task completed.");
            return;
          }
          writeAssistantResponse(response, `Heartbeat handled: ${wakeText}`);
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("mock OpenAI Responses server did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
          "gpt-gateway-automation",
        );
        const config = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              heartbeat: { every: "5m" },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                models: provider.config.models.map((model) => ({
                  ...model,
                  input: Array.from(model.input),
                })),
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg: config,
          configPath,
          token,
          clientDisplayName: "vitest-gateway-rpc-automation",
        });
        const runtimeConfig = getRuntimeConfigSnapshot();
        if (!runtimeConfig) {
          throw new Error("gateway runtime config snapshot was not initialized");
        }
        withFastReplyConfig(runtimeConfig);
        const client = gateway.client;

        const added = await client.request<{ id: string; name: string }>("cron.add", {
          name: "Gateway automation evidence",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Future automation evidence" },
        });
        expect(added).toMatchObject({ name: "Gateway automation evidence" });

        const read = await client.request<{ id: string; name: string }>("cron.get", {
          id: added.id,
        });
        expect(read).toMatchObject({ id: added.id, name: "Gateway automation evidence" });

        const listed = await client.request<{
          jobs: Array<{ id: string; name: string; enabled: boolean }>;
        }>("cron.list", { includeDisabled: true });
        expect(listed.jobs).toContainEqual(
          expect.objectContaining({ id: added.id, name: added.name, enabled: true }),
        );

        const updated = await client.request<{ id: string; name: string; enabled: boolean }>(
          "cron.update",
          {
            id: added.id,
            patch: { name: "Gateway automation evidence updated", enabled: false },
          },
        );
        expect(updated).toMatchObject({
          id: added.id,
          name: "Gateway automation evidence updated",
          enabled: false,
        });

        const listedAfterUpdate = await client.request<{
          jobs: Array<{ id: string; name: string; enabled: boolean }>;
        }>("cron.list", { includeDisabled: true });
        expect(listedAfterUpdate.jobs).toContainEqual(
          expect.objectContaining({
            id: added.id,
            name: "Gateway automation evidence updated",
            enabled: false,
          }),
        );

        const removed = await client.request<{ removed: boolean }>("cron.remove", { id: added.id });
        expect(removed.removed).toBe(true);
        const listedAfterRemove = await client.request<{
          jobs: Array<{ id: string }>;
        }>("cron.list", { includeDisabled: true });
        expect(listedAfterRemove.jobs).not.toContainEqual(
          expect.objectContaining({ id: added.id }),
        );

        const sessionKey = "agent:main:main";
        const runId = nextId("gateway-automation-agent");
        const started = await client.request<{ runId: string; status: string }>(
          "agent",
          {
            sessionKey,
            message: taskPrompt,
            deliver: false,
            idempotencyKey: runId,
          },
          { expectFinal: false },
        );
        expect(started).toMatchObject({ runId, status: "accepted" });

        await expect
          .poll(
            async () => {
              const page = await client.request<TasksListResult>("tasks.list", {
                sessionKey,
                status: "running",
              });
              return page.tasks.find(
                (candidate) =>
                  candidate.runtime === "cli" &&
                  candidate.runId === runId &&
                  candidate.sessionKey === sessionKey,
              )?.id;
            },
            { timeout: 10_000, interval: 50 },
          )
          .toBeTypeOf("string");
        const runningTasks = await client.request<TasksListResult>("tasks.list", {
          sessionKey,
          status: "running",
        });
        const taskId = runningTasks.tasks.find(
          (candidate) =>
            candidate.runtime === "cli" &&
            candidate.runId === runId &&
            candidate.sessionKey === sessionKey,
        )?.id;
        expect(taskId).toBeTypeOf("string");
        if (!taskId) {
          throw new Error("gateway-created agent task disappeared before lookup");
        }

        await expect(
          client.request<TasksGetResult>("tasks.get", { taskId }),
        ).resolves.toMatchObject({
          task: {
            id: taskId,
            runtime: "cli",
            status: "running",
            prompt: taskPrompt,
          },
        });
        const cancelled = await client.request<TasksCancelResult>("tasks.cancel", {
          taskId,
          reason: "Gateway RPC automation evidence complete",
        });
        expect(cancelled).toMatchObject({
          found: true,
          cancelled: true,
          task: { id: taskId, status: "cancelled" },
        });
        await expect(
          client.request<TasksGetResult>("tasks.get", { taskId }),
        ).resolves.toMatchObject({
          task: {
            id: taskId,
            status: "cancelled",
            error: "Gateway RPC automation evidence complete",
          },
        });
        const releaseResponse = releaseTaskResponse;
        if (!releaseResponse) {
          throw new Error("task response gate was not initialized");
        }
        releaseResponse();
        releaseTaskResponse = undefined;
        const agentWait = await client.request<{ status: string; error?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(agentWait).toMatchObject({ status: "ok" });
        await expect(
          client.request<TasksGetResult>("tasks.get", { taskId }),
        ).resolves.toMatchObject({
          task: {
            id: taskId,
            status: "cancelled",
            error: "Gateway RPC automation evidence complete",
          },
        });

        const requestsBeforeWake = providerRequests.length;
        const wakeRequestedAt = Date.now();
        await expect(
          client.request<{ ok: boolean }>("wake", {
            mode: "now",
            text: wakeText,
            sessionKey,
            agentId: "main",
          }),
        ).resolves.toEqual({ ok: true });
        await expect
          .poll(() => providerRequests.length, { timeout: 15_000, interval: 50 })
          .toBeGreaterThan(requestsBeforeWake);
        await expect
          .poll(
            async () => {
              const lastHeartbeat = await client.request<{
                ts: number;
                status: string;
                reason?: string;
                message?: string;
                preview?: string;
              }>("last-heartbeat", {});
              return (
                lastHeartbeat.ts >= wakeRequestedAt &&
                lastHeartbeat.status === "skipped" &&
                lastHeartbeat.reason === "target-none" &&
                lastHeartbeat.message ===
                  "Heartbeat delivery is disabled by configuration (target: none)." &&
                lastHeartbeat.preview === `Heartbeat handled: ${wakeText}`
              );
            },
            { timeout: 15_000, interval: 50 },
          )
          .toBe(true);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Gateway RPC automation test complete" });
        }
        releaseTaskResponse?.();
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => providerServer.close(() => resolve()));
        envSnapshot.restore();
      }
    },
  );
});
