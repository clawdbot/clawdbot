// Proves node-local exec approval relay through real Gateway WebSockets.
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
const NODE_COMMANDS = ["system.execApprovals.get", "system.execApprovals.set"];

type GatewayHandle = QaGatewayChild;
type GatewayEvent = { event?: string; payload?: unknown };
type NodeInvokeFrame = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
};

const initialSnapshot = {
  enabled: true,
  hash: "sha256:current",
  baseHash: "sha256:current",
  defaultAction: "deny",
  constraints: {
    baseHashRequired: true,
    defaultAllowAllowed: false,
    broadAllowRulesAllowed: false,
    dangerousAllowRulesAllowed: false,
  },
  rules: [{ pattern: "hostname", action: "allow", enabled: true }],
} as const;

describe("Gateway node exec approvals", () => {
  it(
    "relays exact policy snapshots and binds results to the current paired connection",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const gatewayOwner = createQaGatewayChild();
      gatewayOwners.push(gatewayOwner);
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        useRepoCli: true,
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
        path: path.join(gateway.tempRoot, "node-exec-approvals.sqlite"),
      });
      const firstInbox = createInvokeInbox();
      const replacementInbox = createInvokeInbox();
      let operator: GatewayClient | undefined;
      let firstNode: GatewayClient | undefined;
      let replacementNode: GatewayClient | undefined;

      try {
        operator = await connectOperator(gateway);
        firstNode = await connectPairedNode({
          gateway,
          identity,
          operator,
          onEvent: (event) => firstInbox.onEvent(event),
        });

        replacementNode = await connectNode({
          gateway,
          identity,
          onEvent: (event) => replacementInbox.onEvent(event),
        });
        await waitForConnectedNode(operator, identity.deviceId, gateway.logs);

        const getResultPromise = operator.request<typeof initialSnapshot>(
          "exec.approvals.node.get",
          { nodeId: identity.deviceId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        const getFrame = await replacementInbox.next();
        expect(getFrame).toMatchObject({
          nodeId: identity.deviceId,
          command: "system.execApprovals.get",
        });
        expect(parseParams(getFrame)).toEqual({});
        expect(firstInbox.seen()).toEqual([]);

        await expect(
          firstNode.request(
            "node.invoke.result",
            {
              id: getFrame.id,
              nodeId: identity.deviceId,
              ok: true,
              payloadJSON: JSON.stringify({ enabled: false, message: "stale connection" }),
            },
            { timeoutMs: REQUEST_TIMEOUT_MS },
          ),
        ).rejects.toThrow("node pairing changed before request dispatch");

        await respondToInvoke(replacementNode, getFrame, initialSnapshot);
        await expect(getResultPromise).resolves.toEqual(initialSnapshot);

        const nextPolicy = {
          defaultAction: "prompt" as const,
          rules: [
            {
              pattern: "git status",
              action: "allow" as const,
              shells: ["powershell"],
              enabled: true,
            },
          ],
        };
        const setResultPromise = operator.request<{ hash: string; updated: boolean }>(
          "exec.approvals.node.set",
          {
            nodeId: identity.deviceId,
            native: nextPolicy,
            baseHash: initialSnapshot.baseHash,
          },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        const setFrame = await replacementInbox.next();
        expect(setFrame).toMatchObject({
          nodeId: identity.deviceId,
          command: "system.execApprovals.set",
        });
        expect(parseParams(setFrame)).toEqual({
          ...nextPolicy,
          baseHash: initialSnapshot.baseHash,
        });
        const updated = { updated: true, hash: "sha256:next" };
        await respondToInvoke(replacementNode, setFrame, updated);
        await expect(setResultPromise).resolves.toEqual(updated);

        const invalidGetPromise = operator.request(
          "exec.approvals.node.get",
          { nodeId: identity.deviceId },
          { timeoutMs: REQUEST_TIMEOUT_MS },
        );
        const invalidGetFrame = await replacementInbox.next();
        await respondToInvoke(replacementNode, invalidGetFrame, {
          enabled: true,
          hash: "sha256:invalid",
          rules: [],
        });
        await expect(invalidGetPromise).rejects.toThrow(
          "node returned invalid exec approvals payload",
        );
      } finally {
        await Promise.allSettled([
          ...(replacementNode ? [replacementNode.stopAndWait({ timeoutMs: 1_000 })] : []),
          ...(firstNode ? [firstNode.stopAndWait({ timeoutMs: 1_000 })] : []),
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
    clientDisplayName: "Gateway node approval QA operator",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    deviceIdentity: null,
  });
}

async function connectPairedNode(params: {
  gateway: GatewayHandle;
  identity: DeviceIdentity;
  operator: GatewayClient;
  onEvent: (event: GatewayEvent) => void;
}): Promise<GatewayClient> {
  try {
    return await connectNode(params);
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
    await approvePendingNodePairing(params.operator, params.identity.deviceId);
    return await connectNode(params);
  }
}

async function connectNode(params: {
  gateway: GatewayHandle;
  identity: DeviceIdentity;
  onEvent: (event: GatewayEvent) => void;
}): Promise<GatewayClient> {
  return await connectClient({
    gateway: params.gateway,
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: "Windows exec approval node",
    mode: GATEWAY_CLIENT_MODES.NODE,
    platform: "windows",
    deviceFamily: "Windows",
    scopes: [],
    caps: ["system"],
    commands: NODE_COMMANDS,
    deviceIdentity: params.identity,
    onEvent: params.onEvent,
  });
}

async function connectClient(params: {
  gateway: GatewayHandle;
  role: "operator" | "node";
  clientName: typeof GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT | typeof GATEWAY_CLIENT_NAMES.NODE_HOST;
  clientDisplayName: string;
  mode: typeof GATEWAY_CLIENT_MODES.BACKEND | typeof GATEWAY_CLIENT_MODES.NODE;
  scopes: string[];
  platform?: string;
  deviceFamily?: string;
  caps?: string[];
  commands?: string[];
  deviceIdentity: DeviceIdentity | null;
  onEvent?: (event: GatewayEvent) => void;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (client: GatewayClient, error?: Error) => {
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
      deviceIdentity: params.deviceIdentity,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onEvent: params.onEvent,
      onHelloOk: () => finish(client),
      onConnectError: (error) => finish(client, error),
      onClose: (code, reason) => finish(client, new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () =>
        finish(client, new Error(`Gateway client connection timed out:\n${params.gateway.logs()}`)),
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
  const approval = await operator.request<{
    requestId: string;
    node: { nodeId: string; commands?: string[]; approvedAtMs?: number };
  }>("node.pair.approve", { requestId: nodeRequestId }, { timeoutMs: REQUEST_TIMEOUT_MS });
  expect(approval).toMatchObject({
    requestId: nodeRequestId,
    node: {
      nodeId,
      commands: NODE_COMMANDS,
      approvedAtMs: expect.any(Number),
    },
  });
}

async function waitForConnectedNode(
  operator: GatewayClient,
  nodeId: string,
  logs: () => string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      await approvePendingNodeSurface(operator, nodeId);
      const result = await operator.request<{
        nodes?: Array<{
          nodeId?: string;
          connected?: boolean;
          paired?: boolean;
          commands?: string[];
          pendingDeclaredCommands?: string[];
          approvalState?: string;
        }>;
      }>("node.list", {}, { timeoutMs: REQUEST_TIMEOUT_MS });
      expect(
        result.nodes?.find((entry) => entry.nodeId === nodeId),
        logs(),
      ).toMatchObject({
        nodeId,
        connected: true,
        paired: true,
        commands: NODE_COMMANDS,
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
    if (pending.nodeId !== nodeId || !pending.requestId) {
      continue;
    }
    const approval = await operator.request<{
      node: { nodeId: string; commands?: string[]; approvedAtMs?: number };
    }>("node.pair.approve", { requestId: pending.requestId }, { timeoutMs: REQUEST_TIMEOUT_MS });
    expect(approval.node).toMatchObject({
      nodeId,
      commands: NODE_COMMANDS,
      approvedAtMs: expect.any(Number),
    });
  }
}

function createInvokeInbox() {
  const frames: NodeInvokeFrame[] = [];
  const waiters: Array<(frame: NodeInvokeFrame) => void> = [];
  return {
    onEvent(event: GatewayEvent) {
      if (event.event !== "node.invoke.request") {
        return;
      }
      const frame = parseInvokeFrame(event.payload);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        frames.push(frame);
      }
    },
    async next(): Promise<NodeInvokeFrame> {
      const frame = frames.shift();
      if (frame) {
        return frame;
      }
      return await new Promise<NodeInvokeFrame>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for node.invoke.request")),
          REQUEST_TIMEOUT_MS,
        );
        timeout.unref();
        waiters.push((nextFrame) => {
          clearTimeout(timeout);
          resolve(nextFrame);
        });
      });
    },
    seen(): readonly NodeInvokeFrame[] {
      return frames;
    },
  };
}

function parseInvokeFrame(payload: unknown): NodeInvokeFrame {
  if (!payload || typeof payload !== "object") {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  const frame = payload as Partial<NodeInvokeFrame>;
  if (!frame.id || !frame.nodeId || !frame.command) {
    throw new Error(`invalid node.invoke.request: ${JSON.stringify(payload)}`);
  }
  return {
    id: frame.id,
    nodeId: frame.nodeId,
    command: frame.command,
    paramsJSON: frame.paramsJSON,
  };
}

function parseParams(frame: NodeInvokeFrame): unknown {
  return frame.paramsJSON ? JSON.parse(frame.paramsJSON) : undefined;
}

async function respondToInvoke(
  node: GatewayClient,
  frame: NodeInvokeFrame,
  payload: unknown,
): Promise<void> {
  await node.request(
    "node.invoke.result",
    {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON: JSON.stringify(payload),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
}
