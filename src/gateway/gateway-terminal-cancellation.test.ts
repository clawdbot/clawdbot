import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { createGatewayWsClient } from "../../scripts/lib/gateway-ws-client.js";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const CHAT_ID = "-1001234";
const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const WAIT = { timeout: 30_000, interval: 50 } as const;

function telegramReply(response: ServerResponse, result: unknown = true): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, result }));
}

function completeResponse(response: ServerResponse, index: number): void {
  const text = `TERMINAL_REPLY_${index}`;
  const item = {
    type: "message",
    id: `msg_terminal_${index}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_terminal_${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

describe("Gateway terminal cancellation", () => {
  it("joins the cancelled run before a late steer can continue or fall back", async () => {
    const cwd = process.cwd();
    const head = resolveGitHead({ cwd });
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    // Fail before the shared process helper could build or choose source.
    await fs.access(path.join(cwd, "dist/index.js"));
    for (const [file, field] of [
      [BUILD_STAMP_FILE, "head"],
      [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
      ["build-info.json", "commit"],
    ] as const) {
      const metadata = JSON.parse(await fs.readFile(path.join(cwd, "dist", file), "utf8"));
      expect(metadata[field], file).toBe(head);
    }

    const requests: string[] = [];
    const sends: Array<Record<string, unknown>> = [];
    const recordTelegramWire = (stage: string) => {
      console.info(
        "terminal-cancellation Telegram wire",
        JSON.stringify({
          stage,
          total: sends.length,
          omitted: Math.max(0, sends.length - 8),
          sends: sends.slice(-8).map((send, index, recent) => ({
            messageId: 10_001 + sends.length - recent.length + index,
            chatId: String(send.chat_id).slice(0, 64),
            text: typeof send.text === "string" ? send.text.slice(0, 1024) : null,
            textLength: typeof send.text === "string" ? send.text.length : null,
          })),
        }),
      );
    };
    const serverErrors: unknown[] = [];
    const pendingPolls = new Set<ServerResponse>();
    let holdNextDelivery = true;
    let heldDelivery: { response: ServerResponse; result: Record<string, unknown> } | undefined;
    const releaseDelivery = () => {
      if (heldDelivery) {
        telegramReply(heldDelivery.response, heldDelivery.result);
        heldDelivery = undefined;
      }
    };
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/v1/responses") {
          requests.push(raw);
          completeResponse(response, requests.length - 1);
          return;
        }
        const prefix = `/bot${BOT_TOKEN}/`;
        if (!url.pathname.startsWith(prefix)) {
          throw new Error(`Unexpected HTTP route ${url.pathname}`);
        }
        const method = url.pathname.slice(prefix.length);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (method === "getMe") {
          telegramReply(response, {
            id: 424242,
            is_bot: true,
            first_name: "Terminal QA",
            username: "terminal_qa_bot",
          });
        } else if (method === "getUpdates") {
          pendingPolls.add(response);
          response.once("close", () => pendingPolls.delete(response));
        } else if (method === "sendMessage") {
          sends.push(body);
          const result = {
            message_id: 10_000 + sends.length,
            date: 1_754_000_000,
            chat: { id: Number(CHAT_ID), type: "supergroup" },
            text: body.text,
          };
          if (holdNextDelivery) {
            holdNextDelivery = false;
            heldDelivery = { response, result };
          } else {
            telegramReply(response, result);
          }
        } else {
          telegramReply(response);
        }
      })().catch((error: unknown) => {
        serverErrors.push(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
    let gateway: OpenClawTestInstance | undefined;
    let client: ReturnType<typeof createGatewayWsClient> | undefined;
    const events: AgentEventPayload[] = [];
    const chatFinalRunIds = new Set<string>();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Fixture HTTP server did not bind");
      }
      const apiRoot = `http://127.0.0.1:${address.port}`;
      const provider = buildMockOpenAiResponsesProvider(`${apiRoot}/v1`, "gpt-5.6-luna");
      const token = `terminal-${randomUUID()}`;
      gateway = await createOpenClawTestInstance({
        name: "terminal-cancellation",
        cwd,
        gatewayToken: token,
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_TEST_CONSOLE: "1",
          OPENCLAW_LOG_LEVEL: "debug",
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          TELEGRAM_BOT_TOKEN: undefined,
        },
      });
      const instance = gateway;
      expect(await instance.entrypoint()).toEqual(["dist/index.js"]);
      const cfg = {
        gateway: {
          port: gateway.port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
        },
        hooks: { enabled: false },
        logging: { consoleStyle: "json" },
        agents: {
          defaults: {
            workspace: gateway.state.workspaceDir,
            skipBootstrap: true,
            skills: [],
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
            blockStreamingDefault: "on",
            blockStreamingBreak: "text_end",
            blockStreamingCoalesce: { minChars: 1000, maxChars: 2000, idleMs: 30_000 },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
          },
        },
        channels: {
          telegram: {
            enabled: true,
            defaultAccount: "proof",
            accounts: {
              proof: {
                enabled: true,
                botToken: BOT_TOKEN,
                apiRoot,
                groupPolicy: "open",
                groups: { [CHAT_ID]: { groupPolicy: "open", requireMention: false } },
                streaming: { mode: "off", block: { enabled: true } },
              },
            },
          },
        },
        messages: {
          visibleReplies: "automatic",
          groupChat: { visibleReplies: "automatic" },
          queue: { mode: "steer", debounceMsByChannel: { telegram: 0 } },
        },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal" },
      } satisfies OpenClawConfig;
      await gateway.state.writeConfig(cfg);
      await gateway.startGateway();
      client = createGatewayWsClient({
        url: gateway.url,
        onEvent: (event) => {
          if (event.event === "agent") {
            events.push(event.payload as AgentEventPayload);
          } else if (event.event === "chat") {
            const payload = event.payload as { state?: string; runId?: string } | undefined;
            if (payload?.state === "final" && payload.runId) {
              chatFinalRunIds.add(payload.runId);
            }
          }
        },
      });
      await client.waitOpen();
      const connected = await client.request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "terminal-cancellation-proof",
          version: "dev",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        auth: { token },
      });
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);

      for (const abort of [false, true]) {
        const runA = randomUUID();
        const runB = randomUUID();
        const sessionKey = `agent:main:terminal-${runA}`;
        const markerA = `INITIAL_${runA}`;
        const markerB = `LATE_STEER_${runB}`;
        const requestOffset = requests.length;
        holdNextDelivery = true;
        const subscribed = await client.request("sessions.messages.subscribe", { key: sessionKey });
        expect(subscribed.ok, JSON.stringify(subscribed.error)).toBe(true);
        const route = {
          sessionKey,
          deliver: true,
          originatingChannel: "telegram",
          originatingTo: CHAT_ID,
          originatingAccountId: "proof",
        };
        const first = await client.request("chat.send", {
          ...route,
          message: markerA,
          idempotencyKey: runA,
        });
        expect(first.ok, JSON.stringify(first.error)).toBe(true);
        expect(first.payload).toMatchObject({ runId: runA, status: "started" });
        await vi.waitFor(() => {
          expect(heldDelivery?.result.text).toBe(`TERMINAL_REPLY_${requestOffset}`);
          expect(instance.logs()).toContain(`embedded run agent end: runId=${runA} `);
        }, WAIT);
        expect(requests).toHaveLength(requestOffset + 1);
        expect(requests[requestOffset]).toContain(markerA);
        const second = await client.request("chat.send", {
          ...route,
          message: markerB,
          queueMode: "steer",
          idempotencyKey: runB,
        });
        expect(second.ok, JSON.stringify(second.error)).toBe(true);
        // This ACK is not acceptance proof: rejected injection uses the same ACK.
        expect(second.payload).toMatchObject({ runId: runB, status: "started" });
        expect(requests).toHaveLength(requestOffset + 1);
        if (abort) {
          const cancelled = await client.request("sessions.abort", {
            key: sessionKey,
            runId: runA,
          });
          expect(cancelled.ok, JSON.stringify(cancelled.error)).toBe(true);
          expect(cancelled.payload).toMatchObject({ abortedRunId: runA, status: "aborted" });
        }
        releaseDelivery();
        await vi.waitFor(() => {
          const logs = instance.logs();
          if (abort) {
            // Cancellation rejects after attempt cleanup, bypassing normal run-done.
            // The exact session-lane rejection joins that work; an abort ACK does not.
            const laneErrors = logs
              .split("\n")
              .filter((line) => line.startsWith("{"))
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .filter(
                (record) =>
                  record.subsystem === "diagnostic" &&
                  typeof record.message === "string" &&
                  record.message.startsWith(`lane task error: lane=session:${sessionKey} `),
              );
            expect(laneErrors).toHaveLength(1);
            expect(laneErrors[0]).toMatchObject({ level: "error", errorName: "AbortError" });
            expect(logs).toMatch(
              new RegExp(`run cleanup: runId=${runA} [^\\n]*aborted=true timedOut=false`),
            );
          } else {
            expect(logs).toContain(`embedded run done: runId=${runA} `);
          }
        }, WAIT);
        const joinedLogs = gateway.logs();
        expect(joinedLogs).not.toContain("[output truncated to last");
        expect(joinedLogs).not.toContain(`abort settle timed out: runId=${runA} `);
        expect(joinedLogs).not.toContain(`abort settle failed: runId=${runA} `);
        expect(joinedLogs).not.toContain(`transcript teardown budget expired: runId=${runA} `);
        expect(joinedLogs).not.toContain("lane task rejected after timeout:");
        expect(joinedLogs).not.toContain("CRITICAL:");
        if (abort) {
          // Public terminal projection is diagnostic, not a cleanup-join receipt.
          const terminal = await client.request("agent.wait", { runId: runA, timeoutMs: 0 });
          expect(terminal.ok, JSON.stringify(terminal.error)).toBe(true);
          expect(terminal.payload).toMatchObject({ runId: runA });
          const outcome = terminal.payload as Record<string, unknown>;
          console.info(
            "terminal-cancellation public outcome",
            JSON.stringify({
              runId: runA,
              status: outcome.status,
              stopReason:
                typeof outcome.stopReason === "string"
                  ? outcome.stopReason.slice(0, 1024)
                  : undefined,
              timeoutPhase: outcome.timeoutPhase,
              providerStarted: outcome.providerStarted,
              error: typeof outcome.error === "string" ? outcome.error.slice(0, 1024) : undefined,
            }),
          );
          recordTelegramWire(`native-joined:${runA}`);
        }
        const joinedHistory = await client.request("sessions.get", { key: sessionKey });
        expect(joinedHistory.ok, JSON.stringify(joinedHistory.error)).toBe(true);
        expect(joinedLogs.split(`embedded run agent start: runId=${runA}`).length - 1).toBe(
          abort ? 1 : 2,
        );
        await vi.waitFor(() => {
          const startsA = events.filter(
            (event) =>
              event.runId === runA && event.stream === "lifecycle" && event.data.phase === "start",
          );
          expect(startsA).toHaveLength(abort ? 1 : 2);
        }, WAIT);

        if (abort) {
          // Observe B's actual disposition; logical settlement can release it before
          // the existing 120s commit deadline. Keep the full bounded observation window.
          await vi.waitFor(
            () => {
              expect(instance.logs()).toContain(`embedded run done: runId=${runB} `);
            },
            { timeout: 135_000, interval: 100 },
          );
          await vi.waitFor(() => {
            expect(
              events.filter(
                (event) =>
                  event.runId === runB &&
                  event.stream === "lifecycle" &&
                  event.data.phase === "start",
              ),
            ).toHaveLength(1);
          }, WAIT);
        }
        await vi.waitFor(() => {
          expect(
            sends
              .filter((send) => send.text === `TERMINAL_REPLY_${requestOffset + 1}`)
              .map((send) => String(send.chat_id)),
          ).toEqual([CHAT_ID]);
        }, WAIT);
        const settledLogs = gateway.logs();
        expect(settledLogs).not.toContain("[output truncated to last");
        expect(settledLogs).not.toContain("lane task rejected after timeout:");
        expect(settledLogs).not.toContain("CRITICAL:");
        for (const runId of [runA, runB]) {
          expect(settledLogs).not.toContain(`abort settle timed out: runId=${runId} `);
          expect(settledLogs).not.toContain(`abort settle failed: runId=${runId} `);
          expect(settledLogs).not.toContain(`transcript teardown budget expired: runId=${runId} `);
        }
        expect(settledLogs.split(`embedded run agent start: runId=${runA}`).length - 1).toBe(
          abort ? 1 : 2,
        );
        expect(settledLogs.split(`embedded run agent start: runId=${runB}`).length - 1).toBe(
          abort ? 1 : 0,
        );
        expect(requests).toHaveLength(requestOffset + 2);
        expect(requests[requestOffset + 1]).toContain(markerB);
        await vi.waitFor(() => expect(chatFinalRunIds.has(runB)).toBe(true), WAIT);
        const history = await client.request("sessions.get", { key: sessionKey });
        expect(history.ok, JSON.stringify(history.error)).toBe(true);
        const messages = (history.payload as { messages: Array<Record<string, unknown>> }).messages;
        const inputs = messages.filter(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(markerB),
        );
        expect(inputs).toHaveLength(1);
        if (abort) {
          expect(inputs[0]).not.toHaveProperty("__openclaw.steerTargetRunId");
        } else {
          expect(inputs[0]).toHaveProperty("__openclaw.steerTargetRunId", runA);
          expect(
            events.filter((event) => event.runId === runB && event.stream === "lifecycle"),
          ).toEqual([]);
        }
        expect(serverErrors).toEqual([]);
        recordTelegramWire(`disposition:${runA}:${runB}`);
        expect(sends.map((send) => ({ chatId: String(send.chat_id), text: send.text }))).toEqual(
          Array.from({ length: requestOffset + 2 }, (_, index) => ({
            chatId: CHAT_ID,
            text: `TERMINAL_REPLY_${index}`,
          })),
        );
      }
    } catch (error) {
      recordTelegramWire("failure");
      console.error(gateway?.logs());
      throw error;
    } finally {
      releaseDelivery();
      const socket = client?.ws;
      const clientClosed =
        socket && socket.readyState !== socket.CLOSED
          ? new Promise<void>((resolve) => {
              socket.once("close", resolve);
            })
          : Promise.resolve();
      client?.close();
      try {
        await gateway?.cleanup();
      } finally {
        client?.ws.terminate();
        await clientClosed;
        for (const response of pendingPolls) {
          response.destroy();
        }
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          });
        }
      }
    }
  }, 240_000);
});
