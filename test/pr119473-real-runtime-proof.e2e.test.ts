import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
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

describe("PR #119473 real gateway proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "persists the first turn of a fresh SQLite-backed session across gateway restart",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let first: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let second: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr119473-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "pr119473-proof-token",
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

        providerServer = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const message = {
            type: "message",
            id: "pr119473-proof-message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "PR119473_RUNTIME_OK", annotations: [] }],
          };
          response.end(
            [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...message, status: "in_progress", content: [] },
              },
              { type: "response.output_item.done", output_index: 0, item: message },
              {
                type: "response.completed",
                response: {
                  status: "completed",
                  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .concat("data: [DONE]\n\n")
              .join(""),
          );
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
        );
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          gateway: { auth: { mode: "token", token: "pr119473-proof-token" } },
        };
        const sessionKey = "agent:main:pr119473-fresh-runtime";
        const marker = "PR119473_FIRST_USER_MESSAGE";
        first = await startGatewayWithClient({
          cfg,
          configPath,
          token: "pr119473-proof-token",
          clientDisplayName: "pr119473-proof-first-start",
        });
        const started = await first.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: marker,
            deliver: false,
            idempotencyKey: "pr119473-proof-first-turn",
          },
        );
        expect(started.status).toBe("started");
        expect(started.runId).toEqual(expect.any(String));
        await expect(
          first.client.request(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        await disconnectGatewayClient(first.client);
        await first.server.close({ reason: "PR #119473 proof restart" });
        first = undefined;

        clearRuntimeConfigSnapshot();
        clearConfigCache();
        second = await startGatewayWithClient({
          cfg,
          configPath,
          token: "pr119473-proof-token",
          clientDisplayName: "pr119473-proof-after-restart",
        });
        const history = await second.client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey,
          limit: 20,
        });
        expect(JSON.stringify(history.messages ?? [])).toContain(marker);
      } finally {
        if (first) {
          await disconnectGatewayClient(first.client).catch(() => undefined);
          await first.server.close().catch(() => undefined);
        }
        if (second) {
          await disconnectGatewayClient(second.client).catch(() => undefined);
          await second.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
