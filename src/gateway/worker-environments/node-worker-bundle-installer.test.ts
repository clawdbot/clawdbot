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
    const ensure = createGatewayNodeWorkerBundleInstaller({
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
    const ensure = createGatewayNodeWorkerBundleInstaller({
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
    const ensure = createGatewayNodeWorkerBundleInstaller({
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
    const ensure = createGatewayNodeWorkerBundleInstaller({
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
});
