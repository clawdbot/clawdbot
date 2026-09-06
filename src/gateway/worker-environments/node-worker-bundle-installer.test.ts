import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_BUNDLE_INSTALL_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createGatewayNodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

const node: NodeWorkerSupervisorNodeProof = {
  nodeId: "node-1",
  connId: "conn-1",
  pairingIdentity: "pairing-1",
  pairingGeneration: "generation-1",
  clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
  clientMode: "node",
  protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  workerHost: { enabled: true, capacity: { total: 2, available: 2 } },
  commands: [],
};
const artifact = {
  install: "bundle" as const,
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.8.1",
  protocolFeatures: [],
  tarballBytes: 123,
  tarballSha256: "b".repeat(64),
  tarballPath: "/gateway/bundle.tgz",
};

const receipt = {
  bundleHash: artifact.bundleHash,
  openclawVersion: artifact.openclawVersion,
  protocolFeatures: artifact.protocolFeatures,
};

function nodeProof(nodeId: string, bundlePrewarm?: 1): NodeWorkerSupervisorNodeProof {
  return {
    ...node,
    nodeId,
    connId: `conn-${nodeId}`,
    workerHost: {
      enabled: true,
      capacity: { total: 2, available: 2 },
      ...(bundlePrewarm === undefined ? {} : { bundlePrewarm: 1 }),
    },
  };
}

