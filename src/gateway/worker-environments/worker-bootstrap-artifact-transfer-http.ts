import {
  classifyWorkerBootstrapArtifactTransferPath,
  WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH,
} from "../gateway-http-route-contracts.js";
import {
  createArtifactTransferHttpCallback,
  handleArtifactTransferHttpRequest,
  type ArtifactTransferHttpCallback,
  type ArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";
import type { WorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

export type WorkerBootstrapArtifactTransferHttpCallback = (
  params: Omit<Parameters<ArtifactTransferHttpCallback>[0], "artifactKey"> & {
    artifactSha256: string;
  },
) => ReturnType<ArtifactTransferHttpCallback>;

export function handleWorkerBootstrapArtifactTransferHttpRequest(
  params: ArtifactTransferHttpRequest & { callback?: WorkerBootstrapArtifactTransferHttpCallback },
): Promise<boolean> {
  const callback = params.callback;
  return handleArtifactTransferHttpRequest({
    ...params,
    classifyPath: classifyWorkerBootstrapArtifactTransferPath,
    routePrefix: `${WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH}/artifacts/`,
    callback: callback
      ? ({ artifactKey, ...request }) => callback({ ...request, artifactSha256: artifactKey })
      : undefined,
  });
}

export function createWorkerBootstrapArtifactTransferHttpCallback(
  service: WorkerBootstrapArtifactTransferService,
): WorkerBootstrapArtifactTransferHttpCallback {
  const callback = createArtifactTransferHttpCallback(service);
  return ({ artifactSha256, ...request }) => callback({ ...request, artifactKey: artifactSha256 });
}
