// Role allowlist update tests cover operator-driven gateway updates, node lists,
// device/node pairing state, restart sentinels, and runtime plugin visibility.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { HealthSummary } from "../commands/health.types.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { approveDevicePairing, listDevicePairing } from "../infra/device-pairing.js";
import { approveNodePairing, requestNodePairing } from "../infra/node-pairing.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { captureEnv, deleteTestEnvValue } from "../test-utils/env.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientName,
} from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";

vi.mock("../infra/update-runner.js", () => ({
  resolveUpdateInstallSurface: vi.fn(async () => ({
    kind: "git",
    mode: "git",
    root: "/repo",
    packageRoot: "/repo",
  })),
  runGatewayUpdate: vi.fn(async () => ({
    status: "ok",
    mode: "git",
    root: "/repo",
    steps: [],
    durationMs: 12,
  })),
}));

import { runGatewayUpdate } from "../infra/update-runner.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, onceMessage, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 5_000, interval: 10 } as const;
type PollWaitOptions = { timeout: number; interval: number };

let ws: WebSocket;
let port: number;

async function withoutSupervisorHints<T>(fn: () => Promise<T>): Promise<T> {
  const envSnapshot = captureEnv([...SUPERVISOR_HINT_ENV_VARS]);
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    deleteTestEnvValue(key);
  }

  try {
    return await fn();
  } finally {
    envSnapshot.restore();
  }
}

function countConnectedNodes(nodes: readonly { connected?: boolean }[] | undefined): number {
  let count = 0;
  for (const node of nodes ?? []) {
    if (node.connected) {
      count++;
    }
  }
  return count;
}

function installCanvasNodePolicyForTest() {
  const registry = getActiveRuntimePluginRegistry();
  if (!registry) {
    throw new Error("active plugin registry is required for canvas node command tests");
  }
  if (
    registry.nodeInvokePolicies.some((entry) => entry.policy.commands.includes("canvas.snapshot"))
  ) {
    return;
  }
  registry.nodeInvokePolicies.push({
    pluginId: "canvas",
    pluginName: "Canvas",
    source: "test",
    rootDir: "extensions/canvas",
    pluginConfig: {},
    policy: {
      commands: ["canvas.snapshot"],
      defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
      foregroundRestrictedOnIos: true,
      handle: (ctx) => ctx.invokeNode(),
    },
  });
}

beforeEach(() => {
  installCanvasNodePolicyForTest();
});

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

const connectNodeClient = async (params: {
  port: number;
  commands: string[];
  platform?: string;
  deviceFamily?: string;
  deviceIdentity?: DeviceIdentity;
  clientName?: GatewayClientName;
  instanceId?: string;
  displayName?: string;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
}) => {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is required for node test clients");
  }
  return await connectGatewayClient({
    url: `ws://127.0.0.1:${params.port}`,
    token,
    role: "node",
    clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    clientDisplayName: params.displayName,
    platform: params.platform ?? "ios",
    deviceFamily: params.deviceFamily,
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: params.instanceId,
    scopes: [],
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    onEvent: params.onEvent,
    timeoutMessage: "timeout waiting for node to connect",
  });
};

function requireNodeId(nodeId: string | undefined, label: string): string {
  if (!nodeId) {
    throw new Error(`expected connected node id for ${label}`);
  }
  return nodeId;
}

const approveAllPendingPairings = async () => {
  const list = await listDevicePairing();
  for (const pending of list.pending) {
    await approveDevicePairing(pending.requestId, {
      callerScopes: pending.scopes ?? ["operator.admin"],
    });
  }
};

function getGatewayTestConfigPath(): string {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required in the gateway test environment");
  }
  return configPath;
}

const connectNodeClientWithPairing = async (params: Parameters<typeof connectNodeClient>[0]) => {
  try {
    return await connectNodeClient(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("pairing required")) {
      throw error;
    }
    await approveAllPendingPairings();
    return await connectNodeClient(params);
  }
};

