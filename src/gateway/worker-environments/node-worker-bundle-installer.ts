import { NODE_WORKER_BUNDLE_INSTALL_COMMAND } from "../../infra/node-commands.js";
import { parseNodeWorkerBundleInstallResult } from "../../worker/node-bundle-install-protocol.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { NodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

export function createGatewayNodeWorkerBundleInstaller(options: {
  gatewayNamespace: string;
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  prepareBundle: () => Promise<WorkerBundleArtifact>;
  transfer: NodeWorkerBundleTransferService;
}) {
  return async (params: { deviceId: string; signal?: AbortSignal }) => {
    const transport = options.getTransport();
    if (!transport) {
      throw new Error("Device worker node transport is unavailable");
    }
    const node = (await transport.listCurrentNodes()).find(
      (candidate) => candidate.nodeId === params.deviceId,
    );
    if (!node) {
      throw new Error("Device worker node is not connected with the installer dialect");
    }
    const artifact = await options.prepareBundle();
    const isAuthorized = () => transport.isCurrent(node);
    const prepared = options.transfer.prepare({
      node,
      gatewayNamespace: options.gatewayNamespace,
      artifact,
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
}

export type GatewayNodeWorkerBundleInstaller = ReturnType<
  typeof createGatewayNodeWorkerBundleInstaller
>;
