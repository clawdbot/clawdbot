import type { NodeWorkerBundleInstallInput } from "../../worker/node-bundle-install-protocol.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  createArtifactTransferService,
  type ArtifactTransferOptions,
} from "./artifact-transfer-service.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap.js";
import type { WorkerInstallationArtifact } from "./bundle.js";

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

export function createNodeWorkerBundleTransferService(options: ArtifactTransferOptions = {}) {
  const transfer = createArtifactTransferService(options);
  return {
    ...transfer,
    prepare(params: {
      node: NodeWorkerSupervisorNodeProof;
      gatewayNamespace: string;
      artifact: WorkerBundleArtifact;
      bundlePrewarm?: 1;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }): { token: string; input: NodeWorkerBundleInstallInput } {
      // The caller closes over this exact node proof; copied node IDs are not authority.
      const { token } = transfer.prepare({
        ...params,
        artifactKey: params.artifact.bundleHash,
        ttlMs: workerBootstrapOperationTimeoutMs(params.artifact),
      });
      return {
        token,
        input: {
          gatewayNamespace: params.gatewayNamespace,
          ...(params.bundlePrewarm ? { bundlePrewarm: params.bundlePrewarm } : {}),
          build: {
            bundleHash: params.artifact.bundleHash,
            openclawVersion: params.artifact.openclawVersion,
            protocolFeatures: [...params.artifact.protocolFeatures],
          },
          archive: {
            token,
            sha256: params.artifact.tarballSha256,
            bytes: params.artifact.tarballBytes,
          },
        },
      };
    },
    authorize(params: { token: string; bundleHash: string }) {
      return transfer.authorize({ token: params.token, artifactKey: params.bundleHash });
    },
  };
}

export type NodeWorkerBundleTransferService = ReturnType<
  typeof createNodeWorkerBundleTransferService
>;
