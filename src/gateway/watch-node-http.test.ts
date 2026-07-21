import { createServer, request as httpRequest, type ClientRequest, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  resolveNodePairingState,
  revokeDeviceToken,
} from "../infra/device-pairing.js";
import { listNodePairing } from "../infra/node-pairing.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { NodeRegistry, serializeEventPayload } from "./node-registry.js";
import { createWatchNodeHttpRuntime } from "./watch-node-http.js";

const tempDirs = createTrackedTempDirs();
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  await tempDirs.cleanup();
});

function makeConnectParams(params: {
  identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
  nonce: string;
  bootstrapToken?: string;
  deviceToken?: string;
  client?: Partial<ConnectParams["client"]>;
  caps?: string[];
  commands?: string[];
  permissions?: ConnectParams["permissions"];
  minProtocol?: number;
  maxProtocol?: number;
}): ConnectParams {
  const publicKey = publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem);
  const auth = params.deviceToken
    ? { deviceToken: params.deviceToken }
    : { bootstrapToken: params.bootstrapToken };
  const signedAt = Date.now();
  const client: ConnectParams["client"] = {
    id: GATEWAY_CLIENT_IDS.WATCHOS_APP,
    displayName: "Test Watch",
    version: "1.0.0",
    platform: "watchOS 11.5.0",
    deviceFamily: "Apple Watch",
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: "watch-test",
    ...params.client,
  };
  const scopes: string[] = [];
  const signaturePayload = buildDeviceAuthPayloadV3({
    deviceId: params.identity.deviceId,
    clientId: client.id,
    clientMode: client.mode,
    role: "node",
    scopes,
    signedAtMs: signedAt,
    token: params.deviceToken ?? params.bootstrapToken ?? null,
    nonce: params.nonce,
    platform: client.platform,
    deviceFamily: client.deviceFamily,
  });
  return {
    minProtocol: params.minProtocol ?? PROTOCOL_VERSION,
    maxProtocol: params.maxProtocol ?? PROTOCOL_VERSION,
    client,
    caps: params.caps ?? [],
    commands: params.commands ?? ["device.info", "device.status", "system.notify"],
    permissions: params.permissions ?? { notifications: true },
    role: "node",
    scopes,
    auth,
    device: {
      id: params.identity.deviceId,
      publicKey,
      signature: signDevicePayload(params.identity.privateKeyPem, signaturePayload),
      signedAt,
      nonce: params.nonce,
    },
  } as ConnectParams;
}

