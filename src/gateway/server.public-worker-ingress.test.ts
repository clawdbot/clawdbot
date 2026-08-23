import http from "node:http";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  PROTOCOL_VERSION,
  type WorkerConnectParams,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/index.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { attachGatewayWsConnectionHandler } from "./server/ws-connection.js";
import { createGatewayWsTestLogger } from "./server/ws-connection.test-helpers.js";
import type { WorkerConnectionService } from "./server/ws-connection/worker-connection.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { withTempConfig } from "./test-temp-config.js";
import {
  admitWorkerConnection,
  validateWorkerConnectionIdentity,
} from "./worker-environments/admission.js";
import {
  createWorkerCredentialMaterial,
  hashWorkerCredential,
  type WorkerCredentialRecord,
} from "./worker-environments/credential.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
} from "./worker-environments/store.js";

const BUILD = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.12",
  protocolFeatures: ["worker-heartbeat-v1"],
} as const;
const WORKER_GATEWAY_PATH = "/__openclaw__/worker";
const RESOLVED_AUTH: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
const activeHarnesses: PublicWorkerHarness[] = [];

type RejectedWorker = {
  response: unknown;
  close: { code: number; reason: string };
};

function workerConnect(
  credential: string,
  overrides: Partial<WorkerConnectParams["admission"]> = {},
): WorkerConnectParams {
  return {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: GATEWAY_CLIENT_IDS.WORKER,
      version: BUILD.openclawVersion,
      platform: "linux",
      mode: GATEWAY_CLIENT_MODES.WORKER,
    },
    role: "worker",
    admission: {
      environmentId: "worker-public",
      credential,
      sessionId: null,
      runId: null,
      ownerEpoch: 1,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: BUILD,
      ...overrides,
    } as WorkerConnectParams["admission"],
  };
}

function connectFrame(params: WorkerConnectParams) {
  return { type: "req", id: "connect-1", method: "connect", params };
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function rejectWorker(url: string, params: unknown): Promise<RejectedWorker> {
  const ws = new WebSocket(url);
  await waitForOpen(ws);
  return await rejectOpenedWorker(ws, params);
}

async function rejectOpenedWorker(ws: WebSocket, params: unknown): Promise<RejectedWorker> {
  const response = new Promise<unknown>((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(rawDataToString(data))));
  });
  const close = waitForClose(ws);
  ws.send(JSON.stringify(connectFrame(params as WorkerConnectParams)));
  return { response: await response, close: await close };
}

