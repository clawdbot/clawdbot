import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { removeClawWorkspaceFile, type RemovedWorkspaceFile } from "./lifecycle-delete-support.js";
import type { ClawRemovePlanAction } from "./lifecycle-remove-contract.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";

export function clawBootstrapStateBlocksRemove(record: ClawStatusRecord): boolean {
  return Boolean(
    record.install.bootstrap &&
    (record.bootstrap.state === "unsafe" || record.bootstrap.state === "unknown"),
  );
}

export function planClawBootstrapRemoval(
  record: ClawStatusRecord,
): ClawRemovePlanAction | undefined {
  if (!record.install.bootstrap) {
    return undefined;
  }
  const blocked = clawBootstrapStateBlocksRemove(record);
  return {
    kind: "bootstrap",
    id: record.bootstrap.path,
    action: record.bootstrap.state === "pending" ? "delete" : "retain",
    target: `${record.bootstrap.workspace}:${record.bootstrap.path}`,
    blocked,
    details: {
      expectedState: record.bootstrap.state,
      contentDigest: record.install.bootstrap.contentDigest,
      sourcePath: record.install.bootstrap.sourcePath,
      lifecycle: "native-seed-once",
    },
    ...(record.bootstrap.state === "modified"
      ? { reason: "Local bootstrap content changed; preserve the file." }
      : record.bootstrap.state === "complete"
        ? { reason: "Native onboarding already consumed the bootstrap." }
        : {}),
  };
}

export async function removeClawBootstrap(
  record: ClawStatusRecord,
  assertCurrent: () => void,
): Promise<RemovedWorkspaceFile | undefined> {
  if (!record.install.bootstrap) {
    return undefined;
  }
  if (record.bootstrap.state === "pending") {
    return removeClawWorkspaceFile(
      {
        workspace: record.bootstrap.workspace,
        path: record.bootstrap.path,
        contentDigest: record.install.bootstrap.contentDigest,
        state: "unchanged",
      },
      assertCurrent,
      MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
    );
  }
  return record.bootstrap.state === "modified"
    ? { path: record.bootstrap.path, action: "retainedModified" }
    : { path: record.bootstrap.path, action: "missing" };
}
