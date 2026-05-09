import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { installGatewayTestHooks, startServer } from "../../../src/gateway/test-helpers.js";
import { emitAgentEvent, registerAgentRunContext } from "../../../src/infra/agent-events.js";
import { GatewayClientTransport, OpenClaw } from "./index.js";

type JsonObject = Record<string, unknown>;
type FakeGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};
type FakeGateway = {
  url: string;
  requests: FakeGatewayRequest[];
  close: () => Promise<void>;
};

const servers: WebSocketServer[] = [];

function sendJson(socket: WebSocket, payload: JsonObject): void {
  socket.send(JSON.stringify(payload));
}

function readRawMessage(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  return Buffer.concat(raw).toString("utf8");
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createFakeGateway(port = 0): Promise<FakeGateway> {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let seq = 1;
  const requests: FakeGatewayRequest[] = [];
  const sockets = new Set<WebSocket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    sendJson(socket, {
      type: "event",
      event: "connect.challenge",
      seq: seq++,
      payload: { nonce: "sdk-e2e-nonce" },
    });

    socket.on("message", (raw) => {
      const frame = JSON.parse(readRawMessage(raw)) as FakeGatewayRequest;
      requests.push(frame);
      const reply = (payload: JsonObject): void => {
        sendJson(socket, { type: "res", id: frame.id, ok: true, payload });
      };

      if (frame.method === "connect") {
        reply({
          type: "hello-ok",
          protocol: 1,
          server: { version: "sdk-e2e", connId: "conn-sdk-e2e" },
          features: {
            methods: [
              "agent",
              "agent.wait",
              "agent.identity.get",
              "agents.create",
              "agents.delete",
              "agents.list",
              "agents.update",
              "connect",
              "exec.approval.list",
              "exec.approval.resolve",
              "models.authStatus",
              "models.list",
              "sessions.abort",
              "sessions.create",
              "sessions.compact",
              "sessions.list",
              "sessions.patch",
              "sessions.resolve",
              "sessions.send",
              "tools.catalog",
              "tools.effective",
              "tools.invoke",
            ],
            events: ["agent", "sessions.changed"],
          },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 0, health: 0 },
            uptimeMs: 1,
          },
          auth: { role: "operator", scopes: [] },
          policy: {
            maxPayload: 262144,
            maxBufferedBytes: 262144,
            tickIntervalMs: 30000,
          },
        });
        return;
      }

      if (frame.method === "agents.list") {
        reply({ agents: [{ id: "main" }] });
        return;
      }

      if (frame.method === "agent.identity.get") {
        reply({ agentId: "main", ...(frame.params as JsonObject | undefined) });
        return;
      }

      if (
        frame.method === "agents.create" ||
        frame.method === "agents.update" ||
        frame.method === "agents.delete"
      ) {
        reply({ ok: true, method: frame.method, params: frame.params as JsonObject | undefined });
        return;
      }

      if (frame.method === "agent") {
        const params = frame.params as { sessionKey?: string } | undefined;
        reply({
          status: "accepted",
          runId: "run-sdk-e2e",
          sessionKey: params?.sessionKey,
        });
        setTimeout(() => {
          sendJson(socket, {
            type: "event",
            event: "agent",
            seq: seq++,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: params?.sessionKey,
              stream: "lifecycle",
              ts: Date.now(),
              data: { phase: "start" },
            },
          });
          sendJson(socket, {
            type: "event",
            event: "agent",
            seq: seq++,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: params?.sessionKey,
              stream: "assistant",
              ts: Date.now(),
              data: { delta: "hello from fake gateway" },
            },
          });
          sendJson(socket, {
            type: "event",
            event: "agent",
            seq: seq++,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: params?.sessionKey,
              stream: "lifecycle",
              ts: Date.now(),
              data: { phase: "end" },
            },
          });
        }, 50);
        return;
      }

      if (frame.method === "agent.wait") {
        reply({
          status: "ok",
          runId: "run-sdk-e2e",
          sessionKey: "main",
          startedAt: 123,
          endedAt: 456,
        });
        return;
      }

      if (frame.method === "sessions.list") {
        reply({ sessions: [{ key: "sdk-session" }] });
        return;
      }

      if (frame.method === "sessions.create") {
        const params = frame.params as { key?: string } | undefined;
        reply({ key: params?.key ?? "sdk-session" });
        return;
      }

      if (frame.method === "sessions.resolve") {
        reply({ key: "sdk-session", params: frame.params as JsonObject | undefined });
        return;
      }

      if (frame.method === "sessions.send") {
        const params = frame.params as { key?: string } | undefined;
        reply({ status: "ok", runId: "run-session-e2e", sessionKey: params?.key });
        return;
      }

      if (frame.method === "sessions.abort") {
        reply({
          ok: true,
          abortedRunId: (frame.params as { runId?: string } | undefined)?.runId ?? "run-sdk-e2e",
          status: "aborted",
        });
        return;
      }

      if (frame.method === "sessions.patch" || frame.method === "sessions.compact") {
        reply({ ok: true, method: frame.method, params: frame.params as JsonObject | undefined });
        return;
      }

      if (frame.method === "models.list") {
        reply({ models: [{ id: "gpt-5.4" }] });
        return;
      }

      if (frame.method === "models.authStatus") {
        reply({ providers: [] });
        return;
      }

      if (frame.method === "tools.catalog") {
        reply({ tools: [{ name: "shell" }] });
        return;
      }

      if (frame.method === "tools.effective") {
        reply({ tools: [{ name: "shell", enabled: true }] });
        return;
      }

      if (frame.method === "tools.invoke") {
        reply({ ok: true, toolName: "shell", output: { ok: true } });
        return;
      }

      if (frame.method === "exec.approval.list") {
        reply({ approvals: [] });
        return;
      }

      if (frame.method === "exec.approval.resolve") {
        reply({ ok: true, params: frame.params as JsonObject | undefined });
        return;
      }

      sendJson(socket, {
        type: "res",
        id: frame.id,
        ok: false,
        error: { code: "UNKNOWN_METHOD", message: `unhandled fake Gateway method ${frame.method}` },
      });
    });
  });

  const { port: boundPort } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${boundPort}`,
    requests,
    close: () => {
      const index = servers.indexOf(server);
      if (index >= 0) {
        servers.splice(index, 1);
      }
      for (const socket of sockets) {
        socket.terminate();
      }
      sockets.clear();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("OpenClaw SDK websocket e2e", () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) {
              client.terminate();
            }
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("runs an agent and streams normalized events over a Gateway websocket", async () => {
    const gateway = await createFakeGateway();
    const transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });
    try {
      const agent = await oc.agents.get("main");
      const run = await agent.run({
        input: "say hello",
        sessionKey: "main",
        idempotencyKey: "sdk-e2e",
      });
      const seenPromise = (async () => {
        const seen: string[] = [];

        for await (const event of run.events()) {
          seen.push(event.type);
          if (event.type === "run.completed") {
            break;
          }
        }

        return seen;
      })();

      const [seen, result] = await Promise.all([
        withTimeout(seenPromise, 2_000, "timed out waiting for SDK run events"),
        run.wait({ timeoutMs: 2_000 }),
      ]);

      expect(run.id).toBe("run-sdk-e2e");
      expect(seen).toEqual(["run.started", "assistant.delta", "run.completed"]);
      expect(result).toMatchObject({
        runId: "run-sdk-e2e",
        sessionKey: "main",
        status: "completed",
        startedAt: 123,
        endedAt: 456,
      });
      await expect(run.cancel()).resolves.toMatchObject({
        abortedRunId: "run-sdk-e2e",
        status: "aborted",
      });
    } finally {
      await oc.close();
      await gateway.close();
    }
  });

  it("covers documented namespace helpers over a Gateway websocket", async () => {
    const gateway = await createFakeGateway();
    const transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });

    try {
      await expect(oc.agents.list()).resolves.toMatchObject({ agents: [{ id: "main" }] });
      const agent = await oc.agents.get("main");
      await expect(agent.identity({ sessionKey: "sdk-session" })).resolves.toMatchObject({
        agentId: "main",
        sessionKey: "sdk-session",
      });
      await expect(oc.agents.create({ id: "sdk-agent" })).resolves.toMatchObject({
        method: "agents.create",
      });
      await expect(
        oc.agents.update({ id: "sdk-agent", label: "SDK Agent" }),
      ).resolves.toMatchObject({ method: "agents.update" });
      await expect(oc.agents.delete({ id: "sdk-agent" })).resolves.toMatchObject({
        method: "agents.delete",
      });

      await expect(oc.sessions.list()).resolves.toMatchObject({
        sessions: [{ key: "sdk-session" }],
      });
      const session = await oc.sessions.create({ key: "sdk-session", agentId: "main" });
      expect(session.key).toBe("sdk-session");
      await expect(oc.sessions.resolve({ key: "sdk-session" })).resolves.toMatchObject({
        key: "sdk-session",
      });
      const sessionRun = await session.send("continue");
      expect(sessionRun.id).toBe("run-session-e2e");
      await expect(session.abort(sessionRun.id)).resolves.toMatchObject({
        abortedRunId: "run-session-e2e",
      });
      await expect(session.patch({ label: "Renamed" })).resolves.toMatchObject({
        method: "sessions.patch",
      });
      await expect(session.compact({ maxLines: 200 })).resolves.toMatchObject({
        method: "sessions.compact",
      });

      await expect(oc.models.list()).resolves.toMatchObject({ models: [{ id: "gpt-5.4" }] });
      await expect(oc.models.status({ probe: false })).resolves.toMatchObject({ providers: [] });
      await expect(oc.tools.list()).resolves.toMatchObject({ tools: [{ name: "shell" }] });
      await expect(oc.tools.effective({ sessionKey: "sdk-session" })).resolves.toMatchObject({
        tools: [{ name: "shell", enabled: true }],
      });
      await expect(
        oc.tools.invoke("shell", { args: { command: "pwd" }, sessionKey: "sdk-session" }),
      ).resolves.toMatchObject({ ok: true, toolName: "shell", output: { ok: true } });
      await expect(oc.approvals.list()).resolves.toMatchObject({ approvals: [] });
      await expect(
        oc.approvals.respond("approval-1", { decision: "approve" }),
      ).resolves.toMatchObject({ ok: true });

      expect(gateway.requests.map((request) => request.method)).toEqual([
        "connect",
        "agents.list",
        "agent.identity.get",
        "agents.create",
        "agents.update",
        "agents.delete",
        "sessions.list",
        "sessions.create",
        "sessions.resolve",
        "sessions.send",
        "sessions.abort",
        "sessions.patch",
        "sessions.compact",
        "models.list",
        "models.authStatus",
        "tools.catalog",
        "tools.effective",
        "tools.invoke",
        "exec.approval.list",
        "exec.approval.resolve",
      ]);
    } finally {
      await oc.close();
      await gateway.close();
    }
  }, 10_000);

  it("retries after an initial websocket connection failure", async () => {
    const port = await reservePort();
    const url = `ws://127.0.0.1:${port}`;
    const transport = new GatewayClientTransport({
      url,
      deviceIdentity: null,
      connectChallengeTimeoutMs: 200,
      preauthHandshakeTimeoutMs: 200,
      requestTimeoutMs: 500,
    });

    const initialConnectError = await transport.connect().catch((error: unknown) => error);
    expect(initialConnectError).toBeInstanceOf(Error);
    expect(String(initialConnectError)).toMatch(/ECONNREFUSED/);

    const gateway = await createFakeGateway(port);
    try {
      await expect(transport.connect()).resolves.toBeUndefined();
    } finally {
      await transport.close();
      await gateway.close();
    }
  });
});