const connectNodeClientWithNodePairing = async (
  params: Parameters<typeof connectNodeClient>[0],
) => {
  const provisionalClient = await connectNodeClientWithPairing(params);
  const listRes = await rpcReq<{
    nodes?: Array<{ nodeId: string; displayName?: string; connected?: boolean }>;
  }>(ws, "node.list", {});
  const provisionalNode = (listRes.payload?.nodes ?? []).find((node) => {
    if (!node.connected) {
      return false;
    }
    if (params.displayName) {
      return node.displayName === params.displayName;
    }
    return true;
  });
  const nodeId = requireNodeId(provisionalNode?.nodeId, params.displayName ?? "node pairing");

  await provisionalClient.stopAndWait();

  const request = await requestNodePairing({
    nodeId,
    displayName: params.displayName,
    platform: params.platform ?? "ios",
    deviceFamily: params.deviceFamily,
    commands: params.commands,
  });
  await approveNodePairing(request.request.requestId, {
    callerScopes: ["operator.admin", "operator.write"],
  });

  return await connectNodeClient(params);
};

async function findConnectedNodeByDisplayName(displayName: string) {
  const listRes = await rpcReq<{
    nodes?: Array<{
      nodeId: string;
      displayName?: string;
      connected?: boolean;
      commands?: string[];
    }>;
  }>(ws, "node.list", {});
  return (listRes.payload?.nodes ?? []).find(
    (node) => node.connected && node.displayName === displayName,
  );
}

async function findConnectedNodeIdByDisplayName(displayName: string) {
  const node = await findConnectedNodeByDisplayName(displayName);
  return requireNodeId(node?.nodeId, displayName);
}

async function expectConnectedCommands(
  displayName: string,
  commands: string[],
  opts: PollWaitOptions = FAST_WAIT_OPTS,
) {
  await expect
    .poll(async () => {
      const node = await findConnectedNodeByDisplayName(displayName);
      return node?.commands?.toSorted() ?? [];
    }, opts)
    .toEqual(commands);
}

async function expectConnectedNodeCount(count: number) {
  await expect
    .poll(async () => {
      const listRes = await rpcReq<{ nodes?: Array<{ connected?: boolean }> }>(ws, "node.list", {});
      return countConnectedNodes(listRes.payload?.nodes);
    }, FAST_WAIT_OPTS)
    .toBe(count);
}

async function expectPendingPairingCommands(nodeId: string, commands: string[]) {
  const pairingList = await rpcReq<{
    pending?: Array<{ nodeId?: string; commands?: string[] }>;
  }>(ws, "node.pair.list", {});
  expect(pairingList.ok).toBe(true);
  const pending = (pairingList.payload?.pending ?? []).find((entry) => entry.nodeId === nodeId);
  expect(pending?.nodeId).toBe(nodeId);
  expect(pending?.commands).toEqual(commands);
}

async function getPendingNodePairing(nodeId: string) {
  const pairingList = await rpcReq<{
    pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
  }>(ws, "node.pair.list", {});
  expect(pairingList.ok).toBe(true);
  return (pairingList.payload?.pending ?? []).find((entry) => entry.nodeId === nodeId);
}

async function approvePendingNodePairing(nodeId: string, commands: string[]) {
  const pending = await getPendingNodePairing(nodeId);
  expect(pending?.commands).toEqual(commands);
  const approveRes = await rpcReq(ws, "node.pair.approve", { requestId: pending?.requestId });
  expect(approveRes.ok).toBe(true);
  return pending;
}

async function invokeCanvasSnapshot(nodeId: string, idempotencyKey: string) {
  return rpcReq(ws, "node.invoke", {
    nodeId,
    command: "canvas.snapshot",
    params: { format: "png" },
    idempotencyKey,
  });
}

async function expectCanvasSnapshotDenied(nodeId: string, idempotencyKey: string) {
  const res = await invokeCanvasSnapshot(nodeId, idempotencyKey);
  expect(res.ok).toBe(false);
  expect(res.error?.message ?? "").toContain("node command not allowed");
}

