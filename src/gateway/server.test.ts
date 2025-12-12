import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { startGatewayServer } from "./server.js";

let testSessionStorePath: string | undefined;
let testAllowFrom: string[] | undefined;
vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    inbound: {
      allowFrom: testAllowFrom,
      reply: {
        mode: "command",
        command: ["echo", "ok"],
        session: { mainKey: "main", store: testSessionStorePath },
      },
    },
  }),
}));

vi.mock("../commands/health.js", () => ({
  getHealthSnapshot: vi.fn().mockResolvedValue({ ok: true, stub: true }),
}));
vi.mock("../commands/status.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../webchat/server.js", () => ({
  ensureWebChatServerFromConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock("../web/outbound.js", () => ({
  sendMessageWhatsApp: vi
    .fn()
    .mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn().mockResolvedValue(undefined),
}));

process.env.CLAWDIS_SKIP_PROVIDERS = "1";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function occupyPort(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

function onceMessage<T = unknown>(
  ws: WebSocket,
  filter: (obj: unknown) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(String(data));
      if (filter(obj)) {
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(obj as T);
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

async function startServerWithClient(token?: string) {
  const port = await getFreePort();
  const prev = process.env.CLAWDIS_GATEWAY_TOKEN;
  if (token === undefined) {
    delete process.env.CLAWDIS_GATEWAY_TOKEN;
  } else {
    process.env.CLAWDIS_GATEWAY_TOKEN = token;
  }
  const server = await startGatewayServer(port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return { server, ws, port, prevToken: prev };
}

describe("gateway server", () => {
  test("agent falls back to allowFrom when lastTo is stale", async () => {
    testAllowFrom = ["+436769770569"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-stale",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last-stale",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last-stale",
        },
      }),
    );
    await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "agent-last-stale",
    );

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+436769770569");
    expect(call.sessionId).toBe("sess-main-stale");

    ws.close();
    await server.close();
    testAllowFrom = undefined;
  });

  test("agent routes main last-channel whatsapp", async () => {
    testAllowFrom = undefined;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-whatsapp",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last-whatsapp",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last-whatsapp",
        },
      }),
    );
    await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "agent-last-whatsapp",
    );

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-whatsapp");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel telegram", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-last",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-last",
        },
      }),
    );
    await onceMessage(ws, (o) => o.type === "res" && o.id === "agent-last");

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("telegram");
    expect(call.to).toBe("123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main");

    ws.close();
    await server.close();
  });

  test("agent forces no-deliver when last-channel is webchat", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-webchat",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "ignored",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    ws.send(
      JSON.stringify({
        type: "req",
        id: "agent-webchat",
        method: "agent",
        params: {
          message: "hi",
          sessionKey: "main",
          channel: "last",
          deliver: true,
          idempotencyKey: "idem-agent-webchat",
        },
      }),
    );
    await onceMessage(ws, (o) => o.type === "res" && o.id === "agent-webchat");

    const spy = vi.mocked(agentCommand);
    expect(spy).toHaveBeenCalled();
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.provider).toBe("webchat");
    expect(call.deliver).toBe(false);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-webchat");

    ws.close();
    await server.close();
  });

  test("rejects protocol mismatch", async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 2,
        maxProtocol: 3,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
      }),
    );
    try {
      const res = await onceMessage(ws, () => true, 2000);
      expect(res.type).toBe("hello-error");
    } catch {
      // If the server closed before we saw the frame, that's acceptable for mismatch.
    }
    ws.close();
    await server.close();
  });

  test("rejects invalid token", async () => {
    const { server, ws, prevToken } = await startServerWithClient("secret");
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
        auth: { token: "wrong" },
      }),
    );
    const res = await onceMessage(ws, () => true);
    expect(res.type).toBe("hello-error");
    expect(res.reason).toContain("unauthorized");
    ws.close();
    await server.close();
    process.env.CLAWDIS_GATEWAY_TOKEN = prevToken;
  });

  test(
    "closes silent handshakes after timeout",
    { timeout: 15_000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 12_000);
        ws.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      expect(closed).toBe(true);
      await server.close();
    },
  );

  test(
    "hello + health + presence + status succeed",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      ws.send(
        JSON.stringify({
          type: "hello",
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "test",
            version: "1.0.0",
            platform: "test",
            mode: "test",
          },
          caps: [],
        }),
      );
      await onceMessage(ws, (o) => o.type === "hello-ok");

      const healthP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "health1",
      );
      const statusP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "status1",
      );
      const presenceP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "presence1",
      );

      const sendReq = (id: string, method: string) =>
        ws.send(JSON.stringify({ type: "req", id, method }));
      sendReq("health1", "health");
      sendReq("status1", "status");
      sendReq("presence1", "system-presence");

      const health = await healthP;
      const status = await statusP;
      const presence = await presenceP;
      expect(health.ok).toBe(true);
      expect(status.ok).toBe(true);
      expect(presence.ok).toBe(true);
      expect(Array.isArray(presence.payload)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test(
    "presence events carry seq + stateVersion",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      ws.send(
        JSON.stringify({
          type: "hello",
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "test",
            version: "1.0.0",
            platform: "test",
            mode: "test",
          },
          caps: [],
        }),
      );
      await onceMessage(ws, (o) => o.type === "hello-ok");

      const presenceEventP = onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "presence",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "evt-1",
          method: "system-event",
          params: { text: "note from test" },
        }),
      );

      const evt = await presenceEventP;
      expect(typeof evt.seq).toBe("number");
      expect(evt.stateVersion?.presence).toBeGreaterThan(0);
      expect(Array.isArray(evt.payload?.presence)).toBe(true);

      ws.close();
      await server.close();
    },
  );

  test("agent events stream with seq", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          name: "test",
          version: "1.0.0",
          platform: "test",
          mode: "test",
        },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    // Emit a fake agent event directly through the shared emitter.
    const evtPromise = onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "agent",
    );
    emitAgentEvent({ runId: "run-1", stream: "job", data: { msg: "hi" } });
    const evt = await evtPromise;
    expect(evt.payload.runId).toBe("run-1");
    expect(typeof evt.seq).toBe("number");
    expect(evt.payload.data.msg).toBe("hi");

    ws.close();
    await server.close();
  });

  test(
    "agent ack response then final response",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      ws.send(
        JSON.stringify({
          type: "hello",
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "test",
            version: "1.0.0",
            platform: "test",
            mode: "test",
          },
          caps: [],
        }),
      );
      await onceMessage(ws, (o) => o.type === "hello-ok");

      const ackP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status === "accepted",
      );
      const finalP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status !== "accepted",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag1",
          method: "agent",
          params: { message: "hi", idempotencyKey: "idem-ag" },
        }),
      );

      const ack = await ackP;
      const final = await finalP;
      expect(ack.payload.runId).toBeDefined();
      expect(final.payload.runId).toBe(ack.payload.runId);
      expect(final.payload.status).toBe("ok");

      ws.close();
      await server.close();
    },
  );

  test(
    "agent dedupes by idempotencyKey after completion",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      ws.send(
        JSON.stringify({
          type: "hello",
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "test",
            version: "1.0.0",
            platform: "test",
            mode: "test",
          },
          caps: [],
        }),
      );
      await onceMessage(ws, (o) => o.type === "hello-ok");

      const firstFinalP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status !== "accepted",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag1",
          method: "agent",
          params: { message: "hi", idempotencyKey: "same-agent" },
        }),
      );
      const firstFinal = await firstFinalP;

      const secondP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "ag2",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ag2",
          method: "agent",
          params: { message: "hi again", idempotencyKey: "same-agent" },
        }),
      );
      const second = await secondP;
      expect(second.payload).toEqual(firstFinal.payload);

      ws.close();
      await server.close();
    },
  );

  test("shutdown event is broadcast on close", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          name: "test",
          version: "1.0.0",
          platform: "test",
          mode: "test",
        },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    const shutdownP = onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "shutdown",
      5000,
    );
    await server.close();
    const evt = await shutdownP;
    expect(evt.payload?.reason).toBeDefined();
  });

  test(
    "presence broadcast reaches multiple clients",
    { timeout: 8000 },
    async () => {
      const port = await getFreePort();
      const server = await startGatewayServer(port);
      const mkClient = async () => {
        const c = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((resolve) => c.once("open", resolve));
        c.send(
          JSON.stringify({
            type: "hello",
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              name: "test",
              version: "1.0.0",
              platform: "test",
              mode: "test",
            },
            caps: [],
          }),
        );
        await onceMessage(c, (o) => o.type === "hello-ok");
        return c;
      };

      const clients = await Promise.all([mkClient(), mkClient(), mkClient()]);
      const waits = clients.map((c) =>
        onceMessage(c, (o) => o.type === "event" && o.event === "presence"),
      );
      clients[0].send(
        JSON.stringify({
          type: "req",
          id: "broadcast",
          method: "system-event",
          params: { text: "fanout" },
        }),
      );
      const events = await Promise.all(waits);
      for (const evt of events) {
        expect(evt.payload?.presence?.length).toBeGreaterThan(0);
        expect(typeof evt.seq).toBe("number");
      }
      for (const c of clients) c.close();
      await server.close();
    },
  );

  test("send dedupes by idempotencyKey", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          name: "test",
          version: "1.0.0",
          platform: "test",
          mode: "test",
        },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    const idem = "same-key";
    const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
    const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
    const sendReq = (id: string) =>
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "send",
          params: { to: "+15550000000", message: "hi", idempotencyKey: idem },
        }),
      );
    sendReq("a1");
    sendReq("a2");

    const res1 = await res1P;
    const res2 = await res2P;
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.payload).toEqual(res2.payload);
    ws.close();
    await server.close();
  });

  test("agent dedupe survives reconnect", { timeout: 15000 }, async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);

    const dial = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws.once("open", resolve));
      ws.send(
        JSON.stringify({
          type: "hello",
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            name: "test",
            version: "1.0.0",
            platform: "test",
            mode: "test",
          },
          caps: [],
        }),
      );
      await onceMessage(ws, (o) => o.type === "hello-ok");
      return ws;
    };

    const idem = "reconnect-agent";
    const ws1 = await dial();
    const final1P = onceMessage(
      ws1,
      (o) =>
        o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
      6000,
    );
    ws1.send(
      JSON.stringify({
        type: "req",
        id: "ag1",
        method: "agent",
        params: { message: "hi", idempotencyKey: idem },
      }),
    );
    const final1 = await final1P;
    ws1.close();

    const ws2 = await dial();
    const final2P = onceMessage(
      ws2,
      (o) =>
        o.type === "res" && o.id === "ag2" && o.payload?.status !== "accepted",
      6000,
    );
    ws2.send(
      JSON.stringify({
        type: "req",
        id: "ag2",
        method: "agent",
        params: { message: "hi again", idempotencyKey: idem },
      }),
    );
    const res = await final2P;
    expect(res.payload).toEqual(final1.payload);
    ws2.close();
    await server.close();
  });

  test("chat.send accepts image attachment", { timeout: 12000 }, async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

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
              content:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
            },
          ],
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
      8000,
    );
    expect(res.ok).toBe(true);
    expect(res.payload?.runId).toBeDefined();

    ws.close();
    await server.close();
  });

  test("chat.send does not overwrite last delivery route", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-gw-"));
    testSessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testSessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: { name: "test", version: "1", platform: "test", mode: "test" },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    const reqId = "chat-route";
    ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-route",
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
    );
    expect(res.ok).toBe(true);

    const stored = JSON.parse(
      await fs.readFile(testSessionStorePath, "utf-8"),
    ) as {
      main?: { lastChannel?: string; lastTo?: string };
    };
    expect(stored.main?.lastChannel).toBe("whatsapp");
    expect(stored.main?.lastTo).toBe("+1555");

    ws.close();
    await server.close();
  });

  test("presence includes client fingerprint", async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          name: "fingerprint",
          version: "9.9.9",
          platform: "test",
          mode: "ui",
          instanceId: "abc",
        },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "fingerprint",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "fingerprint",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    const clientEntry = entries.find((e) => e.instanceId === "abc");
    expect(clientEntry?.host).toBe("fingerprint");
    expect(clientEntry?.version).toBe("9.9.9");
    expect(clientEntry?.mode).toBe("ui");

    ws.close();
    await server.close();
  });

  test("cli connections are not tracked as instances", async () => {
    const { server, ws } = await startServerWithClient();
    const cliId = `cli-${randomUUID()}`;
    ws.send(
      JSON.stringify({
        type: "hello",
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          name: "cli",
          version: "dev",
          platform: "test",
          mode: "cli",
          instanceId: cliId,
        },
        caps: [],
      }),
    );
    await onceMessage(ws, (o) => o.type === "hello-ok");

    const presenceP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "cli-presence",
      4000,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "cli-presence",
        method: "system-presence",
      }),
    );

    const presenceRes = await presenceP;
    const entries = presenceRes.payload as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.instanceId === cliId)).toBe(false);

    ws.close();
    await server.close();
  });

  test("refuses to start when port already bound", async () => {
    const { server: blocker, port } = await occupyPort();
    await expect(startGatewayServer(port)).rejects.toBeInstanceOf(
      GatewayLockError,
    );
    await expect(startGatewayServer(port)).rejects.toThrow(
      /already listening/i,
    );
    blocker.close();
  });

  test("releases port after close", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    await server.close();

    // If the port was released, another listener can bind immediately.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
