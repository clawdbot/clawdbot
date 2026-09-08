import { NODE_WORKER_BUNDLE_TRANSFER_PATH } from "../../worker/node-bundle-install-protocol.js";
import { classifyNodeWorkerBundleTransferPath } from "../gateway-http-route-contracts.js";
import {
  createArtifactTransferHttpCallback,
  handleArtifactTransferHttpRequest,
  type ArtifactTransferHttpCallback,
  type ArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";
import type { NodeWorkerBundleTransferService } from "./node-worker-bundle-transfer-service.js";

export type NodeWorkerBundleTransferHttpCallback = (
  params: Omit<Parameters<ArtifactTransferHttpCallback>[0], "artifactKey"> & { bundleHash: string },
) => ReturnType<ArtifactTransferHttpCallback>;

export function handleNodeWorkerBundleTransferHttpRequest(
  params: ArtifactTransferHttpRequest & { callback?: NodeWorkerBundleTransferHttpCallback },
): Promise<boolean> {
  const callback = params.callback;
  return handleArtifactTransferHttpRequest({
    ...params,
    classifyPath: classifyNodeWorkerBundleTransferPath,
    routePrefix: `${NODE_WORKER_BUNDLE_TRANSFER_PATH}/bundles/`,
    callback: callback
      ? ({ artifactKey, ...request }) => callback({ ...request, bundleHash: artifactKey })
      : undefined,
  });
}

export function createNodeWorkerBundleTransferHttpCallback(
  service: NodeWorkerBundleTransferService,
): NodeWorkerBundleTransferHttpCallback {
  const callback = createArtifactTransferHttpCallback({
    ...service,
    authorize: ({ token, artifactKey }) => service.authorize({ token, bundleHash: artifactKey }),
  });
  return ({ bundleHash, ...request }) => callback({ ...request, artifactKey: bundleHash });
}
