import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { loadSessionEntry } from "../session-utils.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../test-openai-responses-model.js";

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

const REPLY_TEXT = "PR132123_COMMITTED_REPLY";
const CONTEXT_ENGINE_ID = "pr132123-after-turn-gate";

function assistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("");
}

function assistantRows(events: readonly unknown[]): Array<Record<string, unknown>> {
  return events.flatMap((event) => {
    const message = (event as { message?: unknown } | undefined)?.message;
    return message &&
      typeof message === "object" &&
      (message as { role?: unknown }).role === "assistant"
      ? [message as Record<string, unknown>]
      : [];
  });
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("PR #132123 real Gateway proof", () => {
  it(
    "skips a late abort partial after the same run commits its final reply",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const afterTurnStarted = createDeferred();
      const releaseAfterTurn = createDeferred();
      const replyVisible = createDeferred<Record<string, unknown>>();
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        const tempHome = tempDirs.make("openclaw-pr132123-proof-");
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        const pluginDir = path.join(tempHome, "after-turn-gate");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(pluginDir, { recursive: true }),
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

        providerServer = createServer((request, response) => {
          void (async () => {
            if (request.url === "/after-turn") {
              afterTurnStarted.resolve();
              await releaseAfterTurn.promise;
              response.writeHead(204).end();
              return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            const message = {
              type: "message",
              id: "pr132123-proof-reply",
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
          })().catch((error: unknown) => response.destroy(error as Error));
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const providerBaseUrl = `http://127.0.0.1:${providerAddress.port}`;
        const provider = buildMockOpenAiResponsesProvider(`${providerBaseUrl}/v1`);
        await Promise.all([
          fs.writeFile(
            path.join(pluginDir, "openclaw.plugin.json"),
            `${JSON.stringify({
              id: CONTEXT_ENGINE_ID,
              name: "PR 132123 After-Turn Gate",
              activation: { onStartup: true },
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            })}\n`,
          ),
          fs.writeFile(
            path.join(pluginDir, "index.mjs"),
            [
              "export default {",
              `  id: ${JSON.stringify(CONTEXT_ENGINE_ID)},`,
              "  register(api) {",
              `    api.registerContextEngine(${JSON.stringify(CONTEXT_ENGINE_ID)}, () => ({`,
              `      info: { id: ${JSON.stringify(CONTEXT_ENGINE_ID)}, name: "After-Turn Gate", transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1", turnAdvancementIdempotency: "atomic-idempotent-v1" } },`,
              "      async ingest() { return { ingested: false }; },",
              "      async assemble({ messages }) { return { messages, estimatedTokens: 0 }; },",
              "      async compact() { return { ok: true, compacted: false }; },",
              `      async commitTurn() { const response = await fetch(${JSON.stringify(`${providerBaseUrl}/after-turn`)}, { method: "POST" }); if (!response.ok) throw new Error(`,
              "        `after-turn gate failed: ${response.status}`); },",
              "    }));",
              "  },",
              "};",
              "",
            ].join("\n"),
          ),
        ]);

        const cfg = {
          plugins: {
            enabled: true,
            allow: [CONTEXT_ENGINE_ID],
            load: { paths: [pluginDir] },
            entries: { [CONTEXT_ENGINE_ID]: { enabled: true } },
            slots: { memory: "none", contextEngine: CONTEXT_ENGINE_ID },
          },
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
          onEvent: (event) => {
            if (
              event.event === "chat" &&
              JSON.stringify(event.payload ?? {}).includes(REPLY_TEXT)
            ) {
              replyVisible.resolve((event.payload ?? {}) as Record<string, unknown>);
            }
          },
        });

        const started = await gateway.client.request<{ runId?: string; status?: string }>(
          "chat.send",
          {
            sessionKey,
            message: "Return the proof marker.",
            deliver: false,
            idempotencyKey: "pr132123-proof-run",
          },
        );
        expect(started.status).toBe("started");
        expect(started.runId).toBeTruthy();
        const visibleEvent = await replyVisible.promise;
        await afterTurnStarted.promise;

        const waiting = await gateway.client.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 100 },
          { timeoutMs: 5_000 },
        );
        expect(waiting.status).toBe("timeout");
        const loaded = loadSessionEntry(sessionKey);
        if (!loaded.entry?.sessionId) {
          throw new Error("proof session did not persist its transcript identity");
        }
        const transcriptScope = {
          agentId: loaded.agentId,
          sessionId: loaded.entry.sessionId,
          sessionKey: loaded.canonicalKey,
          storePath: loaded.storePath,
        };
        const beforeRows = assistantRows(await loadTranscriptEvents(transcriptScope)).filter(
          (message) => assistantText(message) === REPLY_TEXT,
        );
        expect(beforeRows).toHaveLength(1);
        expect((beforeRows[0]?.["__openclaw"] as { runId?: string } | undefined)?.runId).toBe(
          started.runId,
        );

        const abort = await gateway.client.request<{ aborted?: boolean; runIds?: string[] }>(
          "chat.abort",
          { sessionKey, runId: started.runId },
          { timeoutMs: 15_000 },
        );
        expect(abort.aborted).toBe(true);
        const afterRows = assistantRows(await loadTranscriptEvents(transcriptScope)).filter(
          (message) => assistantText(message) === REPLY_TEXT,
        );
        expect(afterRows).toHaveLength(1);
        expect(afterRows.filter((message) => message.openclawAbort)).toHaveLength(0);

        releaseAfterTurn.resolve();
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close();
        gateway = undefined;
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        clearSessionStoreCacheForTest();
        const reopenedRows = assistantRows(await loadTranscriptEvents(transcriptScope)).filter(
          (message) => assistantText(message) === REPLY_TEXT,
        );
        const verdict = {
          runId: started.runId,
          replyVisible: JSON.stringify(visibleEvent).includes(REPLY_TEXT),
          waitBeforeAbort: waiting.status,
          durableRowsBeforeAbort: beforeRows.length,
          abort,
          durableRowsAfterAbort: afterRows.length,
          abortMarkedRowsAfterAbort: afterRows.filter((message) => message.openclawAbort).length,
          reopenedRows: reopenedRows.length,
          reopenedAbortMarkedRows: reopenedRows.filter((message) => message.openclawAbort).length,
        };
        console.info(`PR132123_VERDICT ${JSON.stringify(verdict)}`);
        expect(verdict).toMatchObject({
          replyVisible: true,
          waitBeforeAbort: "timeout",
          durableRowsBeforeAbort: 1,
          abort: { aborted: true },
          durableRowsAfterAbort: 1,
          abortMarkedRowsAfterAbort: 0,
          reopenedRows: 1,
          reopenedAbortMarkedRows: 0,
        });
      } finally {
        releaseAfterTurn.resolve();
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
            providerServer?.closeAllConnections();
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
});