async function startRuntime(
  baseDir: string,
  options?: {
    rateLimiter?: AuthRateLimiter;
    abortConnectResponse?: boolean;
    config?: OpenClawConfig;
  },
) {
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async (nodeId) => {
      const state = resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
      return state
        ? {
            identity: state.identity.key,
            ...(state.generation ? { generation: state.generation.key } : {}),
          }
        : undefined;
    },
  });
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const connectedNodes: string[] = [];
  const disconnectedNodes: Array<{ nodeId: string; reason: string }> = [];
  const runtime = createWatchNodeHttpRuntime({
    nodeRegistry,
    getConfig: () => options?.config ?? {},
    pairingBaseDir: baseDir,
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    onNodeConnected: (session) => connectedNodes.push(session.nodeId),
    onNodeDisconnected: (nodeId, reason) => disconnectedNodes.push({ nodeId, reason }),
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
  });
  let resolveConnectHandled: () => void = () => undefined;
  const connectHandled = new Promise<void>((resolve) => {
    resolveConnectHandled = resolve;
  });
  const server = createServer((req, res) => {
    const isConnect = req.url === "/api/nodes/watch/connect";
    if (isConnect && options?.abortConnectResponse) {
      res.end = (() => {
        res.destroy();
        return res;
      }) as typeof res.end;
    }
    void runtime
      .handleRequest(req, res)
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      })
      .finally(() => {
        if (isConnect) {
          resolveConnectHandled();
        }
      });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return {
    nodeRegistry,
    broadcasts,
    connectedNodes,
    disconnectedNodes,
    runtime,
    connectHandled,
    baseUrl: `http://127.0.0.1:${address.port}/api/nodes/watch`,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function startPartialJsonRequest(params: { url: string; authorization: string }): {
  request: ClientRequest;
  response: Promise<{ statusCode: number; body: string }>;
} {
  let request!: ClientRequest;
  const response = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    request = httpRequest(
      params.url,
      {
        method: "POST",
        headers: {
          authorization: params.authorization,
          "content-type": "application/json",
        },
      },
      (result) => {
        const chunks: Buffer[] = [];
        result.on("data", (chunk: Buffer) => chunks.push(chunk));
        result.once("end", () => {
          resolve({
            statusCode: result.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
  });
  return { request, response };
}

async function waitForLastConnectedMetadata(baseDir: string, nodeId: string): Promise<void> {
  await vi.waitFor(async () => {
    const paired = (await listNodePairing(baseDir)).paired.find((entry) => entry.nodeId === nodeId);
    expect(paired?.lastConnectedAtMs).toEqual(expect.any(Number));
  });
}

describe("watch node HTTP transport", () => {
  it("rejects capabilities and identities outside the bounded watch surface", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-surface-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { baseUrl, runtime } = await startRuntime(baseDir);
    const variants: Array<(nonce: string) => ConnectParams> = [
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          commands: ["device.info", "device.status", "system.notify", "system.run"],
        }),
      (nonce) =>
        makeConnectParams({ identity, nonce, bootstrapToken: issued.token, caps: ["canvas"] }),
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          client: { deviceFamily: "iPhone" },
        }),
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          permissions: { notifications: true, canvas: true },
        }),
      (nonce) =>
        makeConnectParams({
          identity,
          nonce,
          bootstrapToken: issued.token,
          minProtocol: PROTOCOL_VERSION + 1,
          maxProtocol: PROTOCOL_VERSION + 1,
        }),
    ];

    for (const variant of variants) {
      const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
      const response = await fetch(`${baseUrl}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(variant(String(challenge.nonce))),
      });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        error: { message: "unsupported watch node identity or capability surface" },
      });
    }
    runtime.close();
  });

  it("accepts a supported notification permission set to false", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-permissions-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { baseUrl, runtime } = await startRuntime(baseDir);
    const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const response = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(challenge.nonce),
          bootstrapToken: issued.token,
          permissions: { notifications: false },
        }),
      ),
    });

    expect(response.status).toBe(200);
    await readJson(response);
    runtime.close();
  });

  it("does not let attacker challenges evict another client nonce", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-challenge-eviction-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { baseUrl, runtime } = await startRuntime(baseDir, {
      config: { gateway: { trustedProxies: ["127.0.0.1"] } },
    });
    const legitimateHeaders = { "x-forwarded-for": "203.0.113.10" };
    const legitimate = await readJson(
      await fetch(`${baseUrl}/challenge`, { headers: legitimateHeaders }),
    );
    for (let index = 0; index < 32; index += 1) {
      const response = await fetch(`${baseUrl}/challenge`, {
        headers: { "x-forwarded-for": "198.51.100.20" },
      });
      expect(response.status).toBe(200);
      await readJson(response);
    }

    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", ...legitimateHeaders },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(legitimate.nonce),
          bootstrapToken: issued.token,
        }),
      ),
    });
    expect(connectResponse.status).toBe(200);
    runtime.close();
  });

  it("requires an authenticated disconnect and emits one lifecycle teardown", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-disconnect-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { nodeRegistry, connectedNodes, disconnectedNodes, runtime, baseUrl } =
      await startRuntime(baseDir);

    const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(challenge.nonce),
          bootstrapToken: issued.token,
        }),
      ),
    });
    expect(connectResponse.status).toBe(200);
    const connected = await readJson(connectResponse);
    const sessionToken = String(connected.sessionToken);
    expect(connectedNodes).toEqual([identity.deviceId]);

    const unauthenticated = await fetch(`${baseUrl}/disconnect`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    expect(nodeRegistry.get(identity.deviceId)).toBeDefined();
    expect(disconnectedNodes).toEqual([]);

    const wrongMethod = await fetch(`${baseUrl}/disconnect`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(wrongMethod.status).toBe(405);
    expect(nodeRegistry.get(identity.deviceId)).toBeDefined();

    const disconnectResponse = await fetch(`${baseUrl}/disconnect`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(disconnectResponse.status).toBe(200);
    await expect(readJson(disconnectResponse)).resolves.toEqual({ ok: true });
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    expect(disconnectedNodes).toEqual([
      { nodeId: identity.deviceId, reason: "watch disconnected" },
    ]);

    const repeatedDisconnect = await fetch(`${baseUrl}/disconnect`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(repeatedDisconnect.status).toBe(401);
    runtime.close();
    expect(disconnectedNodes).toHaveLength(1);
  });

  it("rejects an HTTP node session after an external reapproval changes its generation", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-reapproval-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { nodeRegistry, disconnectedNodes, runtime, baseUrl } = await startRuntime(baseDir);
    const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(challenge.nonce),
          bootstrapToken: issued.token,
        }),
      ),
    });
    const connected = await readJson(connectResponse);
    const paired = await getPairedDevice(identity.deviceId, baseDir);
    const repair = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey: paired?.publicKey ?? "",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);

    const stalePoll = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(connected.sessionToken)}` },
    });
    expect(stalePoll.status).toBe(401);
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    expect(disconnectedNodes).toContainEqual({
      nodeId: identity.deviceId,
      reason: "node pairing changed",
    });
    runtime.close();
  });

  it("rejects an invoke result when pairing changes during body upload", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-result-generation-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { nodeRegistry, disconnectedNodes, runtime, baseUrl } = await startRuntime(baseDir);
    const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(challenge.nonce),
          bootstrapToken: issued.token,
        }),
      ),
    });
    const connected = await readJson(connectResponse);
    const invoke = nodeRegistry.invoke({
      nodeId: identity.deviceId,
      command: "device.info",
      timeoutMs: 2_000,
    });
    const invokeAfterDisconnect = invoke.catch((error: unknown) => error);
    const pollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(connected.sessionToken)}` },
    });
    const polled = await readJson(pollResponse);
    const event = polled.event as { payload: { id: string } };
    const currentCheck = vi.spyOn(nodeRegistry, "isConnectionCurrentPairingState");
    currentCheck.mockClear();
    const partial = startPartialJsonRequest({
      url: `${baseUrl}/result`,
      authorization: `Bearer ${String(connected.sessionToken)}`,
    });
    partial.request.write(`{"id":${JSON.stringify(event.payload.id)},"ok":`);
    await vi.waitFor(() => expect(currentCheck).toHaveBeenCalledTimes(1));

    const paired = await getPairedDevice(identity.deviceId, baseDir);
    const repair = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey: paired?.publicKey ?? "",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);
    partial.request.end(`true,"payloadJSON":"{\\"model\\":\\"stale\\"}"}`);

    const resultResponse = await partial.response;
    expect(resultResponse.statusCode).toBe(401);
    expect(JSON.parse(resultResponse.body)).toMatchObject({
      error: { type: "unauthorized" },
    });
    expect(currentCheck).toHaveBeenCalledTimes(2);
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    expect(disconnectedNodes).toContainEqual({
      nodeId: identity.deviceId,
      reason: "node pairing changed",
    });
    await expect(invokeAfterDisconnect).resolves.toBeInstanceOf(Error);
    runtime.close();
  });

  it("rejects empty shadow credentials without consuming the challenge", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-auth-fields-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { baseUrl, runtime } = await startRuntime(baseDir);

    const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const connect = makeConnectParams({
      identity,
      nonce: String(challenge.nonce),
      bootstrapToken: issued.token,
    });
    const shadowedResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...connect,
        auth: { ...connect.auth, token: "" },
      }),
    });
    expect(shadowedResponse.status).toBe(401);

    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(connect),
    });
    expect(connectResponse.status).toBe(200);
    await readJson(connectResponse);
    await waitForLastConnectedMetadata(baseDir, identity.deviceId);
    runtime.close();
  });

  it("keeps challenge throttling after abort and resets it after completion", async () => {
    const limiterConfig = {
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
      pruneIntervalMs: 0,
    };

    const abortedBaseDir = await tempDirs.make("openclaw-watch-node-aborted-connect-");
    const abortedIdentity = loadOrCreateDeviceIdentity({
      path: path.join(abortedBaseDir, "watch-identity.sqlite"),
    });
    const abortedBootstrap = await issueDeviceBootstrapToken({
      baseDir: abortedBaseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const abortedLimiter = createAuthRateLimiter(limiterConfig);
    try {
      const abortedRuntime = await startRuntime(abortedBaseDir, {
        rateLimiter: abortedLimiter,
        abortConnectResponse: true,
      });
      const challenge = await readJson(await fetch(`${abortedRuntime.baseUrl}/challenge`));
      await expect(
        fetch(`${abortedRuntime.baseUrl}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            makeConnectParams({
              identity: abortedIdentity,
              nonce: String(challenge.nonce),
              bootstrapToken: abortedBootstrap.token,
            }),
          ),
        }),
      ).rejects.toThrow();
      await abortedRuntime.connectHandled;
      const stillLimited = await fetch(`${abortedRuntime.baseUrl}/challenge`);
      expect(stillLimited.status).toBe(429);
      abortedRuntime.runtime.close();
    } finally {
      abortedLimiter.dispose();
    }

    const completedBaseDir = await tempDirs.make("openclaw-watch-node-completed-connect-");
    const completedIdentity = loadOrCreateDeviceIdentity({
      path: path.join(completedBaseDir, "watch-identity.sqlite"),
    });
    const completedBootstrap = await issueDeviceBootstrapToken({
      baseDir: completedBaseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const completedLimiter = createAuthRateLimiter(limiterConfig);
    try {
      const completedRuntime = await startRuntime(completedBaseDir, {
        rateLimiter: completedLimiter,
      });
      const challenge = await readJson(await fetch(`${completedRuntime.baseUrl}/challenge`));
      const connectResponse = await fetch(`${completedRuntime.baseUrl}/connect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          makeConnectParams({
            identity: completedIdentity,
            nonce: String(challenge.nonce),
            bootstrapToken: completedBootstrap.token,
          }),
        ),
      });
      expect(connectResponse.status).toBe(200);
      await readJson(connectResponse);
      await completedRuntime.connectHandled;
      await waitForLastConnectedMetadata(completedBaseDir, completedIdentity.deviceId);
      const resetAfterCompletion = await fetch(`${completedRuntime.baseUrl}/challenge`);
      expect(resetAfterCompletion.status).toBe(200);
      completedRuntime.runtime.close();
    } finally {
      completedLimiter.dispose();
    }
  });

  it("bootstraps, registers, polls an invoke, and accepts its result", async () => {
    const baseDir = await tempDirs.make("openclaw-watch-node-http-");
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(baseDir, "watch-identity.sqlite"),
    });
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const { nodeRegistry, broadcasts, connectedNodes, disconnectedNodes, runtime, baseUrl } =
      await startRuntime(baseDir);

    const challenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const connectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(challenge.nonce),
          bootstrapToken: issued.token,
        }),
      ),
    });
    expect(connectResponse.status).toBe(200);
    const connected = await readJson(connectResponse);
    expect(connected.sessionToken).toEqual(expect.any(String));
    expect(connected.deviceToken).toEqual(expect.any(String));
    expect(nodeRegistry.get(identity.deviceId)?.commands).toEqual([
      "device.info",
      "device.status",
      "system.notify",
    ]);
    expect(broadcasts.map((entry) => entry.event)).toContain("device.pair.resolved");
    expect(broadcasts.map((entry) => entry.event)).toContain("node.pair.resolved");
    expect(connectedNodes).toEqual([identity.deviceId]);

    const reconnectChallenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const reconnectResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(reconnectChallenge.nonce),
          deviceToken: String(connected.deviceToken),
        }),
      ),
    });
    expect(reconnectResponse.status).toBe(200);
    const reconnected = await readJson(reconnectResponse);
    expect(reconnected.deviceToken).toBe(connected.deviceToken);
    expect(connectedNodes).toEqual([identity.deviceId, identity.deviceId]);
    expect(disconnectedNodes).toEqual([]);
    const stalePollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(connected.sessionToken)}` },
    });
    expect(stalePollResponse.status).toBe(401);

    const invoke = nodeRegistry.invoke({
      nodeId: identity.deviceId,
      command: "device.info",
      timeoutMs: 2_000,
    });
    const pollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(reconnected.sessionToken)}` },
    });
    expect(pollResponse.status).toBe(200);
    const polled = await readJson(pollResponse);
    const event = polled.event as { event: string; payload: { id: string } };
    expect(event.event).toBe("node.invoke.request");

    const resultResponse = await fetch(`${baseUrl}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(reconnected.sessionToken)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: event.payload.id, ok: true, payloadJSON: '{"model":"Watch"}' }),
    });
    expect(resultResponse.status).toBe(200);
    await expect(invoke).resolves.toMatchObject({
      ok: true,
      payloadJSON: '{"model":"Watch"}',
    });

    const lateResultResponse = await fetch(`${baseUrl}/result`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(reconnected.sessionToken)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: event.payload.id, ok: true }),
    });
    expect(lateResultResponse.status).toBe(200);
    await expect(readJson(lateResultResponse)).resolves.toEqual({ ok: true, ignored: true });
    await expect(nodeRegistry.checkConnectivity(identity.deviceId)).resolves.toEqual({ ok: true });

    runtime.invalidateSessionsForDevice(identity.deviceId, {
      role: "node",
      reason: "device-token-revoked",
    });
    await expect(nodeRegistry.checkConnectivity(identity.deviceId)).resolves.toEqual({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "device-token-revoked" },
    });
    runtime.disconnectSessionsForDevice(identity.deviceId, { role: "node" });
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    expect(disconnectedNodes).toContainEqual({
      nodeId: identity.deviceId,
      reason: "device-token-revoked",
    });
    const invalidatedPollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(reconnected.sessionToken)}` },
    });
    expect(invalidatedPollResponse.status).toBe(401);

    const revoked = await revokeDeviceToken({
      deviceId: identity.deviceId,
      role: "node",
      baseDir,
    });
    expect(revoked.ok).toBe(true);
    const replacementBootstrap = await issueDeviceBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const replacementChallenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const replacementResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(replacementChallenge.nonce),
          bootstrapToken: replacementBootstrap.token,
        }),
      ),
    });
    expect(replacementResponse.status).toBe(200);
    const replacement = await readJson(replacementResponse);
    expect(replacement.deviceToken).toEqual(expect.any(String));
    expect(replacement.deviceToken).not.toBe(connected.deviceToken);
    expect(connectedNodes).toEqual([identity.deviceId, identity.deviceId, identity.deviceId]);

    const replayChallenge = await readJson(await fetch(`${baseUrl}/challenge`));
    const replayResponse = await fetch(`${baseUrl}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        makeConnectParams({
          identity,
          nonce: String(replayChallenge.nonce),
          bootstrapToken: replacementBootstrap.token,
        }),
      ),
    });
    expect(replayResponse.status).toBe(401);

    const rawPayload = serializeEventPayload({ sequence: 1 });
    expect(rawPayload).not.toBeNull();
    expect(nodeRegistry.sendEventRaw(identity.deviceId, "node.invoke.request", rawPayload)).toBe(
      true,
    );
    const rawPollResponse = await fetch(`${baseUrl}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(replacement.sessionToken)}` },
    });
    expect(rawPollResponse.status).toBe(200);
    await expect(readJson(rawPollResponse)).resolves.toMatchObject({
      ok: true,
      event: { event: "node.invoke.request", payload: { sequence: 1 } },
    });

    const oversizedPayload = serializeEventPayload({ value: "x".repeat(70 * 1024) });
    expect(oversizedPayload).not.toBeNull();
    expect(
      nodeRegistry.sendEventRaw(identity.deviceId, "node.invoke.request", oversizedPayload),
    ).toBe(false);
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
    expect(disconnectedNodes).toContainEqual({
      nodeId: identity.deviceId,
      reason: "event payload too large",
    });

    runtime.close();
    expect(nodeRegistry.get(identity.deviceId)).toBeUndefined();
  });
});
