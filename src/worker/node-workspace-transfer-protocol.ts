export const NODE_WORKSPACE_TRANSFER_PATH = "/__openclaw__/worker-transfer/v1";
export const NODE_WORKSPACE_TRANSFER_ERROR_CODE = "WORKSPACE_TRANSFER_FAILED";

export class NodeWorkerWorkspaceTransferError extends Error {
  readonly code = NODE_WORKSPACE_TRANSFER_ERROR_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeWorkerWorkspaceTransferError";
  }
}

export type NodeWorkerWorkspaceTransferInput =
  | {
      direction: "download";
      token: string;
      manifestRef: string;
      /** Reuse this prepared project's immutable Git objects before downloading a pack. */
      seedKey?: string;
      /** Install attachment files only; never replace or delete workspace entries. */
      attachments?: true;
    }
  | {
      direction: "upload";
      token: string;
      baseManifestRef: string;
    };

function nodeWorkspaceTransferEnvironmentPath(environmentId: string): string {
  return `${NODE_WORKSPACE_TRANSFER_PATH}/environments/${encodeURIComponent(environmentId)}`;
}

export function nodeWorkspaceTransferManifestPath(
  environmentId: string,
  manifestRef: string,
): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/snapshots/${manifestRef.slice(
    "sha256:".length,
  )}/manifest`;
}

export function nodeWorkspaceTransferPackPath(environmentId: string, manifestRef: string): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/snapshots/${manifestRef.slice(
    "sha256:".length,
  )}/pack`;
}

export function nodeWorkspaceTransferBlobPath(environmentId: string, sha256: string): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/blobs/${sha256}`;
}

export function nodeWorkspaceTransferReconcilePath(
  environmentId: string,
  baseManifestRef: string,
): string {
  return `${nodeWorkspaceTransferEnvironmentPath(environmentId)}/reconciliations/${baseManifestRef.slice(
    "sha256:".length,
  )}`;
}
