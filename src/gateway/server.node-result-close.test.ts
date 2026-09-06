// Node result/close ordering tests keep admitted terminal frames authoritative.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { writeConfigFile } from "../config/config.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { respondToNodeShutdown } from "./node-shutdown.test-support.js";
import { GatewayNodeLifecycleDispatchTracker } from "./server/ws-connection/node-lifecycle-dispatch.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer, writeSessionStore } from "./test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";
import { sessionStoreEntry } from "./test/server-sessions.test-helpers.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider-identity.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

const pairingRead = vi.hoisted(() => ({
  blocked: null as Promise<void> | null,
  onBlocked: null as (() => void) | null,
  release: null as (() => void) | null,
}));

vi.mock("../infra/device-pairing-node-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing-node-state.js")>();
  return {
    ...actual,
    resolveCurrentPairedDeviceNodeBinding: async (nodeId: string) => {
      const current = await actual.resolveCurrentPairedDeviceNodeBinding(nodeId);
      if (pairingRead.blocked) {
        pairingRead.onBlocked?.();
        await pairingRead.blocked;
      }
      return current;
    },
  };
});

installGatewayTestHooks({ scope: "suite" });

const RUNNER_SESSION_ID = "session-runner-socket-close";
const RUNNER_SESSION_KEY = "agent:main:runner-socket-close";
const RUNNER_ENVIRONMENT_ID = "environment-runner-socket-close";
const RUNNER_BUNDLE_HASH = "a".repeat(64);

async function seedActiveDevicePlacement(nodeId: string): Promise<void> {
  const environments = createWorkerEnvironmentStore();
  const placements = createWorkerSessionPlacementStore();
  environments.createIntent({
    environmentId: RUNNER_ENVIRONMENT_ID,
    providerId: DEVICE_WORKER_PROVIDER_ID,
    profileId: `device:${nodeId}`,
    profileSnapshot: { install: "bundle", settings: { device: nodeId } },
    provisionOperationId: `provision:${RUNNER_ENVIRONMENT_ID}`,
  });
  environments.transition({
    environmentId: RUNNER_ENVIRONMENT_ID,
    from: "requested",
    to: "provisioning",
  });
  environments.transition({
    environmentId: RUNNER_ENVIRONMENT_ID,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: `lease:${RUNNER_ENVIRONMENT_ID}`,
      nodeDeviceId: nodeId,
      sshEndpoint: null,
      sharedHost: true,
      bootstrapReceipt: {
        bundleHash: RUNNER_BUNDLE_HASH,
        openclawVersion: "2026.8.19",
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
        installKind: "bundle",
      },
      credential: {
        credentialHash: hashWorkerCredential("runner-socket-close-credential"),
        sessionId: null,
        rpcSetVersion: 1,
        expiresAtMs: Date.now() + 60_000,
      },
    },
  });
  const attached = environments.transition({
    environmentId: RUNNER_ENVIRONMENT_ID,
    from: "ready",
    to: "attached",
    patch: {
      attachedSessionIds: [RUNNER_SESSION_ID],
      credential: {
        credentialHash: hashWorkerCredential("runner-socket-close-session-credential"),
        sessionId: RUNNER_SESSION_ID,
        rpcSetVersion: 1,
        expiresAtMs: Date.now() + 60_000,
      },
    },
  });

  let placement = placements.startDispatch({
    sessionId: RUNNER_SESSION_ID,
    sessionKey: RUNNER_SESSION_KEY,
    agentId: "main",
  });
  placement = placements.transition({
    sessionId: RUNNER_SESSION_ID,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: RUNNER_ENVIRONMENT_ID },
  });
  placement = placements.transition({
    sessionId: RUNNER_SESSION_ID,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { environmentId: RUNNER_ENVIRONMENT_ID, workerBundleHash: RUNNER_BUNDLE_HASH },
  });
  placement = placements.transition({
    sessionId: RUNNER_SESSION_ID,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: {
      environmentId: RUNNER_ENVIRONMENT_ID,
      workerBundleHash: RUNNER_BUNDLE_HASH,
      workspaceBaseManifestRef: "manifest-runner-socket-close",
      remoteWorkspaceDir: "/workspace/runner-socket-close",
    },
  });
  placements.transition({
    sessionId: RUNNER_SESSION_ID,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: {
      environmentId: RUNNER_ENVIRONMENT_ID,
      activeOwnerEpoch: attached.ownerEpoch,
      workerBundleHash: RUNNER_BUNDLE_HASH,
      workspaceBaseManifestRef: "manifest-runner-socket-close",
      remoteWorkspaceDir: "/workspace/runner-socket-close",
    },
  });
  await writeSessionStore({
    entries: { [RUNNER_SESSION_KEY]: sessionStoreEntry(RUNNER_SESSION_ID) },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  pairingRead.blocked = null;
  pairingRead.onBlocked = null;
  pairingRead.release = null;
});