describe("Gateway node worker bundle installer", () => {
  it("cancels held node discovery before granting or invoking installation", async () => {
    const discovered = createDeferredCore<NodeWorkerSupervisorNodeProof[]>();
    const controller = new AbortController();
    const transfer = createNodeWorkerBundleTransferService();
    const grant = vi.spyOn(transfer, "prepare");
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async () => ({
      ok: true,
      payload: artifact,
    }));
    const listCurrentNodes = vi.fn(() => discovered.promise);
    const { ensure } = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => ({
        hasCurrentRunner: () => false,
        listCurrentNodes,
        isCurrent: (candidate) => candidate === node,
        invoke,
      }),
      transfer,
    });
    let settled = false;
    const pending = ensure({
      deviceId: node.nodeId,
      artifact,
      prewarm: true,
      signal: controller.signal,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      expect(listCurrentNodes).toHaveBeenCalledOnce();
      controller.abort(new DOMException("Stop node discovery", "AbortError"));
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(grant).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      discovered.resolve([node]);
      await pending;
      grant.mockRestore();
      transfer.closeAll();
    }
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("binds install dispatch to the current node proof and exact receipt", async () => {
    const transfer = createNodeWorkerBundleTransferService({
      generateToken: () => "A".repeat(43),
    });
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (_request) => ({
      ok: true,
      payloadJSON: JSON.stringify({
        bundleHash: artifact.bundleHash,
        openclawVersion: artifact.openclawVersion,
        protocolFeatures: artifact.protocolFeatures,
      }),
    }));
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => false,
      listCurrentNodes: async () => [node],
      isCurrent: (candidate) => candidate === node,
      invoke,
    };
    const { ensure } = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
    });

    await expect(ensure({ deviceId: node.nodeId, artifact, prewarm: true })).resolves.toMatchObject(
      {
        bundleHash: artifact.bundleHash,
      },
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        node,
        command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
        params: expect.objectContaining({ gatewayNamespace: "gateway-test" }),
        idempotencyKey: `gateway-test:${artifact.bundleHash}`,
      }),
    );
    const input = invoke.mock.calls[0]?.[0].params as { archive: { token: string } };
    expect(
      transfer.authorize({ token: input.archive.token, bundleHash: artifact.bundleHash }),
    ).toBeUndefined();
  });

  it("rejects a mismatched node receipt", async () => {
    const transfer = createNodeWorkerBundleTransferService({
      generateToken: () => "B".repeat(43),
    });
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => false,
      listCurrentNodes: async () => [node],
      isCurrent: () => true,
      invoke: async () => ({
        ok: true,
        payloadJSON: JSON.stringify({
          bundleHash: "c".repeat(64),
          openclawVersion: artifact.openclawVersion,
          protocolFeatures: artifact.protocolFeatures,
        }),
      }),
    };
    const { ensure } = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
    });

    await expect(ensure({ deviceId: node.nodeId, artifact, prewarm: true })).rejects.toThrow(
      "mismatched build receipt",
    );
  });

  it("negotiates prewarming independently across a mixed node fleet", async () => {
    const transfer = createNodeWorkerBundleTransferService({
      generateToken: () => String.fromCharCode(65 + invoke.mock.calls.length).repeat(43),
    });
    const advertising = nodeProof("advertising", 1);
    const legacy = nodeProof("legacy");
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => ({
      ok: true,
      payloadJSON: JSON.stringify((request.params as { build: typeof artifact }).build),
    }));
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => false,
      listCurrentNodes: async () => [advertising, legacy],
      isCurrent: () => true,
      invoke,
    };
    const { ensure } = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
    });

    await expect(
      ensure({ deviceId: advertising.nodeId, artifact, prewarm: true }),
    ).resolves.toMatchObject({
      bundleHash: artifact.bundleHash,
    });
    await expect(
      ensure({ deviceId: legacy.nodeId, artifact, prewarm: true }),
    ).resolves.toMatchObject({
      bundleHash: artifact.bundleHash,
    });

    expect(invoke.mock.calls[0]?.[0].params).toMatchObject({ bundlePrewarm: 1 });
    expect(invoke.mock.calls[1]?.[0].params).not.toHaveProperty("bundlePrewarm");
  });

  it("shares a pending host preparation without giving a cancelled Start its custody", async () => {
    const installed = createDeferredCore<{ ok: boolean; payloadJSON: string }>();
    const transfer = createNodeWorkerBundleTransferService();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(() => installed.promise);
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => true,
      listCurrentNodes: async () => [node],
      isCurrent: () => true,
      invoke,
    };
    const installer = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
    });
    const prepared = installer.prepare({ node, artifact });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const cancelled = installer.ensure({
      deviceId: node.nodeId,
      artifact,
      prewarm: true,
      signal: controller.signal,
    });
    const remaining = installer.ensure({ deviceId: node.nodeId, artifact, prewarm: true });
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await cancelledResult;
    expect(invoke.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    installed.resolve({ ok: true, payloadJSON: JSON.stringify(receipt) });
    await Promise.all([prepared, remaining]);
    expect(invoke).toHaveBeenCalledOnce();
    await installer.ensure({ deviceId: node.nodeId, artifact, prewarm: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    await installer.close();
    transfer.closeAll();
  });

  it("fences a replaced connection without delaying its successor", async () => {
    const held = createDeferredCore<{ ok: boolean; payloadJSON: string }>();
    const replacement = { ...node, connId: "replacement", pairingGeneration: "replacement" };
    let current = node;
    const transfer = createNodeWorkerBundleTransferService();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) =>
      request.node === node
        ? await held.promise
        : { ok: true, payloadJSON: JSON.stringify(receipt) },
    );
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => true,
      listCurrentNodes: async () => [current],
      isCurrent: (proof) => proof === current,
      invoke,
    };
    const installer = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
    });
    const old = installer.prepare({ node, artifact });
    const rejected = old.catch((error: unknown) => error);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    current = replacement;
    installer.invalidate(node.nodeId);
    expect(invoke.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await installer.prepare({ node: replacement, artifact });
    expect(invoke).toHaveBeenCalledTimes(2);
    held.resolve({ ok: true, payloadJSON: JSON.stringify(receipt) });
    expect(await rejected).toMatchObject({
      message: "Device worker preparation connection is no longer current",
    });
    await installer.close();
    transfer.closeAll();
  });

  it("does not retry a failed background generation until an explicit Start", async () => {
    const transfer = createNodeWorkerBundleTransferService();
    const invoke = vi
      .fn<NodeWorkerSupervisorTransport["invoke"]>()
      .mockResolvedValueOnce({ ok: false, error: { message: "transfer unavailable" } })
      .mockResolvedValue({ ok: true, payloadJSON: JSON.stringify(receipt) });
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => true,
      listCurrentNodes: async () => [node],
      isCurrent: () => true,
      invoke,
    };
    const warn = vi.fn();
    const installer = createGatewayNodeWorkerBundleInstaller({
      warn,
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
    });
    await expect(installer.prepare({ node, artifact })).rejects.toThrow("transfer unavailable");
    await expect(installer.prepare({ node, artifact })).rejects.toThrow("transfer unavailable");
    expect(invoke).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    await installer.ensure({ deviceId: node.nodeId, artifact, prewarm: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    await installer.close();
    transfer.closeAll();
  });

  it("leaves cloud enrollment cancellation with its environment owner", async () => {
    const controller = new AbortController();
    const transfer = createNodeWorkerBundleTransferService();
    const invoke = vi.fn<NodeWorkerSupervisorTransport["invoke"]>(async (request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort();
      return { ok: true, payloadJSON: JSON.stringify(receipt) };
    });
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => true,
      listCurrentNodes: async () => [node],
      isCurrent: () => true,
      invoke,
    };
    const installer = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
      isEnvironmentOwnedNode: () => true,
    });
    await expect(
      installer.ensure({
        deviceId: node.nodeId,
        artifact,
        prewarm: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow("no longer current");
    await installer.close();
    transfer.closeAll();
  });

  it("rejects a shared preparation when enrollment claims the node without an inventory event", async () => {
    let environmentOwned = false;
    const transfer = createNodeWorkerBundleTransferService();
    const transport: NodeWorkerSupervisorTransport = {
      hasCurrentRunner: () => true,
      listCurrentNodes: async () => [node],
      isCurrent: () => true,
      invoke: async (request) => {
        environmentOwned = true;
        expect(request.isDispatchAuthorized()).toBe(false);
        return { ok: true, payloadJSON: JSON.stringify(receipt) };
      },
    };
    const installer = createGatewayNodeWorkerBundleInstaller({
      gatewayNamespace: "gateway-test",
      getTransport: () => transport,
      transfer,
      isEnvironmentOwnedNode: () => environmentOwned,
    });
    await expect(installer.prepare({ node, artifact })).rejects.toThrow("no longer current");
    await installer.close();
    transfer.closeAll();
  });
});
