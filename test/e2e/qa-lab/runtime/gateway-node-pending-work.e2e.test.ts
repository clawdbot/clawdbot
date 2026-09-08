// Proves both Gateway pending-work queues across real authenticated WebSockets.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "../../../../src/infra/device-identity.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const gatewayOwners: ReturnType<typeof createQaGatewayChild>[] = [];
afterEach(async () => {
  for (const owner of gatewayOwners.splice(0)) {
    await stopQaGatewayFixture(owner);
  }
});

const TEST_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 20_000;
const NODE_DISPLAY_NAME = "QA iPad";
const NODE_COMMANDS = ["camera.snap"];

type GatewayHandle = QaGatewayChild;
type NodeInvokeFrame = {
  id?: string;
  nodeId?: string;
  command?: string;
  paramsJSON?: string | null;
};
type NodeRead = {
  nodeId: string;
  approvalState?: string;
  connected?: boolean;
  paired?: boolean;
};
type PendingWorkItem = {
  id: string;
  type: string;
  priority: string;
  createdAtMs: number;
  expiresAtMs?: number | null;
};
type PendingAction = {
  id: string;
  command: string;
  paramsJSON: string | null;
  enqueuedAtMs: number;
};

describe("Gateway node pending work", () => {
  it(
    "delivers disconnected work and foreground-only actions after same-pairing reconnects",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const gatewayOwner = createQaGatewayChild();
      gatewayOwners.push(gatewayOwner);
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["dist/entry.js"],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
        mutateConfig: (cfg) => {
          return {
            ...cfg,
            plugins: { enabled: false },
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
        path: path.join(gateway.tempRoot, "pending-work-node.sqlite"),
      });
      const handlerErrors: Error[] = [];
      const backgroundRequests: NodeInvokeFrame[] = [];
      let operator: GatewayClient | undefined;
      let node: GatewayClient | undefined;

      const connectNode = async () => {
        const connected = await connectPairedNode({
          gateway,
          identity,
          operator: expectConnected(operator),
          onEvent: (event) => {
            if (event.event !== "node.invoke.request") {
              return;
            }
            void rejectBackgroundInvocation(node, event.payload, backgroundRequests).catch(
              (error: unknown) => {
                handlerErrors.push(error instanceof Error ? error : new Error(String(error)));
              },
            );
          },
        });
        await waitForApprovedNode(expectConnected(operator), identity.deviceId, gateway.logs);
        return connected;
      };

      try {
        operator = await connectOperator(gateway);
        node = await connectNode();
        await waitForNodeConnection(operator, identity.deviceId, true, gateway.logs);

        await node.stopAndWait({ timeoutMs: 1_000 });
        node = undefined;
        await waitForNodeConnection(operator, identity.deviceId, false, gateway.logs);

        const enqueued = await operator.request<{
          nodeId: string;
          revision: number;
          queued: PendingWorkItem;
          wakeTriggered: boolean;
        }>(
          "node.pending.enqueue",
          {
            nodeId: identity.deviceId,
            type: "location.request",
            priority: "high",
            wake: false,
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        expect(enqueued).toMatchObject({
          nodeId: identity.deviceId,
          queued: {
            type: "location.request",
            priority: "high",
          },
          wakeTriggered: false,
        });
        expect(enqueued.queued.id).toBeTruthy();

        node = await connectNode();
        await waitForNodeConnection(operator, identity.deviceId, true, gateway.logs);
        const drained = await node.request<{
          nodeId: string;
          revision: number;
          items: PendingWorkItem[];
          hasMore: boolean;
        }>("node.pending.drain", { maxItems: 2 }, { timeoutMs: REQUEST_TIMEOUT_MS });
        expect(drained).toMatchObject({
          nodeId: identity.deviceId,
          items: [
            {
              id: enqueued.queued.id,
              type: "location.request",
              priority: "high",
            },
            {
              id: "baseline-status",
              type: "status.request",
              priority: "default",
            },
          ],
          hasMore: false,
        });

        const cameraParams = { facing: "back", maxWidth: 1280 };
        let invokeError: unknown;
        try {
          await operator.request(
            "node.invoke",
            {
              nodeId: identity.deviceId,
              command: "camera.snap",
              params: cameraParams,
              timeoutMs: REQUEST_TIMEOUT_MS,
              idempotencyKey: randomUUID(),
            },
            { timeoutMs: REQUEST_TIMEOUT_MS },
          );
        } catch (error) {
          invokeError = error;
        }
        expect(invokeError).toMatchObject({
          code: "UNAVAILABLE",
          retryable: true,
          details: {
            code: "QUEUED_UNTIL_FOREGROUND",
            nodeId: identity.deviceId,
            command: "camera.snap",
          },
        });
        const queuedActionId = readQueuedActionId(invokeError);
        expect(backgroundRequests).toMatchObject([
          {
            nodeId: identity.deviceId,
            command: "camera.snap",
            paramsJSON: JSON.stringify(cameraParams),
          },
        ]);
        expect(handlerErrors).toEqual([]);

        await node.stopAndWait({ timeoutMs: 1_000 });
        node = undefined;
        await waitForNodeConnection(operator, identity.deviceId, false, gateway.logs);
        node = await connectNode();
        await waitForNodeConnection(operator, identity.deviceId, true, gateway.logs);

        const pulled = await node.request<{
          nodeId: string;
          actions: PendingAction[];
        }>("node.pending.pull", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
        expect(pulled).toMatchObject({
          nodeId: identity.deviceId,
          actions: [
            {
              id: queuedActionId,
              command: "camera.snap",
              paramsJSON: JSON.stringify(cameraParams),
            },
          ],
        });
        expect(pulled.actions[0]?.enqueuedAtMs).toEqual(expect.any(Number));

        const acked = await node.request<{
          nodeId: string;
          ackedIds: string[];
          remainingCount: number;
        }>("node.pending.ack", { ids: [queuedActionId] }, { timeoutMs: REQUEST_TIMEOUT_MS });
        expect(acked).toEqual({
          nodeId: identity.deviceId,
          ackedIds: [queuedActionId],
          remainingCount: 0,
        });
        await expect(
          node.request<{ nodeId: string; actions: PendingAction[] }>(
            "node.pending.pull",
            {},
            { timeoutMs: REQUEST_TIMEOUT_MS },
          ),
        ).resolves.toEqual({
          nodeId: identity.deviceId,
          actions: [],
        });
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

function expectConnected(client: GatewayClient | undefined): GatewayClient {
  if (!client) {
    throw new Error("operator is not connected");
  }
  return client;
}

async function connectOperator(gateway: GatewayHandle): Promise<GatewayClient> {
  return await connectClient({
    gateway,
    role: "operator",
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Gateway pending-work QA operator",
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
      platform: "iPadOS 26.4",
      deviceFamily: "iPad",
      scopes: [],
      caps: ["camera"],
      commands: NODE_COMMANDS,
      permissions: { camera: true },
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

async function waitForNodeConnection(
  operator: GatewayClient,
  nodeId: string,
  connected: boolean,
  logs: () => string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const result = await operator.request<{ nodes?: NodeRead[] }>(
        "node.list",
        {},
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      expect(
        result.nodes?.find((entry) => entry.nodeId === nodeId),
        logs(),
      ).toMatchObject({
        nodeId,
        paired: true,
        connected,
      });
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
}

async function waitForApprovedNode(
  operator: GatewayClient,
  nodeId: string,
  logs: () => string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await approvePendingNodeSurface(operator, nodeId);
      const result = await operator.request<{ nodes?: NodeRead[] }>(
        "node.list",
        {},
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      expect(
        result.nodes?.find((entry) => entry.nodeId === nodeId),
        logs(),
      ).toMatchObject({
        nodeId,
        approvalState: "approved",
        paired: true,
        connected: true,
      });
    },
    { timeout: REQUEST_TIMEOUT_MS, interval: 100 },
  );
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

async function rejectBackgroundInvocation(
  node: GatewayClient | undefined,
  payload: unknown,
  requests: NodeInvokeFrame[],
): Promise<void> {
  const frame = payload as NodeInvokeFrame;
  if (!node || !frame.id || !frame.nodeId || !frame.command) {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  requests.push(frame);
  await node.request(
    "node.invoke.result",
    {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: false,
      error: {
        code: "NODE_BACKGROUND_UNAVAILABLE",
        message: "NODE_BACKGROUND_UNAVAILABLE: camera commands require foreground",
      },
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
}

function readQueuedActionId(error: unknown): string {
  const details =
    error && typeof error === "object"
      ? (error as { details?: { queuedActionId?: unknown } }).details
      : undefined;
  if (typeof details?.queuedActionId !== "string" || details.queuedActionId.length === 0) {
    throw new Error(`queued action id missing from invoke error: ${String(error)}`);
  }
  return details.queuedActionId;
}
