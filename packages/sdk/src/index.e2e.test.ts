// OpenClaw SDK tests cover index behavior.
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  installGatewayTestHooks,
  startServer,
  testState,
  writeSessionStore,
} from "../../../src/gateway/test-helpers.js";
import { emitAgentEvent } from "../../../src/infra/agent-events.js";
import { registerAgentRunContext } from "../../../src/infra/agent-run-registry.js";
import { rawDataToString } from "../../../src/infra/ws.js";
import { withTimeout } from "../../../src/utils/with-timeout.js";
import { GatewayClientTransport, OpenClaw, type OpenClawEvent } from "./index.js";

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

function expectJsonObject(value: unknown): JsonObject {
  expect(value && typeof value).toBe("object");
  return value as JsonObject;
}

function sendJson(socket: WebSocket, payload: JsonObject): void {
  socket.send(JSON.stringify(payload));
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function createFakeGateway(port = 0): Promise<FakeGateway> {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  let seq = 1;
  const requests: FakeGatewayRequest[] = [];
  server.on("connection", (socket) => {
    socket.binaryType = "nodebuffer";
    sendJson(socket, {
      type: "event",
      event: "connect.challenge",
      seq: seq++,
      payload: { nonce: "sdk-e2e-nonce", ts: Date.now() },
    });

    socket.on("message", (raw) => {
      const frame = JSON.parse(rawDataToString(raw)) as FakeGatewayRequest;
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
              "artifacts.download",
              "artifacts.get",
              "artifacts.list",
              "connect",
              "environments.create",
              "environments.destroy",
              "environments.list",
              "environments.status",
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
              "tasks.cancel",
              "tasks.get",
              "tasks.list",
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
              ts: 1_001,
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
              ts: 1_002,
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
              ts: 1_003,
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

      if (frame.method === "tasks.list") {
        reply({
          tasks: [
            {
              id: "task-sdk-e2e",
              status: "running",
              title: "SDK task",
              runId: "run-sdk-e2e",
              sessionKey: "sdk-session",
            },
          ],
        });
        return;
      }

      if (frame.method === "tasks.get") {
        reply({
          task: {
            id: (frame.params as { taskId?: string } | undefined)?.taskId ?? "task-sdk-e2e",
            status: "running",
            title: "SDK task",
          },
        });
        return;
      }

      if (frame.method === "tasks.cancel") {
        reply({
          found: true,
          cancelled: true,
          task: {
            id: (frame.params as { taskId?: string } | undefined)?.taskId ?? "task-sdk-e2e",
            status: "cancelled",
          },
        });
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

      if (frame.method === "artifacts.list") {
        reply({
          artifacts: [
            {
              id: "artifact-sdk-e2e",
              type: "file",
              title: "sdk-result.txt",
              download: { mode: "bytes", mimeType: "text/plain", sizeBytes: 5 },
            },
          ],
        });
        return;
      }

      if (frame.method === "artifacts.get") {
        reply({
          artifact: {
            id: "artifact-sdk-e2e",
            type: "file",
            title: "sdk-result.txt",
            download: { mode: "bytes", mimeType: "text/plain", sizeBytes: 5 },
          },
        });
        return;
      }

      if (frame.method === "artifacts.download") {
        reply({
          artifact: {
            id: "artifact-sdk-e2e",
            type: "file",
            title: "sdk-result.txt",
          },
          encoding: "base64",
          data: "aGVsbG8=",
        });
        return;
      }

      if (frame.method === "environments.list") {
        reply({
          environments: [{ id: "gateway", type: "local", status: "available" }],
        });
        return;
      }

      if (frame.method === "environments.create") {
        reply({
          id: "worker-sdk-e2e",
          type: "worker",
          status: "starting",
          worker: { providerId: "testbox", state: "requested" },
        });
        return;
      }

      if (frame.method === "environments.status") {
        reply({
          id: (frame.params as { environmentId?: string } | undefined)?.environmentId,
          type: "worker",
          status: "available",
          worker: { providerId: "testbox", state: "ready" },
        });
        return;
      }

      if (frame.method === "environments.destroy") {
        reply({
          id: (frame.params as { environmentId?: string } | undefined)?.environmentId,
          type: "worker",
          status: "unavailable",
          worker: { providerId: "testbox", state: "destroyed" },
        });
        return;
      }

      if (frame.method === "exec.approval.list") {
        reply({ approvals: [] });
        return;
      }

      if (frame.method === "exec.approval.resolve") {
        expect(frame.params).toMatchObject({ id: "approval-1", decision: "allow-once" });
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
      for (const socket of server.clients) {
        socket.terminate();
      }
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
      const collectUntilCompleted = async (
        events: AsyncIterable<OpenClawEvent>,
      ): Promise<OpenClawEvent[]> => {
        const seen: OpenClawEvent[] = [];
        for await (const event of events) {
          seen.push(event);
          if (event.type === "run.completed") {
            break;
          }
        }
        return seen;
      };
      const [appEvents, runEvents, result] = await Promise.all([
        withTimeout(collectUntilCompleted(oc.events()), 2_000, {
          message: "timed out waiting for app-wide SDK events",
        }),
        withTimeout(collectUntilCompleted(run.events()), 2_000, {
          message: "timed out waiting for per-run SDK events",
        }),
        run.wait({ timeoutMs: 2_000 }),
      ]);
      const expectedEvents: OpenClawEvent[] = [
        {
          version: 1,
          id: "2:agent:run-sdk-e2e:main:1001",
          ts: 1_001,
          type: "run.started",
          runId: "run-sdk-e2e",
          sessionKey: "main",
          data: { phase: "start" },
          raw: {
            event: "agent",
            seq: 2,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: "main",
              stream: "lifecycle",
              ts: 1_001,
              data: { phase: "start" },
            },
          },
        },
        {
          version: 1,
          id: "3:agent:run-sdk-e2e:main:1002",
          ts: 1_002,
          type: "assistant.delta",
          runId: "run-sdk-e2e",
          sessionKey: "main",
          data: { delta: "hello from fake gateway" },
          raw: {
            event: "agent",
            seq: 3,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: "main",
              stream: "assistant",
              ts: 1_002,
              data: { delta: "hello from fake gateway" },
            },
          },
        },
        {
          version: 1,
          id: "4:agent:run-sdk-e2e:main:1003",
          ts: 1_003,
          type: "run.completed",
          runId: "run-sdk-e2e",
          sessionKey: "main",
          data: { phase: "end" },
          raw: {
            event: "agent",
            seq: 4,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: "main",
              stream: "lifecycle",
              ts: 1_003,
              data: { phase: "end" },
            },
          },
        },
      ];

      expect(run.id).toBe("run-sdk-e2e");
      expect(appEvents).toEqual(expectedEvents);
      expect(runEvents).toEqual(expectedEvents);
      expect(result.runId).toBe("run-sdk-e2e");
      expect(result.sessionKey).toBe("main");
      expect(result.status).toBe("completed");
      expect(result.startedAt).toBe(123);
      expect(result.endedAt).toBe(456);
      const cancelResult = expectJsonObject(await run.cancel());
      expect(cancelResult.abortedRunId).toBe("run-sdk-e2e");
      expect(cancelResult.status).toBe("aborted");
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
      const agents = expectJsonObject(await oc.agents.list());
      expect(agents.agents).toEqual([{ id: "main" }]);
      const agent = await oc.agents.get("main");
      const identity = expectJsonObject(await agent.identity({ sessionKey: "sdk-session" }));
      expect(identity.agentId).toBe("main");
      expect(identity.sessionKey).toBe("sdk-session");
      const createAgent = expectJsonObject(
        await oc.agents.create({ name: "SDK Agent", workspace: "/tmp/sdk-agent" }),
      );
      expect(createAgent.method).toBe("agents.create");
      expect(createAgent.params).toEqual({ name: "SDK Agent", workspace: "/tmp/sdk-agent" });
      const updateAgent = expectJsonObject(
        await oc.agents.update({ agentId: "sdk-agent", name: "Renamed SDK Agent" }),
      );
      expect(updateAgent.method).toBe("agents.update");
      expect(updateAgent.params).toEqual({ agentId: "sdk-agent", name: "Renamed SDK Agent" });
      const clearAgentModel = expectJsonObject(
        await oc.agents.update({ agentId: "sdk-agent", model: null }),
      );
      expect(clearAgentModel.params).toEqual({ agentId: "sdk-agent", model: null });
      const deleteAgent = expectJsonObject(await oc.agents.delete({ agentId: "sdk-agent" }));
      expect(deleteAgent.method).toBe("agents.delete");
      expect(deleteAgent.params).toEqual({ agentId: "sdk-agent" });

      const sessions = expectJsonObject(await oc.sessions.list());
      expect(sessions.sessions).toEqual([{ key: "sdk-session" }]);
      const session = await oc.sessions.create({ key: "sdk-session", agentId: "main" });
      expect(session.key).toBe("sdk-session");
      const resolvedSession = expectJsonObject(await oc.sessions.resolve({ key: "sdk-session" }));
      expect(resolvedSession.key).toBe("sdk-session");
      const sessionRun = await session.send("continue");
      expect(sessionRun.id).toBe("run-session-e2e");
      const abortSession = expectJsonObject(await session.abort(sessionRun.id));
      expect(abortSession.abortedRunId).toBe("run-session-e2e");
      const patchSession = expectJsonObject(await session.patch({ label: "Renamed" }));
      expect(patchSession.method).toBe("sessions.patch");
      const compactSession = expectJsonObject(await session.compact({ maxLines: 200 }));
      expect(compactSession.method).toBe("sessions.compact");

      const tasks = await oc.tasks.list({ status: "running" });
      expect(tasks.tasks).toEqual([
        {
          id: "task-sdk-e2e",
          status: "running",
          title: "SDK task",
          runId: "run-sdk-e2e",
          sessionKey: "sdk-session",
        },
      ]);
      const task = await oc.tasks.get("task-sdk-e2e");
      expect(task.task).toEqual({
        id: "task-sdk-e2e",
        status: "running",
        title: "SDK task",
      });
      const cancelledTask = await oc.tasks.cancel("task-sdk-e2e");
      expect(cancelledTask.cancelled).toBe(true);

      const models = expectJsonObject(await oc.models.list());
      expect(models.models).toEqual([{ id: "gpt-5.4" }]);
      const modelStatus = expectJsonObject(await oc.models.status({ probe: false }));
      expect(modelStatus.providers).toEqual([]);
      const tools = expectJsonObject(await oc.tools.list());
      expect(tools.tools).toEqual([{ name: "shell" }]);
      const effectiveTools = expectJsonObject(
        await oc.tools.effective({ sessionKey: "sdk-session" }),
      );
      expect(effectiveTools.tools).toEqual([{ name: "shell", enabled: true }]);
      const toolResult = await oc.tools.invoke("shell", {
        args: { command: "pwd" },
        sessionKey: "sdk-session",
      });
      expect(toolResult.ok).toBe(true);
      expect(toolResult.toolName).toBe("shell");
      expect(toolResult.output).toEqual({ ok: true });

      const artifacts = await oc.artifacts.list({ runId: "run-sdk-e2e" });
      expect(artifacts.artifacts).toHaveLength(1);
      const artifact = artifacts.artifacts[0];
      expect(artifact?.id).toBe("artifact-sdk-e2e");
      const artifactDetails = await oc.artifacts.get(artifact?.id ?? "", {
        runId: "run-sdk-e2e",
      });
      expect(artifactDetails.artifact.title).toBe("sdk-result.txt");
      const artifactDownload = await oc.artifacts.download(artifact?.id ?? "", {
        runId: "run-sdk-e2e",
      });
      expect(artifactDownload).toMatchObject({
        encoding: "base64",
        data: "aGVsbG8=",
      });

      const environments = await oc.environments.list();
      expect(environments.environments).toEqual([
        { id: "gateway", type: "local", status: "available" },
      ]);
      const createdEnvironment = await oc.environments.create({
        profileId: "development",
        idempotencyKey: "sdk-environment-create",
      });
      expect(createdEnvironment).toMatchObject({
        id: "worker-sdk-e2e",
        type: "worker",
        status: "starting",
      });
      await expect(oc.environments.status("worker-sdk-e2e")).resolves.toMatchObject({
        id: "worker-sdk-e2e",
        status: "available",
      });
      await expect(oc.environments.destroy("worker-sdk-e2e")).resolves.toMatchObject({
        id: "worker-sdk-e2e",
        status: "unavailable",
      });

      const approvals = expectJsonObject(await oc.approvals.list());
      expect(approvals.approvals).toEqual([]);
      const approvalResult = expectJsonObject(
        await oc.approvals.respond("approval-1", { decision: "allow-once" }),
      );
      expect(approvalResult.ok).toBe(true);

      expect(gateway.requests.map((request) => request.method)).toEqual([
        "connect",
        "agents.list",
        "agent.identity.get",
        "agents.create",
        "agents.update",
        "agents.update",
        "agents.delete",
        "sessions.list",
        "sessions.create",
        "sessions.resolve",
        "sessions.send",
        "sessions.abort",
        "sessions.patch",
        "sessions.compact",
        "tasks.list",
        "tasks.get",
        "tasks.cancel",
        "models.list",
        "models.authStatus",
        "tools.catalog",
        "tools.effective",
        "tools.invoke",
        "artifacts.list",
        "artifacts.get",
        "artifacts.download",
        "environments.list",
        "environments.create",
        "environments.status",
        "environments.destroy",
        "exec.approval.list",
        "exec.approval.resolve",
      ]);
      const requestParams = new Map(
        gateway.requests.map((request) => [request.method, request.params]),
      );
      expect(requestParams.get("agents.list")).toEqual({});
      expect(requestParams.get("sessions.list")).toEqual({});
      expect(requestParams.get("models.list")).toEqual({});
      expect(requestParams.get("tools.catalog")).toEqual({});
      expect(requestParams.get("artifacts.list")).toEqual({ runId: "run-sdk-e2e" });
      expect(requestParams.get("artifacts.get")).toEqual({
        artifactId: "artifact-sdk-e2e",
        runId: "run-sdk-e2e",
      });
      expect(requestParams.get("artifacts.download")).toEqual({
        artifactId: "artifact-sdk-e2e",
        runId: "run-sdk-e2e",
      });
      expect(requestParams.get("environments.list")).toEqual({});
      expect(requestParams.get("environments.create")).toEqual({
        profileId: "development",
        idempotencyKey: "sdk-environment-create",
      });
      expect(requestParams.get("environments.status")).toEqual({
        environmentId: "worker-sdk-e2e",
      });
      expect(requestParams.get("environments.destroy")).toEqual({
        environmentId: "worker-sdk-e2e",
      });
      expect(requestParams.get("exec.approval.list")).toEqual({});
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

  it("validates run results and resource RPCs against a real Gateway", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-gateway-"));
    const sessionKey = "agent:main:sdk-real-gateway";
    const sessionId = "sdk-real-gateway-session";
    const transcriptPath = path.join(tempDir, `${sessionId}.jsonl`);
    const previousSessionStorePath = testState.sessionStorePath;
    let started: Awaited<ReturnType<typeof startServer>> | undefined;
    let oc: OpenClaw | undefined;
    testState.sessionStorePath = path.join(tempDir, "sessions.json");

    try {
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: "sdk-artifact-message",
          parentId: null,
          timestamp: "2026-08-03T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "file",
                data: "aGVsbG8=",
                mimeType: "text/plain",
                title: "sdk-result.txt",
              },
            ],
            __openclaw: { seq: 2, runId: "sdk-artifact-run" },
          },
        })}\n`,
      );
      await writeSessionStore({
        entries: {
          [sessionKey]: {
            sessionId,
            sessionFile: transcriptPath,
            updatedAt: Date.now(),
          },
        },
      });

      const token = "sdk-real-gateway-token";
      started = await startServer(token, { controlUiEnabled: false });
      const transport = new GatewayClientTransport({
        url: `ws://127.0.0.1:${started.port}`,
        token,
        deviceIdentity: null,
        requestTimeoutMs: 2_000,
      });
      oc = new OpenClaw({ transport });
      const runId = "sdk-real-gateway-run";
      await oc.connect();

      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: "off",
      });

      const run = await oc.runs.get(runId);
      await expect(run.wait({ timeoutMs: 0 })).resolves.toMatchObject({
        runId,
        status: "accepted",
      });
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

      const { seen, sessionKeys } = await withTimeout(eventsPromise, 2_000, {
        message: "timed out waiting for real Gateway SDK events",
      });
      expect(seen).toEqual(["run.started", "assistant.delta", "run.completed"]);
      expect(sessionKeys).toEqual([sessionKey, sessionKey, sessionKey]);
      await expect(run.wait({ timeoutMs: 2_000 })).resolves.toMatchObject({
        runId,
        status: "completed",
        startedAt: 111,
        endedAt: 222,
      });

      const timeoutRunId = "sdk-real-gateway-timeout";
      registerAgentRunContext(timeoutRunId, {
        sessionKey,
        verboseLevel: "off",
      });
      emitAgentEvent({
        runId: timeoutRunId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 333 },
      });
      emitAgentEvent({
        runId: timeoutRunId,
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt: 333,
          endedAt: 444,
          aborted: true,
          stopReason: "timeout",
          timeoutPhase: "provider",
          providerStarted: true,
          error: "provider timed out",
          fallbackExhaustedFailure: true,
        },
      });
      await expect(oc.runs.wait(timeoutRunId, { timeoutMs: 2_000 })).resolves.toMatchObject({
        runId: timeoutRunId,
        status: "timed_out",
        startedAt: 333,
        endedAt: 444,
        error: { message: "provider timed out" },
      });

      const artifacts = await oc.artifacts.list({ sessionKey });
      expect(artifacts.artifacts).toHaveLength(1);
      const artifactId = artifacts.artifacts[0]?.id;
      expect(artifactId).toEqual(expect.any(String));
      await expect(oc.artifacts.get(artifactId ?? "", { sessionKey })).resolves.toMatchObject({
        artifact: {
          id: artifactId,
          type: "file",
          title: "sdk-result.txt",
          mimeType: "text/plain",
        },
      });
      await expect(oc.artifacts.download(artifactId ?? "", { sessionKey })).resolves.toMatchObject({
        artifact: { id: artifactId },
        encoding: "base64",
        data: "aGVsbG8=",
      });

      const environments = await oc.environments.list();
      expect(environments.environments).toContainEqual({
        id: "gateway",
        type: "local",
        label: "Gateway local",
        status: "available",
        capabilities: ["agent.run", "sessions", "tools", "workspace"],
      });
      await expect(oc.environments.status("gateway")).resolves.toMatchObject({
        id: "gateway",
        type: "local",
        status: "available",
      });
      await expect(
        oc.environments.create({
          profileId: "development",
          idempotencyKey: "sdk-real-environment-create",
        }),
      ).rejects.toThrow("cloud worker environments are not configured");
      await expect(oc.environments.destroy("worker-sdk-missing")).rejects.toThrow(
        "unknown environmentId",
      );
    } finally {
      await oc?.close();
      await started?.server.close();
      started?.envSnapshot.restore();
      testState.sessionStorePath = previousSessionStorePath;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
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

function expectArrayProperty(value: unknown, property: string): void {
  expect(value && typeof value).toBe("object");
  const record = value as Record<string, unknown>;
  expect(Array.isArray(record[property])).toBe(true);
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
      expectArrayProperty(await oc.agents.list(), "agents");
      expectArrayProperty(await oc.models.status({ probe: false }), "providers");

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
      const events = await withTimeout(eventsPromise, 5_000, {
        message: "timed out waiting for live SDK run events",
      });

      expect(result.status).toBe("completed");
      expect(events.terminal).toBe("run.completed");
      expect(events.eventTypes).toContain("run.started");
      expect(events.text).toContain("OPENCLAW_SDK_LIVE_OK");
    } finally {
      await oc.close();
    }
  }, 240_000);
});
