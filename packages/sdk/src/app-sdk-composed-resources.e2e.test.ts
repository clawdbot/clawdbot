// Scenario-owned proof for composed preview App SDK Gateway contracts.
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AgentParamsSchema,
  ArtifactsDownloadParamsSchema,
  ArtifactsGetParamsSchema,
  ArtifactsListParamsSchema,
  EnvironmentsCreateParamsSchema,
  EnvironmentsCreateResultSchema,
  EnvironmentsDestroyParamsSchema,
  EnvironmentsDestroyResultSchema,
  EnvironmentsListParamsSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusParamsSchema,
  EnvironmentsStatusResultSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentWaitParamsSchema } from "../../../packages/gateway-protocol/src/schema/agent.js";
import {
  ArtifactsDownloadResultSchema,
  ArtifactsGetResultSchema,
  ArtifactsListResultSchema,
} from "../../../packages/gateway-protocol/src/schema/artifacts.js";
import { environmentsHandlers } from "../../../src/gateway/server-methods/environments.js";
import type {
  GatewayRequestHandlerOptions,
  RespondFn,
} from "../../../src/gateway/server-methods/types.js";
import {
  installGatewayTestHooks,
  startServer,
  testState,
  writeSessionStore,
} from "../../../src/gateway/test-helpers.js";
import type { WorkerEnvironmentServiceRecord } from "../../../src/gateway/worker-environments/service-contract.js";
import { emitAgentEvent } from "../../../src/infra/agent-events.js";
import { registerAgentRunContext } from "../../../src/infra/agent-run-registry.js";
import { withTimeout } from "../../../src/utils/with-timeout.js";
import { GatewayClientTransport, OpenClaw, type OpenClawEvent } from "./index.js";

vi.mock("../../../src/infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/infra/device-pairing.js")>();
  return {
    ...actual,
    listDevicePairing: vi.fn(async () => ({ pending: [], paired: [] })),
    resolveNodePairingState: vi.fn(),
  };
});

vi.mock("../../../src/infra/device-pairing-node.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/infra/device-pairing-node.js")>();
  return {
    ...actual,
    listNodePairing: vi.fn(async () => ({ pending: [], paired: [] })),
  };
});

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

const fakeServers: WebSocketServer[] = [];

