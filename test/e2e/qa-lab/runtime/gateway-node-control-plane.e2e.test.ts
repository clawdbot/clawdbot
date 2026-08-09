// Proves the Gateway node control plane across real authenticated WebSockets.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { describe, expect, it, vi } from "vitest";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../../../src/infra/device-identity.js";

const TEST_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 20_000;
const NODE_DISPLAY_NAME = "QA iPhone";
const NODE_CAPS = ["camera", "location"];
const NODE_COMMANDS = ["camera.list", "location.get"];
const NODE_PERMISSIONS = {
  accessibility: true,
  camera: true,
  location: true,
};

type GatewayHandle = Awaited<ReturnType<typeof startQaGatewayChild>>;
type NodeRead = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  approvalState?: string;
  paired?: boolean;
  connected?: boolean;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};
type NodeInvokeFrame = {
  id?: string;
  nodeId?: string;
  command?: string;
  paramsJSON?: string | null;
};
type InvocationRecord = {
  id: string;
  nodeId: string;
  command: string;
  params: unknown;
};

describe("Gateway node control plane", () => {
  it(
    "pairs, inventories, invokes, and records presence for one remote device",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const gateway = await startQaGatewayChild({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["--import", "tsx", "src/entry.ts"],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
        mutateConfig: (cfg) => {
          const { plugins: _plugins, ...withoutPlugins } = cfg;
          return {
            ...withoutPlugins,
            gateway: {
              ...cfg.gateway,
              nodes: {
                ...cfg.gateway?.nodes,
                commands: { allow: NODE_COMMANDS },
              },
            },
          };
        },
      });
      const identity = loadOrCreateDeviceIdentity({
        path: path.join(gateway.tempRoot, "control-plane-node.sqlite"),
      });
      const invocations: InvocationRecord[] = [];
      const handlerErrors: Error[] = [];
      let operator: GatewayClient | undefined;
      let node: GatewayClient | undefined;

      try {
        operator = await connectOperator(gateway);
        node = await connectPairedNode({
          gateway,
          identity,
          operator,
          onEvent: (event) => {
            if (event.event !== "node.invoke.request") {
              return;
            }
            void respondToInvocation(node, event.payload, invocations).catch((error: unknown) => {
              handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
            });
          },
        });

        const listed = await waitForApprovedNode(operator, identity.deviceId, gateway.logs);
        expect(listed).toMatchObject({
          nodeId: identity.deviceId,
          displayName: NODE_DISPLAY_NAME,
          platform: "ios",
          deviceFamily: "iPhone",
          approvalState: "approved",
          paired: true,
          connected: true,
          permissions: NODE_PERMISSIONS,
        });
        expect(listed.caps?.toSorted()).toEqual(NODE_CAPS);
        expect(listed.commands?.toSorted()).toEqual(NODE_COMMANDS);

        const described = await operator.request<NodeRead>(
          "node.describe",
          { nodeId: identity.deviceId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        expect(described).toMatchObject({
          nodeId: identity.deviceId,
          displayName: NODE_DISPLAY_NAME,
          platform: "ios",
          deviceFamily: "iPhone",
          approvalState: "approved",
          paired: true,
          connected: true,
          permissions: NODE_PERMISSIONS,
        });
        expect(described.caps?.toSorted()).toEqual(NODE_CAPS);
        expect(described.commands?.toSorted()).toEqual(NODE_COMMANDS);

        const cameraParams = { includeUnavailable: false };
        const cameraResult = await operator.request<{
          ok: boolean;
          nodeId: string;
          command: string;
          payload: unknown;
        }>(
          "node.invoke",
          {
            nodeId: identity.deviceId,
            command: "camera.list",
            params: cameraParams,
            timeoutMs: REQUEST_TIMEOUT_MS,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        expect(cameraResult).toMatchObject({
          ok: true,
          nodeId: identity.deviceId,
          command: "camera.list",
          payload: {
            cameras: [{ id: "back-wide", position: "back" }],
            received: cameraParams,
          },
        });

        const locationParams = { accuracy: "balanced" };
        const locationResult = await operator.request<{
          ok: boolean;
          nodeId: string;
          command: string;
          payload: unknown;
        }>(
          "node.invoke",
          {
            nodeId: identity.deviceId,
            command: "location.get",
            params: locationParams,
            timeoutMs: REQUEST_TIMEOUT_MS,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        expect(locationResult).toMatchObject({
          ok: true,
          nodeId: identity.deviceId,
          command: "location.get",
          payload: {
            latitude: 37.3318,
            longitude: -122.0312,
            received: locationParams,
          },
        });
        expect(invocations).toMatchObject([
          {
            nodeId: identity.deviceId,
            command: "camera.list",
            params: cameraParams,
          },
          {
            nodeId: identity.deviceId,
            command: "location.get",
            params: locationParams,
          },
        ]);
        expect(handlerErrors).toEqual([]);

        const aliveSentAtMs = Date.now();
        const aliveResult = await node.request<{
          ok: boolean;
          event: string;
          handled: boolean;
          reason?: string;
        }>(
          "node.event",
          {
            event: "node.presence.alive",
            payload: {
              trigger: "manual",
              sentAtMs: aliveSentAtMs,
              displayName: NODE_DISPLAY_NAME,
              platform: "ios",
              deviceFamily: "iPhone",
            },
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        expect(aliveResult).toMatchObject({
          ok: true,
          event: "node.presence.alive",
          handled: true,
          reason: "persisted",
        });

        const connectedOperator = operator;
        await vi.waitFor(
          async () => {
            const afterAlive = await readNode(connectedOperator, identity.deviceId);
            expect(afterAlive, gateway.logs()).toMatchObject({
              lastSeenReason: "manual",
            });
            expect(afterAlive?.lastSeenAtMs).toBeGreaterThanOrEqual(aliveSentAtMs);
            const describedAfterAlive = await connectedOperator.request<NodeRead>(
              "node.describe",
              { nodeId: identity.deviceId },
              { timeoutMs: REQUEST_TIMEOUT_MS },
            );
            expect(describedAfterAlive).toMatchObject({
              lastSeenReason: "manual",
            });
            expect(describedAfterAlive.lastSeenAtMs).toBeGreaterThanOrEqual(aliveSentAtMs);
          },
          { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
        );
      } finally {
        await Promise.allSettled([
          ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
          ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
        ]);
        const tempRoot = gateway.tempRoot;
        await gateway.stop();
        expect(existsSync(tempRoot)).toBe(false);
      }
    },
  );
});

async function connectOperator(gateway: GatewayHandle): Promise<GatewayClient> {
  return await connectClient({
    gateway,
    role: "operator",
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Gateway node QA operator",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    deviceIdentity: null,
  });
}

async function connectPairedNode(params: {
  gateway: GatewayHandle;
  identity: DeviceIdentity;
  operator: GatewayClient;
  onEvent: (event: { event: string; payload?: unknown }) => void;
}): Promise<GatewayClient> {
  const connect = () =>
    connectClient({
      gateway: params.gateway,
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.IOS_APP,
      clientDisplayName: NODE_DISPLAY_NAME,
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "ios",
      deviceFamily: "iPhone",
      scopes: [],
      caps: NODE_CAPS,
      commands: NODE_COMMANDS,
      permissions: NODE_PERMISSIONS,
      deviceIdentity: params.identity,
      onEvent: params.onEvent,
    });
  try {
    return await connect();
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
    await approvePendingNodePairing(params.operator, params.identity.deviceId);
    return await connect();
  }
}

async function connectClient(params: {
  gateway: GatewayHandle;
  role: "operator" | "node";
  clientName: typeof GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT | typeof GATEWAY_CLIENT_NAMES.IOS_APP;
  clientDisplayName: string;
  mode: typeof GATEWAY_CLIENT_MODES.BACKEND | typeof GATEWAY_CLIENT_MODES.NODE;
  scopes: string[];
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  deviceIdentity: DeviceIdentity | null;
  onEvent?: (event: { event: string; payload?: unknown }) => void;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
        return;
      }
      resolve(client);
    };
    const client = new GatewayClient({
      url: params.gateway.wsUrl,
      token: params.gateway.token,
      env: params.gateway.runtimeEnv,
      role: params.role,
      clientName: params.clientName,
      clientDisplayName: params.clientDisplayName,
      clientVersion: "1.0.0",
      platform: params.platform ?? process.platform,
      deviceFamily: params.deviceFamily,
      mode: params.mode,
      scopes: params.scopes,
      caps: params.caps,
      commands: params.commands,
      permissions: params.permissions,
      deviceIdentity: params.deviceIdentity,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent: params.onEvent,
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error(`Gateway client connection timed out:\n${params.gateway.logs()}`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

function isPairingRequired(error: unknown): boolean {
  const details =
    error && typeof error === "object"
      ? (error as { details?: { code?: unknown } }).details
      : undefined;
  return details?.code === "PAIRING_REQUIRED" || String(error).includes("PAIRING_REQUIRED");
}

async function approvePendingNodePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  let deviceRequestId: string | undefined;
  await vi.waitFor(
    async () => {
      const devices = await operator.request<{
        pending?: Array<{ requestId?: string; deviceId?: string; role?: string }>;
      }>("device.pair.list", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
      const pendingDevice = devices.pending?.find(
        (entry) => entry.deviceId === nodeId || entry.role === "node",
      );
      expect(pendingDevice?.requestId).toBeTruthy();
      deviceRequestId = pendingDevice?.requestId;
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
  await operator.request(
    "device.pair.approve",
    { requestId: deviceRequestId },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );

  let nodeRequestId: string | undefined;
  await vi.waitFor(
    async () => {
      const nodes = await operator.request<{
        pending?: Array<{ requestId?: string; nodeId?: string }>;
      }>("node.pair.list", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
      const pendingNode = nodes.pending?.find((entry) => entry.nodeId === nodeId);
      expect(pendingNode?.requestId).toBeTruthy();
      nodeRequestId = pendingNode?.requestId;
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
  await operator.request(
    "node.pair.approve",
    { requestId: nodeRequestId },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
}

async function waitForApprovedNode(
  operator: GatewayClient,
  nodeId: string,
  logs: () => string,
): Promise<NodeRead> {
  let approved: NodeRead | undefined;
  await vi.waitFor(
    async () => {
      await approvePendingNodeSurface(operator, nodeId);
      approved = await readNode(operator, nodeId);
      expect(approved, logs()).toMatchObject({
        nodeId,
        approvalState: "approved",
        connected: true,
        paired: true,
      });
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
  if (!approved) {
    throw new Error(`approved node never became visible:\n${logs()}`);
  }
  return approved;
}

async function approvePendingNodeSurface(operator: GatewayClient, nodeId: string): Promise<void> {
  const nodes = await operator.request<{
    pending?: Array<{ requestId?: string; nodeId?: string }>;
  }>("node.pair.list", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
  for (const pending of nodes.pending ?? []) {
    if (pending.nodeId === nodeId && pending.requestId) {
      await operator.request(
        "node.pair.approve",
        { requestId: pending.requestId },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
    }
  }
}

async function readNode(operator: GatewayClient, nodeId: string): Promise<NodeRead | undefined> {
  const result = await operator.request<{ nodes?: NodeRead[] }>(
    "node.list",
    {},
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  return result.nodes?.find((entry) => entry.nodeId === nodeId);
}

async function respondToInvocation(
  node: GatewayClient | undefined,
  payload: unknown,
  invocations: InvocationRecord[],
): Promise<void> {
  const frame = payload as NodeInvokeFrame;
  if (!node || !frame.id || !frame.nodeId || !frame.command) {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  const params = frame.paramsJSON ? JSON.parse(frame.paramsJSON) : undefined;
  invocations.push({
    id: frame.id,
    nodeId: frame.nodeId,
    command: frame.command,
    params,
  });
  const response =
    frame.command === "camera.list"
      ? {
          cameras: [{ id: "back-wide", position: "back" }],
          received: params,
        }
      : frame.command === "location.get"
        ? {
            latitude: 37.3318,
            longitude: -122.0312,
            received: params,
          }
        : undefined;
  if (!response) {
    throw new Error(`unexpected node command: ${frame.command}`);
  }
  await node.request(
    "node.invoke.result",
    {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON: JSON.stringify(response),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
}
