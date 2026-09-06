import { WORKER_BUNDLE_PREWARM_VERSION } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { NODE_WORKER_BUNDLE_INSTALL_COMMAND } from "../../infra/node-commands.js";
import { parseNodeWorkerBundleInstallResult } from "../../worker/node-bundle-install-protocol.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { NodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;
type InstallRequest = {
  node: NodeWorkerSupervisorNodeProof;
  artifact: WorkerBundleArtifact;
  prewarm: boolean;
  signal?: AbortSignal;
  isAuthorized?: () => boolean;
};

export type NodeWorkerBundlePreparation = {
  currentArtifact: () => Promise<WorkerBundleArtifact>;
  isEnvironmentOwnedNode: (nodeId: string) => boolean;
  prepare: (params: Omit<InstallRequest, "prewarm" | "isAuthorized">) => Promise<void>;
  invalidate: (nodeId?: string) => void;
};

export function createGatewayNodeWorkerBundleInstaller(options: {
  gatewayNamespace: string;
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  transfer: NodeWorkerBundleTransferService;
  isEnvironmentOwnedNode?: (nodeId: string) => boolean;
  warn?: (message: string) => void;
}) {
  const install = async (params: InstallRequest, transport: NodeWorkerSupervisorTransport) => {
    const { node, artifact } = params;
    const isAuthorized = () =>
      !params.signal?.aborted &&
      params.isAuthorized?.() !== false &&
      options.getTransport() === transport &&
      transport.isCurrent(node);
    if (!isAuthorized()) {
      throw new Error("Device worker preparation connection is no longer current");
    }
    const bundlePrewarm =
      params.prewarm && (node.workerHost.bundlePrewarm ?? 0) >= WORKER_BUNDLE_PREWARM_VERSION
        ? WORKER_BUNDLE_PREWARM_VERSION
        : undefined;
    const prepared = options.transfer.prepare({
      node,
      gatewayNamespace: options.gatewayNamespace,
      artifact,
      ...(bundlePrewarm ? { bundlePrewarm } : {}),
      isAuthorized,
      signal: params.signal,
    });
    try {
      const result = await transport.invoke({
        node,
        command: NODE_WORKER_BUNDLE_INSTALL_COMMAND,
        params: prepared.input,
        timeoutMs: workerBootstrapOperationTimeoutMs(artifact),
        idempotencyKey: `${options.gatewayNamespace}:${artifact.bundleHash}`,
        isDispatchAuthorized: isAuthorized,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!isAuthorized()) {
        throw new Error("Device worker preparation connection is no longer current");
      }
      if (!result.ok) {
        throw new Error(
          result.error?.message
            ? `Device worker bundle installation failed: ${result.error.message}`
            : "Device worker bundle installation failed",
        );
      }
      let payload: unknown = result.payload;
      if (result.payloadJSON) {
        try {
          payload = JSON.parse(result.payloadJSON) as unknown;
        } catch {
          payload = undefined;
        }
      }
      const receipt = parseNodeWorkerBundleInstallResult(payload);
      if (!receipt || !verifyWorkerAdmissionHandshake(receipt, artifact)) {
        throw new Error("Device worker bundle installer returned a mismatched build receipt");
      }
      return receipt;
    } finally {
      options.transfer.revoke(prepared.token);
    }
  };
  type Preparation = {
    node: NodeWorkerSupervisorNodeProof;
    transport: NodeWorkerSupervisorTransport;
    artifact: WorkerBundleArtifact;
    controller: AbortController;
    pending: boolean;
    result: ReturnType<typeof install>;
  };
  const preparations = new Map<string, Preparation>();
  const operations = new Set<ReturnType<typeof install>>();
  let stopped = false;
  const invalidate = (nodeId?: string) => {
    for (const [id, entry] of preparations) {
      if (nodeId && id !== nodeId) {
        continue;
      }
      if (
        stopped ||
        options.getTransport() !== entry.transport ||
        !entry.transport.isCurrent(entry.node) ||
        options.isEnvironmentOwnedNode?.(id)
      ) {
        preparations.delete(id);
        entry.controller.abort(new Error("Device worker preparation owner closed"));
      }
    }
  };
  const prepare = (
    params: Omit<InstallRequest, "prewarm" | "isAuthorized">,
    validateAgain: boolean,
  ): ReturnType<typeof install> => {
    params.signal?.throwIfAborted();
    invalidate(params.node.nodeId);
    const transport = options.getTransport();
    if (
      !transport ||
      stopped ||
      !transport.isCurrent(params.node) ||
      options.isEnvironmentOwnedNode?.(params.node.nodeId)
    ) {
      throw new Error("Device worker preparation connection is no longer current");
    }
    const previous = preparations.get(params.node.nodeId);
    if (
      previous &&
      previous.node.connId === params.node.connId &&
      previous.node.pairingGeneration === params.node.pairingGeneration &&
      previous.node.pairingIdentity === params.node.pairingIdentity &&
      sameWorkerBuild(previous.artifact, params.artifact) &&
      previous.artifact.tarballSha256 === params.artifact.tarballSha256 &&
      (!validateAgain || previous.pending)
    ) {
      return racePromiseWithAbortSignal(previous.result, params.signal);
    }
    previous?.controller.abort(new Error("Device worker preparation build replaced"));
    const controller = new AbortController();
    // Hosting consent owns preparation. A cancelled Start releases its wait, while
    // disconnect, pairing replacement and Gateway shutdown close the actual install.
    const result = Promise.resolve().then(() =>
      install(
        {
          ...params,
          prewarm: true,
          signal: controller.signal,
          isAuthorized: () => !stopped && !options.isEnvironmentOwnedNode?.(params.node.nodeId),
        },
        transport,
      ),
    );
    const entry: Preparation = {
      node: params.node,
      transport,
      artifact: params.artifact,
      controller,
      pending: true,
      result,
    };
    preparations.set(params.node.nodeId, entry);
    operations.add(result);
    const settled = () => {
      entry.pending = false;
      operations.delete(result);
    };
    void result.then(settled, (error: unknown) => {
      settled();
      if (
        !controller.signal.aborted &&
        transport.isCurrent(params.node) &&
        !options.isEnvironmentOwnedNode?.(params.node.nodeId)
      ) {
        options.warn?.(
          `Node worker preparation failed (${params.node.nodeId}); retry Start or reconnect the host: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return racePromiseWithAbortSignal(result, params.signal);
  };
  const stop = () => {
    stopped = true;
    invalidate();
  };
  return {
    invalidate,
    stop,
    async close() {
      stop();
      await Promise.allSettled(operations);
    },
    prepare: async (params: Omit<InstallRequest, "prewarm" | "isAuthorized">) => {
      await prepare(params, false);
    },
    ensure: async (params: {
      deviceId: string;
      artifact: WorkerBundleArtifact;
      prewarm: boolean;
      signal?: AbortSignal;
    }) => {
      params.signal?.throwIfAborted();
      const transport = options.getTransport();
      if (!transport) {
        throw new Error("Device worker node transport is unavailable");
      }
      const node = (
        await racePromiseWithAbortSignal(transport.listCurrentNodes(), params.signal)
      ).find((candidate) => candidate.nodeId === params.deviceId);
      params.signal?.throwIfAborted();
      if (!node) {
        throw new Error("Device worker node is not connected with the installer dialect");
      }
      // Ephemeral cloud enrollment retains its own cancellation owner; remote-exec
      // does not pay OpenClaw prewarming. Only persistent worker hosts share preparation.
      if (options.isEnvironmentOwnedNode?.(node.nodeId) || !params.prewarm) {
        return await install({ ...params, node }, transport);
      }
      // A settled preparation is not a replacement for native integrity validation
      // on an explicit new dispatch. Only concurrent in-flight validation is shared.
      return await prepare({ ...params, node }, true);
    },
  };
}