describe("OpenClaw SDK real Gateway e2e", () => {
  installGatewayTestHooks({ scope: "test" });

  it("streams real Gateway agent events", async () => {
    const token = "sdk-real-gateway-token";
    const started = await startServer(token, { controlUiEnabled: false });
    const transport = new GatewayClientTransport({
      url: `ws://127.0.0.1:${started.port}`,
      token,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });
    const runId = "sdk-real-gateway-run";

    try {
      await oc.connect();

      registerAgentRunContext(runId, {
        sessionKey: "agent:main:dashboard:sdk-real-gateway",
        verboseLevel: "off",
      });

      const run = await oc.runs.get(runId);
      const eventsPromise = (async () => {
        const seen: string[] = [];
        const sessionKeys: Array<string | undefined> = [];
        for await (const event of run.events()) {
          seen.push(event.type);
          sessionKeys.push(event.sessionKey);
          if (event.type === "run.completed") {
            break;
          }
        }
        return { seen, sessionKeys };
      })();

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 111 },
      });
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { delta: "hello from real gateway" },
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end", endedAt: 222 },
      });

      const { seen, sessionKeys } = await withTimeout(
        eventsPromise,
        2_000,
        "timed out waiting for real Gateway SDK events",
      );
      expect(seen).toEqual(["run.started", "assistant.delta", "run.completed"]);
      expect(sessionKeys).toEqual([
        "agent:main:dashboard:sdk-real-gateway",
        "agent:main:dashboard:sdk-real-gateway",
        "agent:main:dashboard:sdk-real-gateway",
      ]);
    } finally {
      await oc.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});

