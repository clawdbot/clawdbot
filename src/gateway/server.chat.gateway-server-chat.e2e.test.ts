import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

async function waitFor(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway server chat", () => {
  test("handles chat send and history flows", async () => {
    const tempDirs: string[] = [];
    let webchatWs: WebSocket | undefined;

    try {
      webchatWs = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => webchatWs?.once("open", resolve));
      await connectOk(webchatWs, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });

      const webchatRes = await rpcReq(webchatWs, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-webchat-1",
      });
      expect(webchatRes.ok).toBe(true);

      webchatWs.close();
      webchatWs = undefined;

      const spy = vi.mocked(getReplyFromConfig);
      spy.mockClear();
      testState.agentConfig = { timeoutSeconds: 123 };
      const callsBeforeTimeout = spy.mock.calls.length;
      const timeoutRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-timeout-1",
      });
      expect(timeoutRes.ok).toBe(true);

      await waitFor(() => spy.mock.calls.length > callsBeforeTimeout);
      const timeoutCall = spy.mock.calls.at(-1)?.[1] as { runId?: string } | undefined;
      expect(timeoutCall?.runId).toBe("idem-timeout-1");
      testState.agentConfig = undefined;

      spy.mockClear();
      const callsBeforeSession = spy.mock.calls.length;
      const sessionRes = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:main:subagent:abc",
        message: "hello",
        idempotencyKey: "idem-session-key-1",
      });
      expect(sessionRes.ok).toBe(true);

      await waitFor(() => spy.mock.calls.length > callsBeforeSession);
      const sessionCall = spy.mock.calls.at(-1)?.[0] as { SessionKey?: string } | undefined;
      expect(sessionCall?.SessionKey).toBe("agent:main:subagent:abc");

      const sendPolicyDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
      tempDirs.push(sendPolicyDir);
      testState.sessionStorePath = path.join(sendPolicyDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: { channel: "discord", chatType: "group" },
            },
          ],
        },
      };

      await writeSessionStore({
        entries: {
          "discord:group:dev": {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            chatType: "group",
            channel: "discord",
          },
        },
      });

      const blockedRes = await rpcReq(ws, "chat.send", {
        sessionKey: "discord:group:dev",
        message: "hello",
        idempotencyKey: "idem-1",
      });
      expect(blockedRes.ok).toBe(false);
      expect((blockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const agentBlockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
      tempDirs.push(agentBlockedDir);
      testState.sessionStorePath = path.join(agentBlockedDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
        },
      };

      await writeSessionStore({
        entries: {
          "cron:job-1": {
            sessionId: "sess-cron",
            updatedAt: Date.now(),
          },
        },
      });

      const agentBlockedRes = await rpcReq(ws, "agent", {
        sessionKey: "cron:job-1",
        message: "hi",
        idempotencyKey: "idem-2",
      });
      expect(agentBlockedRes.ok).toBe(false);
      expect((agentBlockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      spy.mockClear();
      const callsBeforeImage = spy.mock.calls.length;
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

      const reqId = "chat-img";
      ws.send(
        JSON.stringify({
          type: "req",
          id: reqId,
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "see image",
            idempotencyKey: "idem-img",
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "dot.png",
                content: `data:image/png;base64,${pngB64}`,
              },
            ],
          },
        }),
      );

      const imgRes = await onceMessage(ws, (o) => o.type === "res" && o.id === reqId, 8000);
      expect(imgRes.ok).toBe(true);
      expect(imgRes.payload?.runId).toBeDefined();

      await waitFor(() => spy.mock.calls.length > callsBeforeImage, 8000);
      const imgOpts = spy.mock.calls.at(-1)?.[1] as
        | { images?: Array<{ type: string; data: string; mimeType: string }> }
        | undefined;
      expect(imgOpts?.images).toEqual([{ type: "image", data: pngB64, mimeType: "image/png" }]);

      const callsBeforeImageOnly = spy.mock.calls.length;
      const reqIdOnly = "chat-img-only";
      ws.send(
        JSON.stringify({
          type: "req",
          id: reqIdOnly,
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "",
            idempotencyKey: "idem-img-only",
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "dot.png",
                content: `data:image/png;base64,${pngB64}`,
              },
            ],
          },
        }),
      );

      const imgOnlyRes = await onceMessage(ws, (o) => o.type === "res" && o.id === reqIdOnly, 8000);
      expect(imgOnlyRes.ok).toBe(true);
      expect(imgOnlyRes.payload?.runId).toBeDefined();

      await waitFor(() => spy.mock.calls.length > callsBeforeImageOnly, 8000);
      const imgOnlyOpts = spy.mock.calls.at(-1)?.[1] as
        | { images?: Array<{ type: string; data: string; mimeType: string }> }
        | undefined;
      expect(imgOnlyOpts?.images).toEqual([{ type: "image", data: pngB64, mimeType: "image/png" }]);

      const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
      tempDirs.push(historyDir);
      testState.sessionStorePath = path.join(historyDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const lines: string[] = [];
      for (let i = 0; i < 300; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `m${i}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await fs.writeFile(path.join(historyDir, "sess-main.jsonl"), lines.join("\n"), "utf-8");

      const defaultRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(defaultRes.ok).toBe(true);
      const defaultMsgs = defaultRes.payload?.messages ?? [];
      const firstContentText = (msg: unknown): string | undefined => {
        if (!msg || typeof msg !== "object") return undefined;
        const content = (msg as { content?: unknown }).content;
        if (!Array.isArray(content) || content.length === 0) return undefined;
        const first = content[0];
        if (!first || typeof first !== "object") return undefined;
        const text = (first as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      };
      expect(defaultMsgs.length).toBe(200);
      expect(firstContentText(defaultMsgs[0])).toBe("m100");
    } finally {
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      if (webchatWs) webchatWs.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("routes chat.send slash commands without agent runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    try {
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const spy = vi.mocked(agentCommand);
      const callsBefore = spy.mock.calls.length;
      const eventPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.state === "final" &&
          o.payload?.runId === "idem-command-1",
        8000,
      );
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/context list",
        idempotencyKey: "idem-command-1",
      });
      expect(res.ok).toBe(true);
      const evt = await eventPromise;
      expect(evt.payload?.message?.command).toBe(true);
      expect(spy.mock.calls.length).toBe(callsBefore);
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("agent events include sessionKey and agent.wait covers lifecycle flows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          verboseLevel: "off",
        },
      },
    });

    const webchatWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => webchatWs.once("open", resolve));
    await connectOk(webchatWs, {
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    try {
      registerAgentRunContext("run-tool-1", {
        sessionKey: "main",
        verboseLevel: "on",
      });

      {
        const agentEvtP = onceMessage(
          webchatWs,
          (o) => o.type === "event" && o.event === "agent" && o.payload?.runId === "run-tool-1",
          8000,
        );

        emitAgentEvent({
          runId: "run-tool-1",
          stream: "tool",
          data: { phase: "start", name: "read", toolCallId: "tool-1" },
        });

        const evt = await agentEvtP;
        const payload =
          evt.payload && typeof evt.payload === "object"
            ? (evt.payload as Record<string, unknown>)
            : {};
        expect(payload.sessionKey).toBe("main");
      }

      {
        registerAgentRunContext("run-tool-off", { sessionKey: "agent:main:main" });

        emitAgentEvent({
          runId: "run-tool-off",
          stream: "tool",
          data: { phase: "start", name: "read", toolCallId: "tool-1" },
        });
        emitAgentEvent({
          runId: "run-tool-off",
          stream: "assistant",
          data: { text: "hello" },
        });

        const evt = await onceMessage(
          webchatWs,
          (o) => o.type === "event" && o.event === "agent" && o.payload?.runId === "run-tool-off",
          8000,
        );
        const payload =
          evt.payload && typeof evt.payload === "object"
            ? (evt.payload as Record<string, unknown>)
            : {};
        expect(payload.stream).toBe("assistant");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-1",
          timeoutMs: 1000,
        });

        setTimeout(() => {
          emitAgentEvent({
            runId: "run-wait-1",
            stream: "lifecycle",
            data: { phase: "end", startedAt: 200, endedAt: 210 },
          });
        }, 5);

        const res = await waitP;
        expect(res.ok).toBe(true);
        expect(res.payload.status).toBe("ok");
        expect(res.payload.startedAt).toBe(200);
      }

      {
        emitAgentEvent({
          runId: "run-wait-early",
          stream: "lifecycle",
          data: { phase: "end", startedAt: 50, endedAt: 55 },
        });

        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-early",
          timeoutMs: 1000,
        });
        expect(res.ok).toBe(true);
        expect(res.payload.status).toBe("ok");
        expect(res.payload.startedAt).toBe(50);
      }

      {
        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-3",
          timeoutMs: 30,
        });
        expect(res.ok).toBe(true);
        expect(res.payload.status).toBe("timeout");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-err",
          timeoutMs: 1000,
        });

        setTimeout(() => {
          emitAgentEvent({
            runId: "run-wait-err",
            stream: "lifecycle",
            data: { phase: "error", error: "boom" },
          });
        }, 5);

        const res = await waitP;
        expect(res.ok).toBe(true);
        expect(res.payload.status).toBe("error");
        expect(res.payload.error).toBe("boom");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-start",
          timeoutMs: 1000,
        });

        emitAgentEvent({
          runId: "run-wait-start",
          stream: "lifecycle",
          data: { phase: "start", startedAt: 123 },
        });

        setTimeout(() => {
          emitAgentEvent({
            runId: "run-wait-start",
            stream: "lifecycle",
            data: { phase: "end", endedAt: 456 },
          });
        }, 5);

        const res = await waitP;
        expect(res.ok).toBe(true);
        expect(res.payload.status).toBe("ok");
        expect(res.payload.startedAt).toBe(123);
        expect(res.payload.endedAt).toBe(456);
      }
    } finally {
      webchatWs.close();
      await fs.rm(dir, { recursive: true, force: true });
      testState.sessionStorePath = undefined;
    }
  });
});
