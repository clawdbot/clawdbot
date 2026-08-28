import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_STARTUP_TRACE",
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

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

afterEach(resetGatewayState);

function completeResponse(response: ServerResponse, item?: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const responseId = `resp_${randomUUID()}`;
  send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
  if (item) {
    send({ type: "response.output_item.added", output_index: 0, item });
    send({ type: "response.output_item.done", output_index: 0, item });
  }
  send({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: item ? [item] : [],
      usage: { input_tokens: 1, output_tokens: item ? 1 : 0, total_tokens: item ? 2 : 1 },
    },
  });
  response.end("data: [DONE]\n\n");
}

describe("Gateway Active Memory", () => {
  it(
    "keeps a grounded but terminally failed recall out of the main prompt",
    { timeout: 90_000 },
    async () => {
      const env = captureEnv([...ENV_KEYS]);
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-gateway-"));
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(home, "workspace");
      const configPath = path.join(stateDir, "openclaw.json");
      const memoryFact = "The user's usual lunch is ginger ramen.";
      const mainReply = "ACTIVE_MEMORY_RUNTIME_PROOF_OK";
      const mainRequests: string[] = [];
      const memoryResults: string[] = [];
      const providerErrors: unknown[] = [];
      let recallRequests = 0;
      let memoryToolIssued = false;
      let phase = "preparing fixture";
      onTestFailed(() => {
        console.info({
          phase,
          fixtureHome: home,
          recallRequests,
          memoryResults: memoryResults.length,
          mainRequests: mainRequests.length,
        });
      });
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = JSON.parse(raw) as {
            input?: Array<{ type?: string; output?: unknown }>;
          };
          // Route by the helper's prompt, not request order: empty-turn recovery
          // can make several provider calls before the main turn starts.
          if (raw.includes("You are a memory search agent.")) {
            recallRequests += 1;
            for (const item of body.input ?? []) {
              if (item.type === "function_call_output") {
                memoryResults.push(
                  typeof item.output === "string" ? item.output : JSON.stringify(item.output),
                );
              }
            }
            if (!memoryToolIssued) {
              memoryToolIssued = true;
              completeResponse(response, {
                type: "function_call",
                id: "fc_memory_get",
                call_id: "call_memory_get",
                name: "memory_get",
                arguments: JSON.stringify({ path: "MEMORY.md" }),
                status: "completed",
              });
            } else {
              // Exhaust the real incomplete-turn recovery after the real tool
              // read; do not synthesize a runner result or a plugin failure.
              completeResponse(response);
            }
            return;
          }
          mainRequests.push(raw);
          completeResponse(response, {
            type: "message",
            id: `msg_${randomUUID()}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: mainReply, annotations: [] }],
          });
        })().catch((error: unknown) => {
          providerErrors.push(error);
          response.writeHead(500).end("mock provider failed");
        });
      });
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        await Promise.all([
          fs.mkdir(stateDir, { recursive: true }),
          fs.mkdir(workspace, { recursive: true }),
        ]);
        await fs.writeFile(path.join(workspace, "MEMORY.md"), `${memoryFact}\n`, "utf8");
        for (const [key, value] of Object.entries({
          HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
        })) {
          setTestEnvValue(key, value);
        }
        for (const key of [
          "OPENCLAW_CONFIG_PATH",
          "OPENCLAW_TEST_MINIMAL_GATEWAY",
          "OPENCLAW_BUNDLED_PLUGINS_DIR",
          "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
        ]) {
          deleteTestEnvValue(key);
        }
        resetGatewayState();
        phase = "starting mock provider";
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("mock provider did not bind");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "active-memory-proof",
        );
        const token = `active-memory-${randomUUID()}`;
        const cfg = {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          memory: { search: { rememberAcrossConversations: false } },
          plugins: {
            allow: ["active-memory", "memory-core", "openai"],
            slots: { memory: "memory-core" },
            entries: {
              "active-memory": {
                enabled: true,
                config: {
                  mode: "always",
                  agents: ["main"],
                  allowedChatTypes: ["direct", "explicit"],
                  model: provider.modelRef,
                  toolsAllow: ["memory_get"],
                  logging: true,
                },
              },
            },
          },
          tools: { profile: "full" },
        } satisfies OpenClawConfig;
        phase = "starting Gateway";
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        const sessionKey = "agent:main:main";
        phase = "starting main turn";
        const accepted = await gateway.client.request<{ runId: string; status: string }>("agent", {
          sessionKey,
          message: "What do I usually have for lunch?",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("accepted");
        phase = "waiting for main reply";
        const completed = await gateway.client.request<{ status: string }>(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        expect(completed.status).toBe("ok");
        phase = "checking recall and main reply";
        expect(providerErrors).toEqual([]);
        expect(memoryResults).toEqual(
          expect.arrayContaining([expect.stringContaining(memoryFact)]),
        );
        expect(recallRequests).toBeGreaterThan(1);
        const entry = loadSessionEntry({
          agentId: "main",
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        });
        const statusLines = entry?.pluginDebugEntries?.find(
          (item) => item.pluginId === "active-memory",
        )?.lines;
        expect(statusLines?.join("\n")).toContain("Active Memory: status=failed");
        expect(mainRequests).toHaveLength(1);
        expect(mainRequests[0]).not.toContain("<active_memory_plugin>");
        expect(mainRequests[0]).not.toContain("Please try again.");
        const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
        });
        expect(JSON.stringify(history.messages)).toContain(mainReply);
      } finally {
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "active memory regression cleanup" });
            }
          }
        } finally {
          try {
            providerServer.closeAllConnections();
            await new Promise<void>((resolve) => providerServer.close(() => resolve()));
            await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
          } finally {
            env.restore();
          }
        }
      }
    },
  );
});