async function requestUpgradeRejection(
  port: number,
  pathname: string,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGVzdC1rZXktMDEyMzQ1Ng==",
        "Sec-WebSocket-Version": "13",
      },
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected websocket upgrade rejection"));
    });
    req.once("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

class PublicWorkerHarness {
  readonly credential = createWorkerCredentialMaterial().credential;
  readonly environment: WorkerEnvironmentRecord;
  readonly credentialRecord: WorkerCredentialRecord;
  readonly store: WorkerEnvironmentStore;
  readonly workerService: WorkerConnectionService;
  readonly clients = new Set<GatewayWsClient>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  readonly preauthBudget: ReturnType<typeof createPreauthConnectionBudget>;
  readonly publicRateLimiter: ReturnType<typeof createAuthRateLimiter>;
  readonly logWsControl = createGatewayWsTestLogger();
  readonly handlePluginUpgrade = vi.fn(async () => false);
  readonly httpServer: ReturnType<typeof createGatewayHttpServer>;
  readonly admitWorker: ReturnType<typeof vi.fn<WorkerConnectionService["admitWorker"]>>;
  port = 0;

  constructor(options: { preauthLimit?: number; rateLimitMaxAttempts?: number } = {}) {
    const nowMs = Date.now();
    this.environment = {
      environmentId: "worker-public",
      state: "ready",
      ownerEpoch: 1,
      destroyRequestedAtMs: null,
      bootstrapReceipt: BUILD,
    } as unknown as WorkerEnvironmentRecord;
    this.credentialRecord = {
      environmentId: this.environment.environmentId,
      credentialHash: hashWorkerCredential(this.credential),
      bundleHash: BUILD.bundleHash,
      sessionId: null,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      ownerEpoch: 1,
      expiresAtMs: nowMs + 60_000,
      deliveredAtMs: null,
    };
    this.store = {
      get: (environmentId: string) =>
        environmentId === this.environment.environmentId ? this.environment : undefined,
      getCredential: (environmentId: string) =>
        environmentId === this.credentialRecord.environmentId ? this.credentialRecord : undefined,
      findCredentialByHash: (credentialHash: string) =>
        credentialHash === this.credentialRecord.credentialHash ? this.credentialRecord : undefined,
    } as WorkerEnvironmentStore;
    this.admitWorker = vi.fn(async (admission) =>
      admitWorkerConnection({
        store: this.store,
        admission,
        expectedBuild: BUILD,
        nowMs: Date.now(),
      }),
    );
    this.workerService = {
      admitWorker: this.admitWorker,
      validateWorkerConnection: (identity) =>
        validateWorkerConnectionIdentity({ store: this.store, identity, nowMs: Date.now() }),
      commitTranscript: async () => ({ ok: false, reason: "invalid-batch" }),
      pushLiveEvent: async () => ({ ok: false, details: { reason: "invalid-event" } }),
    };
    this.preauthBudget = createPreauthConnectionBudget(options.preauthLimit ?? 8);
    this.publicRateLimiter = createAuthRateLimiter({
      maxAttempts: options.rateLimitMaxAttempts ?? 10,
      exemptLoopback: false,
      pruneIntervalMs: 0,
    });
    this.httpServer = createGatewayHttpServer({
      clients: this.clients,
      controlUiEnabled: true,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth: RESOLVED_AUTH,
    });
  }

  async start(): Promise<void> {
    const logGateway = createGatewayWsTestLogger();
    attachGatewayWsConnectionHandler({
      wss: this.wss,
      clients: this.clients,
      preauthConnectionBudget: this.preauthBudget,
      port: 0,
      getResolvedAuth: () => RESOLVED_AUTH,
      preauthHandshakeTimeoutMs: 5_000,
      gatewayMethods: [],
      events: [],
      refreshHealthSnapshot: vi.fn(async () => ({}) as never),
      logGateway: logGateway as never,
      logHealth: createGatewayWsTestLogger() as never,
      logWsControl: this.logWsControl as never,
      extraHandlers: {},
      broadcast: vi.fn(),
      buildRequestContext: () => ({}) as never,
      workerConnectionService: this.workerService,
    });
    attachGatewayUpgradeHandler({
      httpServer: this.httpServer,
      wss: this.wss,
      handlePluginUpgrade: this.handlePluginUpgrade,
      clients: this.clients,
      preauthConnectionBudget: this.preauthBudget,
      resolvedAuth: RESOLVED_AUTH,
      publicRateLimiter: this.publicRateLimiter,
      workerIngressEnabled: true,
    });
    await new Promise<void>((resolve) => {
      this.httpServer.listen(0, "127.0.0.1", resolve);
    });
    this.port = (this.httpServer.address() as AddressInfo).port;
  }

  url(pathname = WORKER_GATEWAY_PATH): string {
    return `ws://127.0.0.1:${this.port}${pathname}`;
  }

  async close(): Promise<void> {
    this.publicRateLimiter.dispose();
    for (const socket of this.wss.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    if (this.httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

async function withHarness(
  options: ConstructorParameters<typeof PublicWorkerHarness>[0],
  run: (harness: PublicWorkerHarness) => Promise<void>,
): Promise<void> {
  await withTempConfig({
    cfg: {},
    prefix: "openclaw-public-worker-ingress-",
    run: async () => {
      const harness = new PublicWorkerHarness(options);
      activeHarnesses.push(harness);
      await harness.start();
      await run(harness);
    },
  });
}

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.close();
  }
});

describe("public worker ingress", () => {
  it("admits a store-backed worker on the reserved public path", async () => {
    await withHarness({}, async (harness) => {
      const response = new Promise<unknown>((resolve) => {
        const ws = new WebSocket(harness.url());
        ws.once("open", () =>
          ws.send(JSON.stringify(connectFrame(workerConnect(harness.credential)))),
        );
        ws.once("message", (data) => {
          resolve(JSON.parse(rawDataToString(data)));
          ws.close();
        });
      });

      await expect(response).resolves.toMatchObject({
        ok: true,
        payload: { type: "worker-hello-ok", environmentId: "worker-public" },
      });
      expect(harness.handlePluginUpgrade).not.toHaveBeenCalled();
      expect(harness.publicRateLimiter.size()).toBe(0);
    });
  });

  it("returns one opaque failure while retaining precise server reasons", async () => {
    await withHarness({}, async (harness) => {
      const badCredential = await rejectWorker(
        harness.url(),
        workerConnect("invalid-worker-credential-fixture"),
      );
      const wrongEnvironment = await rejectWorker(
        harness.url(),
        workerConnect(harness.credential, { environmentId: "worker-other" }),
      );
      const staleBuild = await rejectWorker(
        harness.url(),
        workerConnect(harness.credential, {
          handshake: {
            ...BUILD,
            bundleHash: "b".repeat(64),
            protocolFeatures: [...BUILD.protocolFeatures],
          },
        }),
      );
      harness.credentialRecord.expiresAtMs = Date.now() - 1;
      const expiredCredential = await rejectWorker(
        harness.url(),
        workerConnect(harness.credential),
      );

      expect(badCredential).toEqual(wrongEnvironment);
      expect(staleBuild).toEqual(badCredential);
      expect(expiredCredential).toEqual(badCredential);
      expect(badCredential).toEqual({
        response: {
          type: "res",
          id: "connect-1",
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "worker admission rejected",
            details: { reason: "invalid-handshake" },
          },
        },
        close: { code: 1008, reason: "invalid-handshake" },
      });
      expect(harness.logWsControl.warn).toHaveBeenCalledWith(
        "worker admission rejected reason=invalid-credential",
      );
      expect(harness.logWsControl.warn).toHaveBeenCalledWith(
        "worker admission rejected reason=environment-mismatch",
      );
      expect(harness.logWsControl.warn).toHaveBeenCalledWith(
        "worker admission rejected reason=bundle-mismatch",
      );
      expect(harness.logWsControl.warn).toHaveBeenCalledWith(
        "worker admission rejected reason=credential-expired",
      );
    });
  });

  it("forces connection kind from the route in both directions", async () => {
    await withHarness({}, async (harness) => {
      const operator = new WebSocket(harness.url());
      const operatorClose = waitForClose(operator);
      await waitForOpen(operator);
      operator.send(
        JSON.stringify(
          connectFrame({
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: { id: "test", version: "1", platform: "test", mode: "cli" },
            role: "operator",
            scopes: [],
          } as never),
        ),
      );
      await expect(operatorClose).resolves.toEqual({ code: 1008, reason: "invalid-handshake" });

      const worker = new WebSocket(harness.url("/"));
      const workerClose = waitForClose(worker);
      await waitForOpen(worker);
      worker.send(JSON.stringify(connectFrame(workerConnect(harness.credential))));
      await expect(workerClose).resolves.toEqual({ code: 1008, reason: "invalid-handshake" });
    });
  });

  it("rate-limits parallel invalid admissions before repeated store work", async () => {
    await withHarness({ rateLimitMaxAttempts: 2 }, async (harness) => {
      const sockets = Array.from({ length: 6 }, () => new WebSocket(harness.url()));
      await Promise.all(sockets.map((socket) => waitForOpen(socket)));
      const attempts = await Promise.all(
        sockets.map((socket, index) =>
          rejectOpenedWorker(
            socket,
            workerConnect(`invalid-worker-credential-${index.toString().padStart(2, "0")}`),
          ),
        ),
      );

      expect(harness.admitWorker).toHaveBeenCalledTimes(2);
      expect(new Set(attempts.map((attempt) => JSON.stringify(attempt)))).toEqual(
        new Set([
          JSON.stringify({
            response: {
              type: "res",
              id: "connect-1",
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "worker admission rejected",
                details: { reason: "invalid-handshake" },
              },
            },
            close: { code: 1008, reason: "invalid-handshake" },
          }),
        ]),
      );
    });
  });

  it("reserves the worker namespace for non-upgrade requests and scoped aliases", async () => {
    await withHarness({}, async (harness) => {
      const response = await fetch(`http://127.0.0.1:${harness.port}${WORKER_GATEWAY_PATH}`);
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not Found");

      await expect(
        requestUpgradeRejection(
          harness.port,
          `/__openclaw__/cap/${"a".repeat(32)}${WORKER_GATEWAY_PATH}`,
        ),
      ).resolves.toEqual({ status: 404, body: "" });
      expect(harness.handlePluginUpgrade).not.toHaveBeenCalled();
    });
  });
});