function createInvokeCapture() {
  let resolveInvoke: ((payload: { id?: string; nodeId?: string }) => void) | null = null;
  const pendingPayloads: Array<{ id?: string; nodeId?: string }> = [];
  return {
    waitForInvoke: () => {
      const pending = pendingPayloads.shift();
      if (pending) {
        return Promise.resolve(pending);
      }
      if (resolveInvoke) {
        throw new Error("already waiting for a node invoke request");
      }
      return new Promise<{ id?: string; nodeId?: string }>((resolve) => {
        resolveInvoke = resolve;
      });
    },
    onEvent: (evt: { event?: string; payload?: unknown }) => {
      if (evt.event === "node.invoke.request") {
        const payload = evt.payload as { id?: string; nodeId?: string };
        if (resolveInvoke) {
          const resolve = resolveInvoke;
          resolveInvoke = null;
          resolve(payload);
          return;
        }
        pendingPayloads.push(payload);
      }
    },
  };
}

async function respondToInvoke(
  client: GatewayClient,
  payload: { id?: string; nodeId?: string },
  fallbackNodeId: string,
  payloadJSON: string | null = JSON.stringify({ ok: true }),
) {
  await client.request("node.invoke.result", {
    id: payload.id ?? "",
    nodeId: payload.nodeId ?? fallbackNodeId,
    ok: true,
    payloadJSON,
  });
}

function createDeviceIdentityForTest(prefix: string) {
  return loadOrCreateDeviceIdentity(
    path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
  );
}

describe("gateway role enforcement", () => {
  test("enforces operator and node permissions", async () => {
    let nodeClient: GatewayClient | undefined;

    try {
      const eventRes = await rpcReq(ws, "node.event", { event: "test", payload: { ok: true } });
      expect(eventRes.ok).toBe(false);
      expect(eventRes.error?.message ?? "").toContain("unauthorized role");

      const invokeRes = await rpcReq(ws, "node.invoke.result", {
        id: "invoke-1",
        nodeId: "node-1",
        ok: true,
      });
      expect(invokeRes.ok).toBe(false);
      expect(invokeRes.error?.message ?? "").toContain("unauthorized role");

      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: [],
        instanceId: "node-role-enforcement",
        displayName: "node-role-enforcement",
      });

      const binsPayload = await nodeClient.request("skills.bins", {});
      expect(Array.isArray(binsPayload?.bins)).toBe(true);

      await expect(nodeClient.request("status", {})).rejects.toThrow("unauthorized role");

      const healthPayload = await nodeClient.request<HealthSummary>("health", {});
      expect(healthPayload.ok).toBe(true);
    } finally {
      nodeClient?.stop();
    }
  });
});

describe("gateway update.run", () => {
  test("writes sentinel and schedules restart", async () => {
    await withoutSupervisorHints(async () => {
      const sigusr1 = vi.fn();
      process.on("SIGUSR1", sigusr1);

      try {
        const id = "req-update";
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method: "update.run",
            params: {
              sessionKey: "agent:main:whatsapp:dm:+15555550123",
              restartDelayMs: 0,
            },
          }),
        );
        const res = await onceMessage(ws, (o) => o.type === "res" && o.id === id);
        expect(res.ok).toBe(true);

        await vi.waitFor(() => {
          expect(sigusr1.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);
        expect(sigusr1).toHaveBeenCalled();

        const sentinel = await readRestartSentinel();
        expect(sentinel?.payload.kind).toBe("update");
        expect(sentinel?.payload.stats?.mode).toBe("git");
      } finally {
        process.off("SIGUSR1", sigusr1);
      }
    });
  });

  test("uses configured update channel", async () => {
    await withoutSupervisorHints(async () => {
      const sigusr1 = vi.fn();
      process.on("SIGUSR1", sigusr1);

      try {
        const configPath = getGatewayTestConfigPath();
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({ update: { channel: "beta" } }, null, 2));
        const updateMock = vi.mocked(runGatewayUpdate);
        updateMock.mockClear();

        const id = "req-update-channel";
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method: "update.run",
            params: {
              restartDelayMs: 0,
            },
          }),
        );
        const res = await onceMessage(ws, (o) => o.type === "res" && o.id === id);
        expect(res.ok).toBe(true);
        await vi.waitFor(() => {
          expect(updateMock).toHaveBeenCalledOnce();
        }, FAST_WAIT_OPTS);
        await vi.waitFor(() => {
          expect(sigusr1).toHaveBeenCalled();
        }, FAST_WAIT_OPTS);
      } finally {
        process.off("SIGUSR1", sigusr1);
      }
    });
  });
});

