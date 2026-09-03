import { describe, expect, it, vi } from "vitest";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import * as nodeTunnelSupport from "./node-worker-tunnel.test-support.js";
import * as support from "./service.test-support.js";

async function disconnectedNodeOwner(environmentId: string, sharedHost: boolean | null = false) {
  const deviceId = `node:${environmentId}`;
  support.seedReadyNodeDesktop(environmentId);
  const attached = support.testState.store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: {
      ...support.attachedPatch(environmentId, "session-destroyed"),
      ...(sharedHost === null ? {} : { sharedHost }),
    },
  });
  const transport = nodeTunnelSupport.transport();
  const connectedNodes = await transport.listCurrentNodes();
  for (const node of connectedNodes) {
    node.nodeId = deviceId;
  }
  const listNodes = vi.fn<typeof transport.listCurrentNodes>(async () => []);
  transport.listCurrentNodes = listNodes;
  const workspaceTransfer = nodeTunnelSupport.workspaceTransfer();
  workspaceTransfer.closeAll = vi.fn(async () => {});
  const nodeTunnels = createNodeWorkerTunnelManager({
    gatewayDeviceId: "gateway-1",
    getEnvironment: (id) => support.testState.store.get(id),
    listEnvironments: () => support.testState.store.list(),
    getTransport: () => transport,
    launchNodeWorker: vi.fn(),
    validateWorkerTurn: () => false,
    workspaceTransfer,
  });
  return {
    attached,
    nodeTunnels,
    listNodes,
    workspaceTransfer,
    start: () =>
      nodeTunnels.start({
        environmentId,
        ownerEpoch: attached.ownerEpoch,
        deviceId,
        sessionId: "session-destroyed",
        executionMode: "worker-turn",
        expectedBuild: support.BOOTSTRAP_RECEIPT,
      }),
    reconnect: () => listNodes.mockResolvedValue(connectedNodes),
  };
}

describe("worker provider node teardown", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each(["retained", "restarted"] as const)(
    "cleans the %s node owner after the provider proves the machine is destroyed",
    async (owner) => {
      const environmentId = `worker-destroyed-node-${owner}`;
      const { attached, nodeTunnels, listNodes, workspaceTransfer, start, reconnect } =
        await disconnectedNodeOwner(environmentId);
      const provider = support.createProvider({
        supportedExecutionModes: ["worker-turn", "remote-exec"],
        inspect: async () => ({ status: "destroyed" }),
      });
      const service = support.createService(provider, { nodeTunnelManager: nodeTunnels });
      try {
        if (owner === "retained") {
          await start();
          await expect(nodeTunnels.stop(environmentId, attached.ownerEpoch)).rejects.toThrow(
            "not connected",
          );
        }
        listNodes.mockClear();
        vi.mocked(workspaceTransfer.close).mockClear();

        await service.reconcileOnce();

        expect(support.testState.store.get(environmentId)).toMatchObject({
          state: "failed",
          attachedSessionIds: [],
          leaseId: null,
          nodeDeviceId: null,
          lastError: "Worker environment disappeared before teardown was requested",
        });
        await nodeTunnels.stopAll();
        expect(listNodes).not.toHaveBeenCalled();
        expect(workspaceTransfer.close).toHaveBeenCalledWith(environmentId);
      } finally {
        reconnect();
      }
    },
  );

  it.each(["destroy", "reconcile"] as const)(
    "destroys a disconnected dedicated lease without losing retry ownership via %s",
    async (retry) => {
      const environmentId = "worker-offline-destroy";
      const { attached, nodeTunnels, listNodes, start, reconnect } =
        await disconnectedNodeOwner(environmentId);
      const destroy = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error("provider destruction is indeterminate"));
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          inspect: async () => ({ status: "unknown" }),
          destroy,
        }),
        { nodeTunnelManager: nodeTunnels },
      );
      try {
        await start();
        await expect(service.destroy(environmentId)).rejects.toMatchObject({
          code: "provider_failure",
        });
        expect(nodeTunnels.status(environmentId)).toBe("stopped");
        expect(support.testState.store.get(environmentId)).toMatchObject({
          state: "attached",
          ownerEpoch: attached.ownerEpoch,
          attachedSessionIds: ["session-destroyed"],
          destroyRequestedAtMs: support.testState.nowMs,
        });
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();

        if (retry === "destroy") {
          await service.destroy(environmentId);
        } else {
          await service.reconcileOnce();
        }
        expect(support.testState.store.get(environmentId)?.state).toBe("destroyed");
        expect(destroy).toHaveBeenCalledTimes(2);
        await nodeTunnels.stopAll();
        expect(listNodes).not.toHaveBeenCalled();
      } finally {
        reconnect();
      }
    },
  );

  it.each([
    { sharedHost: true, providersEnabled: true },
    { sharedHost: true, providersEnabled: false },
    { sharedHost: null, providersEnabled: true },
    { sharedHost: null, providersEnabled: false },
  ])(
    "requires confirmed worker stop before retiring a disconnected lease ($sharedHost, provider=$providersEnabled)",
    async ({ sharedHost, providersEnabled }) => {
      const environmentId = "worker-offline-shared-destroy";
      const { nodeTunnels, reconnect } = await disconnectedNodeOwner(environmentId, sharedHost);
      const destroy = vi.fn(async () => {});
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          destroy,
        }),
        { nodeTunnelManager: nodeTunnels },
      );
      support.testState.providersEnabled = providersEnabled;
      try {
        await expect(service.destroy(environmentId)).rejects.toThrow("not connected");
        expect(destroy).not.toHaveBeenCalled();
        expect(support.testState.store.get(environmentId)?.state).toBe("attached");
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
      } finally {
        reconnect();
      }
    },
  );

  it.each([
    { status: "destroyed", isolation: "shared", sharedHost: true },
    { status: "destroyed", isolation: "unknown", sharedHost: null },
    { status: "unknown", isolation: "shared", sharedHost: true },
    { status: "unknown", isolation: "unknown", sharedHost: null },
  ] as const)(
    "requires exact worker stop for a $status lease with $isolation host isolation",
    async ({ status, sharedHost }) => {
      const environmentId = "worker-inspected-destroyed-shared";
      const { attached, nodeTunnels, start, reconnect } = await disconnectedNodeOwner(
        environmentId,
        sharedHost,
      );
      const destroy = vi.fn(async () => {});
      const lastError =
        status === "unknown"
          ? "Worker provider no longer recognizes the lease"
          : "Worker environment disappeared before teardown was requested";
      const service = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          inspect: async () => ({ status }),
          destroy,
        }),
        { nodeTunnelManager: nodeTunnels },
      );
      try {
        await start();
        await service.reconcileOnce();

        expect(support.testState.store.get(environmentId)).toMatchObject({
          state: "attached",
          ownerEpoch: attached.ownerEpoch,
          attachedSessionIds: ["session-destroyed"],
          nodeDeviceId: attached.nodeDeviceId,
          leaseId: attached.leaseId,
          destroyRequestedAtMs: support.testState.nowMs,
          teardownTerminalState: "failed",
          lastError,
        });
        expect(support.testState.store.getCredential(environmentId)).toBeUndefined();
        expect(destroy).not.toHaveBeenCalled();

        reconnect();
        await service.reconcileOnce();

        expect(support.testState.store.get(environmentId)).toMatchObject({
          state: "failed",
          attachedSessionIds: [],
          nodeDeviceId: null,
          leaseId: null,
          lastError,
        });
        expect(destroy).toHaveBeenCalledTimes(status === "unknown" ? 1 : 0);
      } finally {
        reconnect();
      }
    },
  );
});
