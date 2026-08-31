/**
 * Per-session workspace bootstrap snapshot cache.
 * Reuses unchanged bootstrap file arrays while refreshing each turn so edits
 * become visible to long-lived agent sessions.
 */
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
  workspaceFileSourceIdentitiesMatch,
} from "./workspace.js";

type BootstrapSnapshot = {
  workspaceDir: string;
  files: WorkspaceBootstrapFile[];
};

const MAX_BOOTSTRAP_SNAPSHOTS = 64;
const cache = new Map<string, BootstrapSnapshot>();

function bootstrapFilesEqual(
  previous: WorkspaceBootstrapFile[],
  next: WorkspaceBootstrapFile[],
): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((file, index) => {
    const updated = next[index];
    return (
      updated !== undefined &&
      file.name === updated.name &&
      file.path === updated.path &&
      file.content === updated.content &&
      file.missing === updated.missing &&
      // Equal bytes at a replaced inode or symlink target must carry the newly
      // opened source identity instead of reusing stale file objects.
      workspaceFileSourceIdentitiesMatch(file, updated)
    );
  });
}

/** Load bootstrap files for a session, reusing the prior snapshot when content is unchanged. */
export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  pruneMapToMaxSize(cache, MAX_BOOTSTRAP_SNAPSHOTS);
  const existing = cache.get(params.sessionKey);
  // Refresh per turn so long-lived sessions pick up edits; loadWorkspaceBootstrapFiles
  // handles unchanged file content through its guarded inode/mtime cache.
  const files = await loadWorkspaceBootstrapFiles(params.workspaceDir);
  if (
    existing &&
    existing.workspaceDir === params.workspaceDir &&
    bootstrapFilesEqual(existing.files, files)
  ) {
    cache.delete(params.sessionKey);
    cache.set(params.sessionKey, existing);
    return existing.files;
  }

  cache.set(params.sessionKey, { workspaceDir: params.workspaceDir, files });
  pruneMapToMaxSize(cache, MAX_BOOTSTRAP_SNAPSHOTS);
  return files;
}

/** Drop one cached bootstrap snapshot. */
export function clearBootstrapSnapshot(sessionKey: string): void {
  cache.delete(sessionKey);
}

/** Clear bootstrap state when a visible session rolls over to a new backing session. */
export function clearBootstrapSnapshotOnSessionRollover(params: {
  sessionKey?: string;
  previousSessionId?: string;
}): void {
  if (!params.sessionKey || !params.previousSessionId) {
    return;
  }

  clearBootstrapSnapshot(params.sessionKey);
}

/** Clear bootstrap state after an in-log lifecycle boundary is durably appended. */
export function clearBootstrapSnapshotOnSessionBoundary(params: {
  boundaryAppended: boolean;
  sessionKey?: string;
}): void {
  if (!params.boundaryAppended || !params.sessionKey) {
    return;
  }
  clearBootstrapSnapshot(params.sessionKey);
}
