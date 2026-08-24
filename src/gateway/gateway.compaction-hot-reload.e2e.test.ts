import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  writeConfigFile,
} from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

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

function nextId(prefix: string): string {
  return `${prefix}-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}-${sequence++}`;
}

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

describe("gateway compaction hot reload", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it(
    "applies hot-reloaded tool policy, context budgets, and compaction models without restarting",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...ISOLATED_GATEWAY_ENV_KEYS]);
      const tempHome = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-gw-compaction-hot-reload-"),
      );
      const workspaceDir = path.join(tempHome, "openclaw");
      const bundledPluginsDir = path.join(tempHome, "openclaw-test-empty-bundled-plugins");
      const configPath = path.join(tempHome, ".openclaw", "openclaw.json");
      await Promise.all([
        fs.mkdir(workspaceDir, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(path.dirname(configPath), { recursive: true }),
      ]);
      const token = nextId("compaction-hot-reload-token");
      for (const [key, value] of Object.entries({
        HOME: tempHome,
        OPENCLAW_STATE_DIR: path.join(tempHome, ".openclaw"),
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
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");

      const providerRequests: string[] = [];
      const providerRequestToolNames: string[][] = [];
      const summaryByModel = new Map<string, string>();
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
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            model?: string;
            tools?: Array<{ name?: string; function?: { name?: string } }>;
          };
          const model = body.model ?? "";
          providerRequests.push(model);
          providerRequestToolNames.push(
            body.tools?.map((tool) => tool.name ?? tool.function?.name ?? "") ?? [],
          );
          const text = summaryByModel.get(model) ?? "Primary assistant answer.";
          const message = {
            type: "message",
            id: nextId("provider-message"),
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [
            {
              type: "response.output_item.added",
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", item: message },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
              },
            },
          ]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
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
        const baseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
        const primaryModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-primary");
        const oldCompactionModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-old-summary");
        const newCompactionModel = buildMockOpenAiResponsesProvider(baseUrl, "gpt-new-summary");
        const availableModels = [primaryModel, oldCompactionModel, newCompactionModel];
        const modelDefaults = { params: { transport: "sse", openaiWsWarmup: false } };
        const newSummary = "HOT_RELOAD_COMPACTION_SUMMARY";
        summaryByModel.set(oldCompactionModel.modelId, "STALE_COMPACTION_SUMMARY");
        summaryByModel.set(newCompactionModel.modelId, newSummary);

        const initialConfig = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: primaryModel.modelRef },
              models: Object.fromEntries(
                availableModels.map(({ modelRef }) => [modelRef, modelDefaults]),
              ),
              compaction: {
                model: oldCompactionModel.modelRef,
                maxActiveTranscriptBytes: "1mb",
                keepRecentTokens: 1,
                recentTurnsPreserve: 1,
                qualityGuard: { enabled: false },
                memoryFlush: { enabled: false },
              },
            },
            entries: { dev: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              [primaryModel.providerId]: {
                ...primaryModel.config,
                models: Array.from(availableModels, ({ config }) => ({
                  ...config.models[0],
                  input: Array.from(config.models[0].input),
                })),
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg: initialConfig,
          configPath,
          token,
          clientDisplayName: "vitest-compaction-hot-reload",
        });
        const gatewayClient = gateway.client;
        const sessionKey = "agent:dev:main";
        const sessionId = nextId("existing-compaction-session");
        const scope = {
          agentId: "dev",
          sessionId,
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "dev" }),
        };
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: Date.now(),
          compactionCount: 0,
          modelProvider: primaryModel.providerId,
          model: primaryModel.modelId,
          totalTokens: 20,
          totalTokensFresh: true,
        });
        const persistedContext = "persisted conversation ".repeat(24);
        const durableContext = "durable model context ".repeat(24);
        for (let turn = 0; turn < 6; turn += 1) {
          const timestamp = Date.now() + turn;
          await appendTranscriptMessage(scope, {
            message: {
              role: "user",
              content: `Historical request ${turn}: ${persistedContext}`,
              timestamp,
            },
          });
          await appendTranscriptMessage(scope, {
            message: {
              role: "assistant",
              content: [{ type: "text", text: `Historical answer ${turn}: ${durableContext}` }],
              api: "openai-responses",
              provider: primaryModel.providerId,
              model: primaryModel.modelId,
              usage: {
                input: 10,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 20,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp,
            },
          });
        }
        expect(loadTranscriptEventsSync(scope).length).toBeGreaterThan(10);

        const sendChatAndWait = async (message: string) => {
          const started = await gatewayClient.request<{ runId: string; status: string }>(
            "chat.send",
            { sessionKey, message, idempotencyKey: nextId("compaction-chat") },
          );
          expect(started.status).toBe("started");
          const completed = await gatewayClient.request<{ status: string }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          );
          expect(completed.status).toBe("ok");
        };

        await sendChatAndWait("Warm the existing prepared model runtime.");
        expect(providerRequests).toContain(primaryModel.modelId);
        expect(providerRequestToolNames.at(-1)).toContain("exec");
        expect(loadSessionEntry(scope)?.compactionCount ?? 0).toBe(0);

        const reloadedTools = { deny: ["exec"] };
        await writeConfigFile({ ...initialConfig, tools: reloadedTools });
        await expect
          .poll(() => getRuntimeConfig().tools?.deny, { timeout: 5_000, interval: 50 })
          .toEqual(["exec"]);
        await sendChatAndWait("Apply the hot-reloaded tool deny policy to the existing runtime.");
        expect(providerRequestToolNames.at(-1)).not.toContain("exec");

        await writeConfigFile({
          ...initialConfig,
          agents: {
            ...initialConfig.agents,
            defaults: {
              ...initialConfig.agents.defaults,
              compaction: {
                ...initialConfig.agents.defaults.compaction,
                model: newCompactionModel.modelRef,
                maxActiveTranscriptBytes: "10b",
              },
            },
          },
          tools: reloadedTools,
        });
        await expect
          .poll(() => getRuntimeConfig().agents?.defaults?.compaction, {
            timeout: 5_000,
            interval: 50,
          })
          .toMatchObject({ model: newCompactionModel.modelRef, maxActiveTranscriptBytes: "10b" });

        const requestsBeforeCompaction = providerRequests.length;
        await sendChatAndWait("Compact the existing conversation before answering.");

        const newRequests = providerRequests.slice(requestsBeforeCompaction);
        expect(newRequests).toContain(newCompactionModel.modelId);
        expect(newRequests).not.toContain(oldCompactionModel.modelId);
        expect(loadSessionEntry(scope)?.compactionCount).toBe(1);
        expect(loadTranscriptEventsSync(scope)).toContainEqual(
          expect.objectContaining({
            type: "compaction",
            summary: expect.stringContaining(newSummary),
          }),
        );
        await expect(gatewayClient.request("health", {})).resolves.toEqual(expect.any(Object));
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "compaction hot reload integration test complete" });
        }
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        envSnapshot.restore();
      }
    },
  );
});