describe("gateway node command allowlist", () => {
  test("enforces command allowlists across node clients", async () => {
    const waitForConnectedCount = async (count: number) => {
      await expect
        .poll(async () => {
          const listRes = await rpcReq<{
            nodes?: Array<{ nodeId: string; connected?: boolean }>;
          }>(ws, "node.list", {});
          return countConnectedNodes(listRes.payload?.nodes);
        }, FAST_WAIT_OPTS)
        .toBe(count);
    };

    const getConnectedNodeId = async () => {
      const listRes = await rpcReq<{ nodes?: Array<{ nodeId: string; connected?: boolean }> }>(
        ws,
        "node.list",
        {},
      );
      return requireNodeId(
        listRes.payload?.nodes?.find((node) => node.connected)?.nodeId,
        "allowlist invocation",
      );
    };

    let systemClient: GatewayClient | undefined;
    let emptyClient: GatewayClient | undefined;
    let allowedClient: GatewayClient | undefined;
    const invokeCapture = createInvokeCapture();

    try {
      const systemDeviceIdentity = loadOrCreateDeviceIdentity(
        path.join(os.tmpdir(), `openclaw-node-system-run-${Date.now()}-${Math.random()}.json`),
      );
      const emptyDeviceIdentity = loadOrCreateDeviceIdentity(
        path.join(os.tmpdir(), `openclaw-node-empty-${Date.now()}-${Math.random()}.json`),
      );
      const allowedDeviceIdentity = loadOrCreateDeviceIdentity(
        path.join(os.tmpdir(), `openclaw-node-allowed-${Date.now()}-${Math.random()}.json`),
      );

      systemClient = await connectNodeClientWithPairing({
        port,
        commands: ["system.run"],
        instanceId: "node-system-run",
        displayName: "node-system-run",
        deviceIdentity: systemDeviceIdentity,
      });
      const systemNodeId = await getConnectedNodeId();
      const disallowedRes = await rpcReq(ws, "node.invoke", {
        nodeId: systemNodeId,
        command: "system.run",
        params: { command: "echo hi" },
        idempotencyKey: "allowlist-1",
      });
      expect(disallowedRes.ok).toBe(false);
      expect(disallowedRes.error?.message).toContain("node command not allowed");
      await systemClient.stopAndWait();
      await waitForConnectedCount(0);

      emptyClient = await connectNodeClientWithPairing({
        port,
        commands: [],
        instanceId: "node-empty",
        displayName: "node-empty",
        deviceIdentity: emptyDeviceIdentity,
      });
      const emptyNodeId = await getConnectedNodeId();
      const missingRes = await rpcReq(ws, "node.invoke", {
        nodeId: emptyNodeId,
        command: "canvas.snapshot",
        params: {},
        idempotencyKey: "allowlist-2",
      });
      expect(missingRes.ok).toBe(false);
      expect(missingRes.error?.message).toContain("node command not allowed");
      await emptyClient.stopAndWait();
      await waitForConnectedCount(0);

      allowedClient = await connectNodeClientWithNodePairing({
        port,
        commands: ["canvas.snapshot"],
        instanceId: "node-allowed",
        displayName: "node-allowed",
        deviceIdentity: allowedDeviceIdentity,
        onEvent: invokeCapture.onEvent,
      });
      const allowedNodeId = await getConnectedNodeId();

      const invokeResP = rpcReq(ws, "node.invoke", {
        nodeId: allowedNodeId,
        command: "canvas.snapshot",
        params: { format: "png" },
        idempotencyKey: "allowlist-3",
      });
      const payload = await invokeCapture.waitForInvoke();
      const requestId = payload?.id ?? "";
      const nodeIdFromReq = payload?.nodeId ?? "node-allowed";
      await allowedClient.request("node.invoke.result", {
        id: requestId,
        nodeId: nodeIdFromReq,
        ok: true,
        payloadJSON: JSON.stringify({ ok: true }),
      });
      const invokeRes = await invokeResP;
      expect(invokeRes.ok).toBe(true);

      const invokeNullResP = rpcReq(ws, "node.invoke", {
        nodeId: allowedNodeId,
        command: "canvas.snapshot",
        params: { format: "png" },
        idempotencyKey: "allowlist-null-payloadjson",
      });
      const payloadNull = await invokeCapture.waitForInvoke();
      const requestIdNull = payloadNull?.id ?? "";
      const nodeIdNull = payloadNull?.nodeId ?? "node-allowed";
      await allowedClient.request("node.invoke.result", {
        id: requestIdNull,
        nodeId: nodeIdNull,
        ok: true,
        payloadJSON: null,
      });
      const invokeNullRes = await invokeNullResP;
      expect(invokeNullRes.ok).toBe(true);
    } finally {
      await systemClient?.stopAndWait();
      await emptyClient?.stopAndWait();
      await allowedClient?.stopAndWait();
    }
  });

  test("hides allowlisted declared commands before node pairing is approved", async () => {
    const displayName = "node-device-paired-only";
    let nodeClient: GatewayClient | undefined;

    try {
      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot", "system.run"],
        platform: "macos",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
      });

      await expectConnectedCommands(displayName, []);

      const nodeId = await findConnectedNodeIdByDisplayName(displayName);

      await expectPendingPairingCommands(nodeId, ["canvas.snapshot", "system.run"]);
      await expectCanvasSnapshotDenied(nodeId, "pending-node-canvas");
    } finally {
      await nodeClient?.stopAndWait();
    }
  });

  test("refreshes live commands when pending node pairing is approved", async () => {
    const displayName = "node-approve-live-commands";
    let nodeClient: GatewayClient | undefined;
    const invokeCapture = createInvokeCapture();

    try {
      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot"],
        platform: "macos",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
        onEvent: invokeCapture.onEvent,
      });

      await expectConnectedCommands(displayName, []);

      const nodeId = await findConnectedNodeIdByDisplayName(displayName);

      await approvePendingNodePairing(nodeId, ["canvas.snapshot"]);

      await expectConnectedCommands(displayName, ["canvas.snapshot"], {
        timeout: 2_000,
        interval: 10,
      });

      const invokeResP = invokeCanvasSnapshot(nodeId, "approved-live-node-command");
      await respondToInvoke(nodeClient, await invokeCapture.waitForInvoke(), nodeId);
      const invokeRes = await invokeResP;
      expect(invokeRes.ok).toBe(true);
    } finally {
      await nodeClient?.stopAndWait();
    }
  });

  test("rechecks current allowlist before exposing approved live commands", async () => {
    const displayName = "node-approve-live-commands-current-allowlist";
    let nodeClient: GatewayClient | undefined;
    let configPath: string | undefined;

    try {
      const deviceIdentity = createDeviceIdentityForTest("openclaw-node-current-allowlist");
      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot"],
        platform: "macos",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });

      await expectConnectedCommands(displayName, []);

      const nodeId = await findConnectedNodeIdByDisplayName(displayName);

      configPath = getGatewayTestConfigPath();
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ gateway: { nodes: { denyCommands: ["canvas.snapshot"] } } }, null, 2),
      );

      await approvePendingNodePairing(nodeId, ["canvas.snapshot"]);

      await expectConnectedCommands(displayName, []);

      await expectCanvasSnapshotDenied(nodeId, "stale-allowlist-canvas-snapshot");
    } finally {
      if (configPath) {
        await fs.writeFile(configPath, "{}\n");
      }
      await nodeClient?.stopAndWait();
    }
  });

  test("records only allowlisted commands in pending node pairing requests", async () => {
    const deviceIdentity = createDeviceIdentityForTest("openclaw-allowlisted-pending");
    const displayName = "node-pending-allowlisted-only";
    let nodeClient: GatewayClient | undefined;

    try {
      nodeClient = await connectNodeClientWithPairing({
        port,
        commands: ["system.run", "canvas.snapshot"],
        platform: "İOS",
        deviceFamily: "iPhone",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });

      const nodeId = await findConnectedNodeIdByDisplayName(displayName);

      await expectPendingPairingCommands(nodeId, ["canvas.snapshot"]);
    } finally {
      await nodeClient?.stopAndWait();
    }
  });

  test("rejects reconnect metadata spoof for paired node devices", async () => {
    const deviceIdentity = createDeviceIdentityForTest("openclaw-spoof-test-device");

    let iosClient: GatewayClient | undefined;
    try {
      iosClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot"],
        platform: "ios",
        deviceFamily: "iPhone",
        instanceId: "node-platform-pin",
        displayName: "node-platform-pin",
        deviceIdentity,
      });
      await iosClient.stopAndWait();
      await expectConnectedNodeCount(0);

      await expect(
        connectNodeClient({
          port,
          commands: ["system.run"],
          platform: "linux",
          deviceFamily: "linux",
          instanceId: "node-platform-pin",
          displayName: "node-platform-pin",
          deviceIdentity,
        }),
      ).rejects.toThrow(/device metadata change pending approval/i);
    } finally {
      await iosClient?.stopAndWait();
    }
  });

  test("does not promote paired desktop client id changes into host command defaults", async () => {
    const deviceIdentity = createDeviceIdentityForTest("openclaw-client-id-promotion");
    const displayName = "node-client-id-promotion";

    let macClient: GatewayClient | undefined;
    let spoofClient: GatewayClient | undefined;
    let secondSpoofClient: GatewayClient | undefined;
    try {
      macClient = await connectNodeClientWithNodePairing({
        port,
        clientName: GATEWAY_CLIENT_NAMES.MACOS_APP,
        commands: ["canvas.snapshot"],
        platform: "macos",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });
      await macClient.stopAndWait();

      spoofClient = await connectNodeClient({
        port,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        commands: ["system.run"],
        platform: "macos",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });
      await expectConnectedCommands(displayName, []);
      await spoofClient.stopAndWait();

      secondSpoofClient = await connectNodeClient({
        port,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        commands: ["system.run"],
        platform: "macos",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });
      await expectConnectedCommands(displayName, []);
    } finally {
      await secondSpoofClient?.stopAndWait();
      await spoofClient?.stopAndWait();
      await macClient?.stopAndWait();
    }
  });

  test("allows canonical node-host reconnect for legacy pinned platform metadata", async () => {
    const deviceIdentity = createDeviceIdentityForTest("openclaw-node-host-platform-upgrade");
    const displayName = "node-host-platform-upgrade";

    let legacyClient: GatewayClient | undefined;
    let upgradedClient: GatewayClient | undefined;
    try {
      legacyClient = await connectNodeClientWithPairing({
        port,
        commands: ["canvas.snapshot"],
        platform: "darwin",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });
      await legacyClient.stopAndWait();
      await expectConnectedNodeCount(0);

      upgradedClient = await connectNodeClient({
        port,
        commands: ["system.run"],
        platform: "macos",
        deviceFamily: "Mac",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });

      await expect
        .poll(async () => {
          const node = await findConnectedNodeByDisplayName(displayName);
          return node?.connected ?? false;
        }, FAST_WAIT_OPTS)
        .toBe(true);

      const node = await findConnectedNodeByDisplayName(displayName);
      const nodeId = requireNodeId(node?.nodeId, displayName);
      const pending = await getPendingNodePairing(nodeId);
      expect(pending?.commands).toEqual(["system.run"]);
    } finally {
      await upgradedClient?.stopAndWait();
      await legacyClient?.stopAndWait();
    }
  });

  test("filters system.run for confusable iOS metadata at connect time", async () => {
    const deviceIdentity = createDeviceIdentityForTest("openclaw-confusable-node-greek-omicron");
    const displayName = "node-greek-omicron-family";

    let client: GatewayClient | undefined;
    try {
      client = await connectNodeClientWithNodePairing({
        port,
        commands: ["system.run", "canvas.snapshot"],
        platform: "ios",
        deviceFamily: "iPhοne",
        instanceId: displayName,
        displayName,
        deviceIdentity,
      });

      await expectConnectedCommands(displayName, ["canvas.snapshot"], {
        timeout: 2_000,
        interval: 10,
      });

      const nodeId = await findConnectedNodeIdByDisplayName(displayName);

      const systemRunRes = await rpcReq(ws, "node.invoke", {
        nodeId,
        command: "system.run",
        params: { command: "echo blocked" },
        idempotencyKey: "allowlist-confusable-greek-omicron",
      });
      expect(systemRunRes.ok).toBe(false);
      expect(systemRunRes.error?.message ?? "").toContain("node command not allowed");
    } finally {
      await client?.stopAndWait();
    }
  });
});
