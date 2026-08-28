// Real-gateway proof for PR #132123: the abort-partial skip decision is
// observed through a live gateway against a real SQLite transcript store.
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

const REPLY_TEXT = "PR132123_SAME_REPLY";
const FIRST_MESSAGE = "PR132123_FIRST_TURN";

describe("PR #132123 real gateway proof", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "records the live abort-partial transcript outcome for a buffered reply",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr132123-proof-"));
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
          OPENCLAW_GATEWAY_TOKEN: "pr132123-proof-token",
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

        const secondStreamStarted = Promise.withResolvers<void>();
        let providerRequests = 0;
        providerServer = createServer((_request, response) => {
          providerRequests += 1;
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (providerRequests === 1) {
            // First turn completes normally so the transcript holds one
            // committed assistant row before the abort scenario starts.
            const message = {
              type: "message",
              id: "pr132123-proof-first",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: REPLY_TEXT, annotations: [] }],
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
            return;
          }
          // Second turn streams the identical text but never reaches a terminal
          // event, so the run stays active with that text buffered — the window
          // a late chat.abort persists as an abort partial.
          response.write(
            `data: ${JSON.stringify({
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "message",
                id: "pr132123-proof-second",
                role: "assistant",
                status: "in_progress",
                content: [],
              },
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              type: "response.output_text.delta",
              output_index: 0,
              delta: REPLY_TEXT,
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "message",
                id: "pr132123-proof-second",
                role: "assistant",
                status: "in_progress",
                content: [{ type: "output_text", text: REPLY_TEXT, annotations: [] }],
              },
            })}\n\n`,
          );
          secondStreamStarted.resolve();
          // Intentionally never sends response.completed or [DONE].
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
          gateway: { auth: { mode: "token", token: "pr132123-proof-token" } },
        };
        const sessionKey = "agent:main:pr132123-abort-proof";
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "pr132123-proof-token",
          clientDisplayName: "pr132123-proof-gateway",
        });

        const first = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: FIRST_MESSAGE,
            deliver: false,
            idempotencyKey: "pr132123-proof-first-turn",
          },
        );
        expect(first.status).toBe("started");
        await expect(
          gateway.client.request(
            "agent.wait",
            { runId: first.runId, timeoutMs: 30_000 },
            {
              timeoutMs: 35_000,
            },
          ),
        ).resolves.toMatchObject({ status: "ok" });

        const second = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: "PR132123_SECOND_TURN",
            deliver: false,
            idempotencyKey: "pr132123-proof-second-turn",
          },
        );
        expect(second.status).toBe("started");
        await secondStreamStarted.promise;
        // Let the streamed text settle into the live run buffer before aborting.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const abort = await gateway.client.request<{ aborted?: boolean }>(
          "chat.abort",
          { sessionKey, runId: second.runId },
          { timeoutMs: 15_000 },
        );
        expect(abort.aborted).toBe(true);

        const history = await gateway.client.request<{ messages?: Array<Record<string, unknown>> }>(
          "chat.history",
          { sessionKey, limit: 50 },
        );
        const assistantRows = (history.messages ?? []).filter(
          (entry) => entry?.role === "assistant",
        );
        const assistantTexts = assistantRows.map((entry) =>
          Array.isArray(entry.content)
            ? entry.content
                .map((block) =>
                  block && typeof block === "object" && (block as { text?: unknown }).text
                    ? String((block as { text: unknown }).text)
                    : "",
                )
                .join("")
            : "",
        );
        const verdict = {
          assistantRowCount: assistantRows.length,
          assistantTexts,
          abortMarkedRows: assistantRows.filter((entry) => entry.openclawAbort).length,
        };
        console.info(`PR132123_VERDICT ${JSON.stringify(verdict)}`);
        expect(verdict.assistantTexts.filter((text) => text === REPLY_TEXT)).toEqual([REPLY_TEXT]);
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