const liveGatewayUrl = process.env.OPENCLAW_SDK_LIVE_GATEWAY_URL;
const liveGatewayToken = process.env.OPENCLAW_SDK_LIVE_GATEWAY_TOKEN;
const liveGatewayDescribe = liveGatewayUrl && liveGatewayToken ? describe : describe.skip;

function readLiveTextDelta(data: unknown): string {
  if (!data || typeof data !== "object") {
    return "";
  }
  const record = data as Record<string, unknown>;
  for (const key of ["delta", "text", "content"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

liveGatewayDescribe("OpenClaw SDK live Gateway e2e", () => {
  it("connects to a configured Gateway, streams a real run, and waits for completion", async () => {
    const oc = new OpenClaw({
      url: liveGatewayUrl,
      token: liveGatewayToken,
      requestTimeoutMs: 20_000,
    });

    try {
      await oc.connect();
      await expect(oc.agents.list()).resolves.toEqual(
        expect.objectContaining({ agents: expect.any(Array) }),
      );
      await expect(oc.models.status({ probe: false })).resolves.toEqual(
        expect.objectContaining({ providers: expect.any(Array) }),
      );

      const agent = await oc.agents.get(process.env.OPENCLAW_SDK_LIVE_AGENT_ID ?? "main");
      const run = await agent.run({
        input: "Reply with exactly: OPENCLAW_SDK_LIVE_OK",
        sessionKey: `sdk-live-e2e-${Date.now()}`,
        deliver: false,
        timeoutMs: 120_000,
        label: "SDK live E2E",
      });

      const eventsPromise = (async () => {
        const eventTypes: string[] = [];
        let text = "";
        for await (const event of run.events()) {
          eventTypes.push(event.type);
          if (event.type === "assistant.delta" || event.type === "assistant.message") {
            text += readLiveTextDelta(event.data);
          }
          if (
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.cancelled" ||
            event.type === "run.timed_out"
          ) {
            return { eventTypes, terminal: event.type, text };
          }
        }
        return { eventTypes, terminal: undefined, text };
      })();

      const result = await run.wait({ timeoutMs: 180_000 });
      const events = await withTimeout(
        eventsPromise,
        5_000,
        "timed out waiting for live SDK run events",
      );

      expect(result.status).toBe("completed");
      expect(events.terminal).toBe("run.completed");
      expect(events.eventTypes).toContain("run.started");
      expect(events.text).toContain("OPENCLAW_SDK_LIVE_OK");
    } finally {
      await oc.close();
    }
  }, 240_000);
});
