import {
  createArtifactTransferService,
  type ArtifactTransferOptions,
  type TransferArtifact,
} from "./artifact-transfer-service.js";

const BOOTSTRAP_TRANSFER_TTL_MS = 10 * 60_000;

export function createWorkerBootstrapArtifactTransferService(
  options: ArtifactTransferOptions = {},
) {
  const transfer = createArtifactTransferService(options);
  return {
    ...transfer,
    prepare(params: {
      artifact: TransferArtifact;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }) {
      return transfer.prepare({
        ...params,
        artifactKey: params.artifact.tarballSha256,
        ttlMs: BOOTSTRAP_TRANSFER_TTL_MS,
      });
    },
  };
}

export type WorkerBootstrapArtifactTransferService = ReturnType<
  typeof createWorkerBootstrapArtifactTransferService
>;
