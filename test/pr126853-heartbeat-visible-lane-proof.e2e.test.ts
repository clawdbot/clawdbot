import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFastReplyConfig } from "../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
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

type LaneSnapshot = {
  lane: string;
  activeCount: number;
  queuedCount: number;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 20_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out while ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function writeAssistantResponse(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: `pr126853-${text.toLowerCase()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
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
        id: `response-${text.toLowerCase()}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
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

describe("PR #126853 real Gateway lane proof", () => {
  it(
    "starts a visible turn while an independent heartbeat is held",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let releaseProviderResponses!: () => void;
      const providerResponsesReleased = new Promise<void>((resolve) => {
        releaseProviderResponses = resolve;
      });
      let heartbeatRequestStarted!: () => void;
      const heartbeatRequest = new Promise<void>((resolve) => {
        heartbeatRequestStarted = resolve;
      });
      let visibleRequestStarted!: () => void;
      const visibleRequest = new Promise<void>((resolve) => {
        visibleRequestStarted = resolve;
      });
      const heartbeatMarker = "PR126853_HEARTBEAT_HELD";
      const visibleMarker = "PR126853_VISIBLE_TURN";
      const providerOrder: string[] = [];
      let visibleTurnDispatched = false;

      try {
        const tempHome = tempDirs.make("openclaw-pr126853-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);
        await fs.writeFile(
          path.join(workspaceDir, "HEARTBEAT.md"),
          "Handle pending system events and reply with a concise acknowledgement.\n",
        );
        const token = "pr126853-proof-token";
        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
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

        providerServer = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            const body = Buffer.concat(chunks).toString("utf8");
            const kind = !visibleTurnDispatched
              ? "heartbeat"
              : body.includes(visibleMarker)
                ? "visible"
                : "unexpected";
            providerOrder.push(kind);
            console.log(`PR126853_PROVIDER_REQUEST ${kind}`);
            if (kind === "heartbeat") {
              heartbeatRequestStarted();
            } else if (kind === "visible") {
              visibleRequestStarted();
            }
            await providerResponsesReleased;
            writeAssistantResponse(response, kind === "heartbeat" ? "HEARTBEAT_OK" : "VISIBLE_OK");
          })().catch((error: unknown) => {
            response.writeHead(500).end(error instanceof Error ? error.message : String(error));
          });
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
          "gpt-pr126853-proof",
        );
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              maxConcurrent: 1,
              heartbeat: { every: "5m", target: "none" },
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
            providers: { [provider.providerId]: provider.config },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        gateway = await within(
          startGatewayWithClient({
            cfg,
            configPath,
            token,
            clientDisplayName: "pr126853-proof",
          }),
          "starting the proof Gateway",
          30_000,
        );
        const runtimeConfig = getRuntimeConfigSnapshot();
        if (!runtimeConfig) {
          throw new Error("proof Gateway did not publish its runtime config");
        }
        withFastReplyConfig(runtimeConfig);

        const heartbeatSessionKey = "agent:main:pr126853-heartbeat";
        await gateway.client.request("sessions.create", {
          key: heartbeatSessionKey,
          agentId: "main",
          cwd: workspaceDir,
        });
        await expect(
          gateway.client.request<{ ok: boolean }>("wake", {
            mode: "now",
            text: heartbeatMarker,
            sessionKey: heartbeatSessionKey,
            agentId: "main",
          }),
        ).resolves.toEqual({ ok: true });
        await within(heartbeatRequest, "waiting for the heartbeat provider request").catch(
          async (error: unknown) => {
            const lastHeartbeat = await gateway?.client
              .request("last-heartbeat", {})
              .catch((lookupError: unknown) => ({ lookupError: String(lookupError) }));
            throw new Error(
              `heartbeat did not reach provider; order=${JSON.stringify(providerOrder)} last=${JSON.stringify(lastHeartbeat)}`,
              { cause: error },
            );
          },
        );

        const visibleSessionKey = "agent:main:pr126853-visible";
        const visibleRunId = "pr126853-visible-run";
        visibleTurnDispatched = true;
        const started = await gateway.client.request<{ runId: string; status: string }>(
          "chat.send",
          {
            sessionKey: visibleSessionKey,
            message: visibleMarker,
            deliver: false,
            idempotencyKey: visibleRunId,
          },
        );
        expect(started).toMatchObject({ runId: visibleRunId, status: "started" });
        await within(visibleRequest, "waiting for the visible provider request");

        const diagnostics = await gateway.client.request<{ lanes: LaneSnapshot[] }>(
          "diagnostics.lanes",
          {},
        );
        const main = diagnostics.lanes.find((lane) => lane.lane === "main");
        const heartbeat = diagnostics.lanes.find((lane) => lane.lane === "cron-nested");
        expect(providerOrder.slice(0, 2)).toEqual(["heartbeat", "visible"]);
        expect(main).toMatchObject({ lane: "main", activeCount: 1, queuedCount: 0 });
        expect(heartbeat).toMatchObject({
          lane: "cron-nested",
          activeCount: 1,
          queuedCount: 0,
        });
        console.log(
          `PR126853_RUNTIME_TRACE ${JSON.stringify({
            providerOrder: providerOrder.slice(0, 2),
            lanes: [main, heartbeat],
            heartbeatSessionKey,
            visibleSessionKey,
          })}`,
        );

        releaseProviderResponses();
        await expect(
          gateway.client.request(
            "agent.wait",
            { runId: started.runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000 },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        await expect
          .poll(
            async () =>
              await gateway?.client.request<{ status: string; preview?: string }>(
                "last-heartbeat",
                {},
              ),
            { timeout: 15_000, interval: 50 },
          )
          .toMatchObject({ status: "ok-empty" });
      } finally {
        releaseProviderResponses();
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          providerServer.closeAllConnections();
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