function sendJson(socket: WebSocket, payload: JsonObject): void {
  socket.send(JSON.stringify(payload));
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function assertSchema(schema: TSchema, value: unknown, label: string): void {
  if (!Value.Check(schema, value)) {
    throw new Error(`${label} failed Gateway schema validation`);
  }
}

async function closeFakeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function workerRecord(state: "requested" | "ready" | "destroyed"): WorkerEnvironmentServiceRecord {
  return {
    environmentId: "worker-sdk-e2e",
    providerId: "testbox",
    profileId: "development",
    leaseId: "lease-sdk-e2e",
    sharedHost: null,
    state,
    ownerEpoch: 1,
    createdAtMs: 1_000,
    idleSinceAtMs: null,
    attachedSessionIds: ["session-sdk-e2e"],
    desktopAvailable: false,
    desktopApps: [],
    tunnelStatus: "stopped",
  };
}

async function createFakeGateway(): Promise<FakeGateway> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  fakeServers.push(server);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const requests: FakeGatewayRequest[] = [];
  let seq = 1;
  let worker = workerRecord("ready");
  const workerEnvironmentService = {
    list: () => [worker],
    get: (environmentId: string) => (environmentId === worker.environmentId ? worker : undefined),
    create: async (_profileId: string, _idempotencyKey: string) => {
      const requested = workerRecord("requested");
      worker = workerRecord("ready");
      return requested;
    },
    destroy: async (_environmentId: string) => {
      worker = workerRecord("destroyed");
      return worker;
    },
    destroyUnattached: async (_environmentId: string) => {
      worker = workerRecord("destroyed");
      return worker;
    },
    startTunnel: async () => {
      throw new Error("tunnel start is outside the SDK environment RPC proof");
    },
    stopTunnel: async () => {},
  };
  const environmentContext = {
    logGateway: { warn: vi.fn() },
    nodeRegistry: { listConnectedForPairingStates: () => [] },
    workerEnvironmentService,
    workerPlacementDispatchService: {
      dispatch: async () => {
        throw new Error("placement dispatch is outside the SDK environment RPC proof");
      },
      reconcileActive: vi.fn(async () => {}),
    },
    getRuntimeConfig: () => ({
      cloudWorkers: {
        profiles: {
          development: { provider: "testbox", settings: {} },
        },
      },
    }),
  } as unknown as GatewayRequestHandlerOptions["context"];
  const environmentSchemas = {
    "environments.list": {
      params: EnvironmentsListParamsSchema,
      result: EnvironmentsListResultSchema,
    },
    "environments.create": {
      params: EnvironmentsCreateParamsSchema,
      result: EnvironmentsCreateResultSchema,
    },
    "environments.status": {
      params: EnvironmentsStatusParamsSchema,
      result: EnvironmentsStatusResultSchema,
    },
    "environments.destroy": {
      params: EnvironmentsDestroyParamsSchema,
      result: EnvironmentsDestroyResultSchema,
    },
  } as const;

  server.on("connection", (socket) => {
    socket.binaryType = "nodebuffer";
    sendJson(socket, {
      type: "event",
      event: "connect.challenge",
      seq: seq++,
      payload: { nonce: "sdk-a2-nonce", ts: 1_000 },
    });

    socket.on("message", (raw) => {
      void (async () => {
        const frame = JSON.parse(rawDataToString(raw)) as FakeGatewayRequest;
        requests.push(frame);
        const reply = (payload: unknown): void => {
          sendJson(socket, { type: "res", id: frame.id, ok: true, payload });
        };

        if (frame.method === "connect") {
          reply({
            type: "hello-ok",
            protocol: 1,
            server: { version: "sdk-a2", connId: "conn-sdk-a2" },
            features: {
              methods: [
                "agent",
                "agent.wait",
                "artifacts.download",
                "artifacts.get",
                "artifacts.list",
                "connect",
                "environments.create",
                "environments.destroy",
                "environments.list",
                "environments.status",
              ],
              events: ["agent"],
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

        if (frame.method === "agent") {
          const params = frame.params ?? {};
          assertSchema(AgentParamsSchema, params, "agent params");
          reply({
            status: "accepted",
            runId: "run-sdk-e2e",
            sessionKey: "main",
          });
          setTimeout(() => {
            const payloads = [
              {
                stream: "lifecycle",
                ts: 1_001,
                data: { phase: "start" },
              },
              {
                stream: "assistant",
                ts: 1_002,
                data: { delta: "hello from fake gateway" },
              },
              {
                stream: "lifecycle",
                ts: 1_003,
                data: { phase: "end" },
              },
            ];
            for (const payload of payloads) {
              sendJson(socket, {
                type: "event",
                event: "agent",
                seq: seq++,
                stateVersion: { presence: 7, health: 9 },
                payload: {
                  runId: "run-sdk-e2e",
                  sessionId: "session-sdk-e2e",
                  sessionKey: "main",
                  taskId: "task-sdk-e2e",
                  agentId: "main",
                  ...payload,
                },
              });
            }
          }, 50);
          return;
        }

        if (frame.method === "agent.wait") {
          assertSchema(AgentWaitParamsSchema, frame.params ?? {}, "agent.wait params");
          reply({
            status: "ok",
            runId: "run-sdk-e2e",
            sessionKey: "main",
            startedAt: 123,
            endedAt: 456,
          });
          return;
        }

        const artifact = {
          id: "artifact-sdk-e2e",
          type: "file",
          title: "sdk-result.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          runId: "run-sdk-e2e",
          download: { mode: "bytes" as const },
        };
        if (frame.method === "artifacts.list") {
          const params = frame.params ?? {};
          const result = { artifacts: [artifact] };
          assertSchema(ArtifactsListParamsSchema, params, "artifacts.list params");
          assertSchema(ArtifactsListResultSchema, result, "artifacts.list result");
          reply(result);
          return;
        }
        if (frame.method === "artifacts.get") {
          const params = frame.params ?? {};
          const result = { artifact };
          assertSchema(ArtifactsGetParamsSchema, params, "artifacts.get params");
          assertSchema(ArtifactsGetResultSchema, result, "artifacts.get result");
          reply(result);
          return;
        }
        if (frame.method === "artifacts.download") {
          const params = frame.params ?? {};
          const result = { artifact, encoding: "base64" as const, data: "aGVsbG8=" };
          assertSchema(ArtifactsDownloadParamsSchema, params, "artifacts.download params");
          assertSchema(ArtifactsDownloadResultSchema, result, "artifacts.download result");
          reply(result);
          return;
        }

        if (frame.method in environmentSchemas) {
          const method = frame.method as keyof typeof environmentSchemas;
          const schemas = environmentSchemas[method];
          const params = requireJsonObject(frame.params ?? {}, `${method} params`);
          assertSchema(schemas.params, params, `${method} params`);
          const handler = environmentsHandlers[method];
          if (!handler) {
            throw new Error(`missing Gateway handler for ${method}`);
          }
          const respond: RespondFn = (ok, payload, error) => {
            if (!ok) {
              sendJson(socket, { type: "res", id: frame.id, ok: false, error });
              return;
            }
            assertSchema(schemas.result, payload, `${method} result`);
            reply(payload);
          };
          await handler({
            req: { type: "req", id: frame.id, method, params },
            params,
            client: null,
            isWebchatConnect: () => false,
            respond,
            context: environmentContext,
          });
          return;
        }

        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNKNOWN_METHOD", message: `unhandled method ${frame.method}` },
        });
      })().catch((error: unknown) => {
        const frame = JSON.parse(rawDataToString(raw)) as FakeGatewayRequest;
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "TEST_ASSERTION_FAILED",
            message: `${frame.method}: ${String(error)}`,
          },
        });
      });
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      const index = fakeServers.indexOf(server);
      if (index >= 0) {
        fakeServers.splice(index, 1);
      }
      await closeFakeServer(server);
    },
  };
}

async function collectUntilCompleted(events: AsyncIterable<OpenClawEvent>) {
  const collected: OpenClawEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.type === "run.completed") {
      break;
    }
  }
  return collected;
}

