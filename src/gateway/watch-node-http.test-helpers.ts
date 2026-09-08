import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { expect, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { listNodePairing } from "../infra/device-pairing-node.js";
import { getPairedDevice, resolveNodePairingState } from "../infra/device-pairing.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { NodeRegistry } from "./node-registry.js";
import { createWatchNodeHttpRuntime } from "./watch-node-http.js";

export async function startWatchNodeHttpRuntime(
  baseDir: string,
  servers: Server[],
  options?: {
    rateLimiter?: AuthRateLimiter;
    abortConnectResponse?: boolean;
    config?: OpenClawConfig;
    now?: () => number;
    onConnectResponseStart?: () => void;
    onPollReady?: (response: ServerResponse) => void;
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
    ...(options?.now ? { now: options.now } : {}),
  });
  let resolveConnectHandled: () => void = () => undefined;
  const connectHandled = new Promise<void>((resolve) => {
    resolveConnectHandled = resolve;
  });
  const server = createServer((req, res) => {
    const isConnect = req.url === "/api/nodes/watch/connect";
    if (isConnect && options?.onConnectResponseStart) {
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        options.onConnectResponseStart?.();
        return end(...args);
      }) as typeof res.end;
    }
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
        if (req.url === "/api/nodes/watch/poll" && !res.writableEnded) {
          options?.onPollReady?.(res);
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

export function makeConnectParams(params: {
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
  signedAt?: number;
}): ConnectParams {
  const publicKey = publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem);
  const auth = params.deviceToken
    ? { deviceToken: params.deviceToken }
    : { bootstrapToken: params.bootstrapToken };
  const signedAt = params.signedAt ?? Date.now();
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

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export async function connectWatchNode(params: {
  baseUrl: string;
  identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
  client?: Partial<ConnectParams["client"]>;
  bootstrapToken?: string;
  deviceToken?: string;
  commands?: string[];
  permissions?: ConnectParams["permissions"];
}): Promise<Response> {
  const challenge = await readJson(await fetch(`${params.baseUrl}/challenge`));
  return await fetch(`${params.baseUrl}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      makeConnectParams({
        identity: params.identity,
        client: params.client,
        nonce: String(challenge.nonce),
        signedAt: Number(challenge.ts),
        bootstrapToken: params.bootstrapToken,
        deviceToken: params.deviceToken,
        commands: params.commands,
        permissions: params.permissions,
      }),
    ),
  });
}

export function startPartialJsonRequest(params: { url: string; authorization: string }): {
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

export async function waitForLastConnectedMetadata(baseDir: string, nodeId: string): Promise<void> {
  await vi.waitFor(async () => {
    const paired = (await listNodePairing(baseDir)).paired.find((entry) => entry.nodeId === nodeId);
    expect(paired?.lastConnectedAtMs).toEqual(expect.any(Number));
  });
}
