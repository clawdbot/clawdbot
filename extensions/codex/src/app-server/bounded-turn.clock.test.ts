import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult, turnStartResult } from "./codex-app-server.test-fixtures.js";
import type { RpcRequest } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

describe("bounded Codex turn elapsed deadlines over WebSocket", () => {
  it.each([0, 60_000, -60_000])(
    "keeps its real timeout after a %s ms startup clock correction",
    async (clockStepMs) => {
      // Only the protocol peer is controlled: client, socket, and timers are real.
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const methods: string[] = [];
      const thread = threadStartResult("clock-thread", process.cwd());
      const turn = turnStartResult("clock-turn");
      server.on("connection", (socket) => {
        socket.on("message", (data) => {
          const request = JSON.parse(data.toString()) as RpcRequest;
          methods.push(request.method);
          const respond = (result: unknown) => {
            socket.send(JSON.stringify({ id: request.id, result }));
          };
          switch (request.method) {
            case "initialize":
              respond({ userAgent: `codex/${CODEX_APP_SERVER_VERSION}` });
              break;
            case "initialized":
              break;
            case "model/list":
              respond({
                data: [
                  {
                    id: thread.model,
                    model: thread.model,
                    upgrade: null,
                    upgradeInfo: null,
                    availabilityNux: null,
                    displayName: "Clock proof model",
                    description: "Controlled protocol fixture; no provider calls",
                    hidden: false,
                    isDefault: true,
                    inputModalities: ["text"],
                    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
                    defaultReasoningEffort: "low",
                    supportsPersonality: false,
                    multiAgentVersion: null,
                    additionalSpeedTiers: [],
                    serviceTiers: [],
                    defaultServiceTier: null,
                  },
                ],
                nextCursor: null,
              });
              break;
            case "thread/start":
              respond(thread);
              break;
            case "turn/start":
              respond(turn);
              break;
            case "turn/interrupt":
              respond({});
              socket.send(
                JSON.stringify({
                  method: "turn/completed",
                  params: {
                    threadId: thread.thread.id,
                    ...turnStartResult(turn.turn.id, "interrupted"),
                  },
                }),
              );
              break;
            default:
              socket.send(
                JSON.stringify({
                  id: request.id,
                  error: { code: -32601, message: `Unexpected method: ${request.method}` },
                }),
              );
          }
        });
      });

      const realDateNow = Date.now;
      const wallClock = vi.spyOn(Date, "now");
      const caller = new AbortController();
      let client: CodexAppServerClient | undefined;
      let initialized = false;
      let run: Promise<unknown> | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("expected a loopback WebSocket port");
        }
        const startedAt = performance.now();
        // Bound the old backward-clock bug without simulating its expiry.
        watchdog = setTimeout(() => {
          caller.abort(new Error("clock proof watchdog"));
          if (!initialized) {
            client?.close();
          }
        }, 4_000);
        run = runBoundedCodexAppServerTurn({
          model: { mode: "required", id: thread.model },
          timeoutMs: 1_000,
          signal: caller.signal,
          options: {
            clientFactory: async () => {
              client = await CodexAppServerClient.start({
                transport: "websocket",
                url: `ws://127.0.0.1:${address.port}`,
                headers: {},
                authToken: undefined,
              });
              await client.initialize();
              initialized = true;
              // Apply one process-local offset after startup, never an OS clock change.
              wallClock.mockImplementation(() => realDateNow() + clockStepMs);
              return client;
            },
          },
          taskLabel: "clock proof",
          developerInstructions: "Wait for cancellation.",
          input: [{ type: "text", text: "Clock proof.", text_elements: [] }],
          requiredModalities: ["text"],
          isolation: "configured-transport",
        }).catch((error: unknown) => error);
        const outcome = await run;
        const elapsedMs = performance.now() - startedAt;
        console.info("bounded-turn-clock", {
          clockStepMs,
          elapsedMs: Math.round(elapsedMs),
          outcome: outcome instanceof Error ? outcome.name : "completed",
          watchdogAborted: caller.signal.aborted,
          methods,
        });
        expect(methods).toEqual([
          "initialize",
          "initialized",
          "model/list",
          "thread/start",
          "turn/start",
          "turn/interrupt",
        ]);
        expect(outcome).toMatchObject({
          name: "TimeoutError",
          message: "codex app-server clock proof turn timed out after 1s",
        });
        expect(caller.signal.aborted).toBe(false);
        expect(elapsedMs).toBeGreaterThanOrEqual(900);
        expect(elapsedMs).toBeLessThan(4_000);
      } finally {
        clearTimeout(watchdog);
        wallClock.mockRestore();
        caller.abort();
        await run;
        await client?.closeAndWait();
        await Promise.all(
          [...server.clients].map((socket) => {
            const closed = once(socket, "close");
            socket.terminate();
            return closed;
          }),
        );
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        expect(server.clients.size).toBe(0);
        expect(server.address()).toBeNull();
      }
    },
  );
});