async function proveDeterministicGatewayContracts(): Promise<void> {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const gateway = await createFakeGateway();
  const oc = new OpenClaw({
    transport: new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    }),
  });
  try {
    const agent = await oc.agents.get("main");
    const run = await agent.run({
      input: "say hello",
      sessionKey: "main",
      idempotencyKey: "sdk-a2-run",
    });
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
        sessionId: "session-sdk-e2e",
        sessionKey: "main",
        taskId: "task-sdk-e2e",
        agentId: "main",
        data: { phase: "start" },
        raw: {
          event: "agent",
          seq: 2,
          stateVersion: { presence: 7, health: 9 },
          payload: {
            runId: "run-sdk-e2e",
            sessionId: "session-sdk-e2e",
            sessionKey: "main",
            taskId: "task-sdk-e2e",
            agentId: "main",
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
        sessionId: "session-sdk-e2e",
        sessionKey: "main",
        taskId: "task-sdk-e2e",
        agentId: "main",
        data: { delta: "hello from fake gateway" },
        raw: {
          event: "agent",
          seq: 3,
          stateVersion: { presence: 7, health: 9 },
          payload: {
            runId: "run-sdk-e2e",
            sessionId: "session-sdk-e2e",
            sessionKey: "main",
            taskId: "task-sdk-e2e",
            agentId: "main",
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
        sessionId: "session-sdk-e2e",
        sessionKey: "main",
        taskId: "task-sdk-e2e",
        agentId: "main",
        data: { phase: "end" },
        raw: {
          event: "agent",
          seq: 4,
          stateVersion: { presence: 7, health: 9 },
          payload: {
            runId: "run-sdk-e2e",
            sessionId: "session-sdk-e2e",
            sessionKey: "main",
            taskId: "task-sdk-e2e",
            agentId: "main",
            stream: "lifecycle",
            ts: 1_003,
            data: { phase: "end" },
          },
        },
      },
    ];
    expect(appEvents).toEqual(expectedEvents);
    expect(runEvents).toEqual(expectedEvents);
    expect(result).toMatchObject({
      runId: "run-sdk-e2e",
      sessionKey: "main",
      status: "completed",
      startedAt: 123,
      endedAt: 456,
    });

    const artifacts = await oc.artifacts.list({ runId: "run-sdk-e2e" });
    expect(artifacts.artifacts).toHaveLength(1);
    const artifact = artifacts.artifacts[0];
    await expect(oc.artifacts.get(artifact?.id ?? "", { runId: "run-sdk-e2e" })).resolves.toEqual({
      artifact,
    });
    await expect(
      oc.artifacts.download(artifact?.id ?? "", { runId: "run-sdk-e2e" }),
    ).resolves.toEqual({ artifact, encoding: "base64", data: "aGVsbG8=" });

    const created = await oc.environments.create({
      profileId: "development",
      idempotencyKey: "sdk-environment-create",
    });
    expect(created).toMatchObject({
      id: "worker-sdk-e2e",
      status: "starting",
      worker: {
        providerId: "testbox",
        leaseId: "lease-sdk-e2e",
        state: "requested",
        ageMs: 9_000,
        attachedSessionIds: ["session-sdk-e2e"],
        tunnelStatus: "stopped",
      },
    });
    const environments = await oc.environments.list();
    expect(environments.profiles).toEqual([{ id: "development", providerId: "testbox" }]);
    expect(environments.environments).toContainEqual({
      id: "worker-sdk-e2e",
      type: "worker",
      status: "available",
      worker: {
        providerId: "testbox",
        leaseId: "lease-sdk-e2e",
        state: "ready",
        ageMs: 9_000,
        attachedSessionIds: ["session-sdk-e2e"],
        tunnelStatus: "stopped",
      },
    });
    await expect(oc.environments.status("worker-sdk-e2e")).resolves.toMatchObject({
      id: "worker-sdk-e2e",
      status: "available",
      worker: { state: "ready", ageMs: 9_000 },
    });
    await expect(oc.environments.destroy("worker-sdk-e2e")).resolves.toMatchObject({
      id: "worker-sdk-e2e",
      status: "unavailable",
      worker: { state: "destroyed", ageMs: 9_000 },
    });

    const requestParams = new Map(
      gateway.requests.map((request) => [request.method, request.params]),
    );
    expect(requestParams.get("artifacts.list")).toEqual({ runId: "run-sdk-e2e" });
    expect(requestParams.get("artifacts.get")).toEqual({
      artifactId: "artifact-sdk-e2e",
      runId: "run-sdk-e2e",
    });
    expect(requestParams.get("artifacts.download")).toEqual({
      artifactId: "artifact-sdk-e2e",
      runId: "run-sdk-e2e",
    });
    expect(requestParams.get("environments.create")).toEqual({
      profileId: "development",
      idempotencyKey: "sdk-environment-create",
    });
    expect(requestParams.get("environments.list")).toEqual({});
    expect(requestParams.get("environments.status")).toEqual({
      environmentId: "worker-sdk-e2e",
    });
    expect(requestParams.get("environments.destroy")).toEqual({
      environmentId: "worker-sdk-e2e",
    });
  } finally {
    await oc.close();
    await gateway.close();
    dateNow.mockRestore();
  }
}

async function proveRealGatewayContracts(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-a2-gateway-"));
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
    oc = new OpenClaw({
      transport: new GatewayClientTransport({
        url: `ws://127.0.0.1:${started.port}`,
        token,
        deviceIdentity: null,
        requestTimeoutMs: 2_000,
      }),
    });
    await oc.connect();

    const runId = "sdk-real-gateway-run";
    registerAgentRunContext(runId, { sessionKey, verboseLevel: "off" });
    const run = await oc.runs.get(runId);
    await expect(run.wait({ timeoutMs: 0 })).resolves.toMatchObject({
      runId,
      status: "accepted",
    });
    const eventsPromise = collectUntilCompleted(run.events());
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
    const realEvents = await withTimeout(eventsPromise, 2_000, {
      message: "timed out waiting for real Gateway SDK events",
    });
    expect(realEvents.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.delta",
      "run.completed",
    ]);
    expect(realEvents.map((event) => event.sessionKey)).toEqual([
      sessionKey,
      sessionKey,
      sessionKey,
    ]);
    await expect(run.wait({ timeoutMs: 2_000 })).resolves.toMatchObject({
      runId,
      status: "completed",
      startedAt: 111,
      endedAt: 222,
    });

    const timeoutRunId = "sdk-real-gateway-timeout";
    registerAgentRunContext(timeoutRunId, { sessionKey, verboseLevel: "off" });
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
    assertSchema(ArtifactsListResultSchema, artifacts, "real artifacts.list result");
    expect(artifacts.artifacts).toHaveLength(1);
    const artifactId = artifacts.artifacts[0]?.id ?? "";
    const artifact = await oc.artifacts.get(artifactId, { sessionKey });
    assertSchema(ArtifactsGetResultSchema, artifact, "real artifacts.get result");
    expect(artifact.artifact).toMatchObject({
      id: artifactId,
      type: "file",
      title: "sdk-result.txt",
      mimeType: "text/plain",
    });
    const download = await oc.artifacts.download(artifactId, { sessionKey });
    assertSchema(ArtifactsDownloadResultSchema, download, "real artifacts.download result");
    expect(download).toMatchObject({
      artifact: { id: artifactId },
      encoding: "base64",
      data: "aGVsbG8=",
    });

    const environments = await oc.environments.list();
    assertSchema(EnvironmentsListResultSchema, environments, "real environments.list result");
    expect(environments.environments).toContainEqual({
      id: "gateway",
      type: "local",
      label: "Gateway local",
      status: "available",
      platform: process.platform,
      sessionHost: true,
      trust: "persistent",
      capabilities: ["agent.run", "sessions", "tools", "workspace"],
    });
    const gatewayEnvironment = await oc.environments.status("gateway");
    assertSchema(
      EnvironmentsStatusResultSchema,
      gatewayEnvironment,
      "real environments.status result",
    );
    expect(gatewayEnvironment).toMatchObject({
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
}

describe("composed preview App SDK Gateway contracts", () => {
  installGatewayTestHooks({ scope: "test" });

  afterEach(async () => {
    await Promise.all(fakeServers.splice(0).map(closeFakeServer));
  });

  it("proves event, run, artifact, environment, and schema contracts", async () => {
    await proveDeterministicGatewayContracts();
    await proveRealGatewayContracts();
  }, 30_000);
});
