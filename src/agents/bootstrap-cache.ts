/**
 * Per-session workspace bootstrap snapshot cache.
 * Reuses unchanged bootstrap file arrays while refreshing each turn so edits
 * become visible to long-lived agent sessions.
 */
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

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
      file.missing === updated.missing
    );
  });
}

function pruneOldestBootstrapSnapshots(): void {
  while (cache.size > MAX_BOOTSTRAP_SNAPSHOTS) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      return;
    }
    cache.delete(oldestKey);
  }
}

/** Load bootstrap files for a session, reusing the prior snapshot when content is unchanged. */
export async function getOrLoadBootstrapFiles(params: {
  workspaceDir: string;
  sessionKey: string;
}): Promise<WorkspaceBootstrapFile[]> {
  pruneOldestBootstrapSnapshots();
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
  pruneOldestBootstrapSnapshots();
  return files;
}

/** Test helper exposing the bounded snapshot cache size. */
export function getBootstrapSnapshotCacheSizeForTest(): number {
  return cache.size;
}

/** Test helper for asserting one session snapshot is cached. */
export function hasBootstrapSnapshotForTest(sessionKey: string): boolean {
  return cache.has(sessionKey);
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

/** Clear all cached bootstrap snapshots. */
export function clearAllBootstrapSnapshots(): void {
  cache.clear();
}