test.each([
  ["a terminal node result admitted before close wins over disconnect cleanup", false],
  ["pairing removal still fences a terminal node result while close drains", true],
] as const)("%s", async (_name, removePairingDuringDrain) => {
  const pairedNode = await pairDeviceIdentity({
    name: "node-result-before-close",
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });
  const pairing = await requestNodePairing({
    nodeId: pairedNode.identity.deviceId,
    platform: "linux",
    deviceFamily: "Linux",
    commands: ["camera.list"],
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write"],
  });
  await writeConfigFile({
    gateway: { nodes: { commands: { allow: ["camera.list"] } } },
  });

  const { port, server } = await startServer("secret");
  const url = `ws://127.0.0.1:${port}`;
  let operator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let node: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let resolveInvokeFrame:
    | ((frame: { id: string; nodeId: string; command: string }) => void)
    | undefined;
  const invokeFrame = new Promise<{ id: string; nodeId: string; command: string }>((resolve) => {
    resolveInvokeFrame = resolve;
  });

  try {
    operator = await connectGatewayClient({
      url,
      token: "secret",
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "node result close operator",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    node = await connectGatewayClient({
      url,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "node result close host",
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "linux",
      deviceFamily: "Linux",
      scopes: [],
      commands: ["camera.list"],
      deviceIdentity: pairedNode.identity,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request" || !event.payload) {
          return;
        }
        resolveInvokeFrame?.(event.payload as { id: string; nodeId: string; command: string });
      },
    });
    const initialInventory = await operator.request<{
      nodes?: Array<{ nodeId?: string; connected?: boolean; commands?: string[] }>;
    }>("node.list", {}, { timeoutMs: 10_000 });
    expect(
      initialInventory.nodes?.find((entry) => entry.nodeId === pairedNode.identity.deviceId),
    ).toEqual(
      expect.objectContaining({
        connected: true,
        commands: ["camera.list"],
      }),
    );

    const invoked = operator.request<{
      ok: boolean;
      nodeId: string;
      command: string;
      payload: unknown;
    }>(
      "node.invoke",
      {
        nodeId: pairedNode.identity.deviceId,
        command: "camera.list",
        timeoutMs: 10_000,
        idempotencyKey: randomUUID(),
      },
      { timeoutMs: 10_000 },
    );
    const frame = await Promise.race([
      invokeFrame,
      invoked.then(
        () => {
          throw new Error("node.invoke settled without sending a node request");
        },
        (error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
      ),
    ]);

    pairingRead.blocked = new Promise<void>((resolve) => {
      pairingRead.release = resolve;
    });
    const pairingReadStarted = new Promise<void>((resolve) => {
      pairingRead.onBlocked = resolve;
    });
    const drainSpy = vi.spyOn(GatewayNodeLifecycleDispatchTracker.prototype, "drain");
    const resultAck = node
      .request(
        "node.invoke.result",
        {
          id: frame.id,
          nodeId: frame.nodeId,
          ok: true,
          payloadJSON: JSON.stringify({ completed: "before-close" }),
        },
        { timeoutMs: 10_000 },
      )
      .catch((error: unknown) => error);
    await pairingReadStarted;
    const rawNodeSocket = Reflect.get(node, "ws") as { terminate?: () => void } | null;
    const stopped = node.stopAndWait({ timeoutMs: 1_000 });
    rawNodeSocket?.terminate?.();
    await stopped;
    node = undefined;
    await vi.waitFor(() => expect(drainSpy).toHaveBeenCalledOnce());
    if (removePairingDuringDrain) {
      await operator.request(
        "node.pair.remove",
        { nodeId: pairedNode.identity.deviceId },
        { timeoutMs: 10_000 },
      );
    }
    pairingRead.release?.();

    if (removePairingDuringDrain) {
      await expect(invoked).rejects.toThrow("node pairing changed while invocation was active");
    } else {
      await expect(invoked).resolves.toMatchObject({
        ok: true,
        nodeId: pairedNode.identity.deviceId,
        command: "camera.list",
        payload: { completed: "before-close" },
      });
    }
    await resultAck;
    await vi.waitFor(async () => {
      const listed = await operator?.request<{
        nodes?: Array<{ nodeId?: string; connected?: boolean }>;
      }>("node.list", {}, { timeoutMs: 10_000 });
      const listedNode = listed?.nodes?.find(
        (entry) => entry.nodeId === pairedNode.identity.deviceId,
      );
      if (removePairingDuringDrain) {
        expect(listedNode).toBeUndefined();
      } else {
        expect(listedNode?.connected).toBe(false);
      }
    });
  } finally {
    releaseBlockedPairingRead();
    await Promise.allSettled([
      ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
      ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
    ]);
    await server.close();
  }
});

test("publishes one runner-availability edge before the socket-close refresh", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("runner availability proof requires the isolated Gateway state directory");
  }
  testState.sessionStorePath = path.join(stateDir, "runner-socket-close-sessions.json");
  const pairedNode = await pairDeviceIdentity({
    name: "runner-availability-close",
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });
  const pairing = await requestNodePairing({
    nodeId: pairedNode.identity.deviceId,
    platform: "linux",
    deviceFamily: "Linux",
    commands: [],
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write"],
  });

  const previousMinimalGateway = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    started = await startServer("secret");
  } finally {
    if (previousMinimalGateway === undefined) {
      delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    } else {
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimalGateway;
    }
  }
  const { port, server } = started;
  const url = `ws://127.0.0.1:${port}`;
  let operator: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let node: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let armed = false;
  let availabilityEvents = 0;
  let resolveOffline!: (value: unknown) => void;
  let rejectOffline!: (reason: unknown) => void;
  const offlineRefresh = new Promise<unknown>((resolve, reject) => {
    resolveOffline = resolve;
    rejectOffline = reject;
  });
  const connectNode = () =>
    connectGatewayClient({
      url,
      token: "secret",
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: "runner availability node",
      mode: GATEWAY_CLIENT_MODES.NODE,
      platform: "linux",
      deviceFamily: "Linux",
      scopes: [],
      commands: [],
      deviceIdentity: pairedNode.identity,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request" || !event.payload || !node) {
          return;
        }
        const frame = event.payload as {
          id: string;
          nodeId: string;
          command: string;
          paramsJSON: string;
        };
        const reply = respondToNodeShutdown(node, frame);
        if (!reply) {
          throw new Error(`unexpected node cleanup command: ${frame.command}`);
        }
        void reply.catch(() => undefined);
      },
    });

  try {
    operator = await connectGatewayClient({
      url,
      token: "secret",
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "runner availability browser",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        if (
          !armed ||
          event.event !== "sessions.changed" ||
          (event.payload as { reason?: string } | undefined)?.reason !== "runner-availability"
        ) {
          return;
        }
        availabilityEvents += 1;
        if (availabilityEvents === 1) {
          void operator
            ?.request("sessions.list", {}, { timeoutMs: 10_000 })
            .then(resolveOffline, rejectOffline);
        }
      },
    });
    await seedActiveDevicePlacement(pairedNode.identity.deviceId);
    node = await connectNode();
    await node.request(
      "node.runnerInventory.update",
      {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 1, available: 1 } },
      },
      { timeoutMs: 10_000 },
    );
    const readRunnerStatus = (result: unknown) => {
      const sessions = (result as { sessions?: Array<Record<string, unknown>> })?.sessions;
      const session = sessions?.find((entry) => entry.sessionId === RUNNER_SESSION_ID) as
        | { placement?: { runner?: { status?: string } } }
        | undefined;
      return session?.placement?.runner?.status;
    };
    const available = await operator.request("sessions.list", {}, { timeoutMs: 10_000 });
    expect(readRunnerStatus(available)).toBe("available");

    armed = true;
    const rawNodeSocket = Reflect.get(node, "ws") as { terminate?: () => void } | null;
    const stopped = node.stopAndWait({ timeoutMs: 1_000 });
    rawNodeSocket?.terminate?.();
    await stopped;
    node = undefined;

    const offline = await offlineRefresh;
    expect(readRunnerStatus(offline)).toBe("offline");
    expect(availabilityEvents).toBe(1);
    expect(
      readRunnerStatus(await operator.request("sessions.list", {}, { timeoutMs: 10_000 })),
    ).toBe("offline");
  } finally {
    try {
      // The offline assertion retains a real worker owner. Reconnect only to acknowledge
      // its physical cleanup; losing transport is not evidence that the worker stopped.
      if (!node) {
        node = await connectNode();
      }
      await node.request("node.runnerInventory.update", {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, capacity: { total: 1, available: 1 }, environmentSession: 1 },
      });
      await server.close();
    } finally {
      await Promise.allSettled([
        ...(node ? [node.stopAndWait({ timeoutMs: 1_000 })] : []),
        ...(operator ? [operator.stopAndWait({ timeoutMs: 1_000 })] : []),
      ]);
    }
  }
});

function releaseBlockedPairingRead(): void {
  pairingRead.release?.();
  pairingRead.onBlocked = null;
  pairingRead.blocked = null;
  pairingRead.release = null;
}
