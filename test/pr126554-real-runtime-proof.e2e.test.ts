import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "../src/agents/auth-profiles/store.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

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

const primaryProvider = "proof-primary";
const fallbackProvider = "proof-fallback";
const modelId = "proof-model";
const responseMarker = "PR126554_REAL_RUNTIME_OK";
const profileCredentials = {
  "proof-primary:profile-1": "proof-profile-1",
  "proof-primary:profile-2": "proof-profile-2",
  "proof-primary:profile-3": "proof-profile-3",
  "proof-fallback:profile": "proof-fallback",
} as const;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function authLabel(header: string | undefined): string {
  const credential = header?.replace(/^Bearer\s+/u, "") ?? "";
  const match = Object.entries(profileCredentials).find(([, value]) => value === credential);
  return match?.[0].split(":").at(-1) ?? "unknown";
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function writeFallbackSuccess(response: ServerResponse): void {
  const message = {
    type: "message",
    id: "pr126554-proof-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: responseMarker, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "pr126554-proof-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function buildProvider(baseUrl: string) {
  return {
    api: "openai-responses" as const,
    baseUrl,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 2048,
      },
    ],
  };
}

describe("PR #126554 real runtime proof", () => {
  it(
    "exhausts three ordered profiles over HTTP before the configured fallback",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        const tempHome = tempDirs.make("openclaw-pr126554-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const agentDir = path.join(stateDir, "agents", "main", "agent");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(agentDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "pr126554-proof-token",
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

        const sequence: string[] = [];
        providerServer = createServer((request, response) => {
          if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
            response.writeHead(404).end();
            return;
          }
          const label = authLabel(request.headers.authorization);
          if (request.url === "/primary/v1/responses") {
            sequence.push(label);
            writeJson(response, 429, {
              error: {
                type: "usage_limit_reached",
                code: "usage_limit_reached",
                message: "synthetic subscription usage limit",
              },
            });
            return;
          }
          if (request.url === "/fallback/v1/responses" && label === "profile") {
            sequence.push("fallback");
            writeFallbackSuccess(response);
            return;
          }
          writeJson(response, 401, {
            error: { type: "authentication_error", message: "synthetic credential rejected" },
          });
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }

        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "proof-primary:profile-1": {
                type: "api_key",
                provider: primaryProvider,
                key: profileCredentials["proof-primary:profile-1"],
              },
              "proof-primary:profile-2": {
                type: "api_key",
                provider: primaryProvider,
                key: profileCredentials["proof-primary:profile-2"],
              },
              "proof-primary:profile-3": {
                type: "api_key",
                provider: primaryProvider,
                key: profileCredentials["proof-primary:profile-3"],
              },
              "proof-fallback:profile": {
                type: "api_key",
                provider: fallbackProvider,
                key: profileCredentials["proof-fallback:profile"],
              },
            },
            order: {
              [primaryProvider]: [
                "proof-primary:profile-1",
                "proof-primary:profile-2",
                "proof-primary:profile-3",
              ],
              [fallbackProvider]: ["proof-fallback:profile"],
            },
          },
          agentDir,
        );

        const primaryModel = `${primaryProvider}/${modelId}`;
        const fallbackModel = `${fallbackProvider}/${modelId}`;
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: primaryModel, fallbacks: [fallbackModel] },
              models: { [primaryModel]: {}, [fallbackModel]: {} },
            },
            entries: { main: { default: true } },
          },
          auth: {
            profiles: {
              "proof-primary:profile-1": { provider: primaryProvider, mode: "api_key" },
              "proof-primary:profile-2": { provider: primaryProvider, mode: "api_key" },
              "proof-primary:profile-3": { provider: primaryProvider, mode: "api_key" },
              "proof-fallback:profile": { provider: fallbackProvider, mode: "api_key" },
            },
          },
          models: {
            mode: "replace" as const,
            providers: {
              [primaryProvider]: buildProvider(`http://127.0.0.1:${address.port}/primary/v1`),
              [fallbackProvider]: buildProvider(`http://127.0.0.1:${address.port}/fallback/v1`),
            },
          },
          gateway: { auth: { mode: "token" as const, token: "pr126554-proof-token" } },
        };
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "pr126554-proof-token",
          clientDisplayName: "pr126554-real-runtime-proof",
        });
        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey: "agent:main:pr126554-real-runtime-proof",
            message: "Reply only with the provider proof marker.",
            deliver: false,
            idempotencyKey: "pr126554-real-runtime-proof",
          },
        );
        expect(started).toMatchObject({ status: "started" });
        await expect(
          gateway.client.request(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        const history = await gateway.client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: "agent:main:pr126554-real-runtime-proof",
          limit: 20,
        });
        expect(JSON.stringify(history.messages ?? [])).toContain(responseMarker);
        expect(sequence).toEqual(["profile-1", "profile-2", "profile-3", "fallback"]);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
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
