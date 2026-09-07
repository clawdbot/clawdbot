import { isPathInside } from "../infra/path-guards.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";

type WorkspaceFileCacheEntry = {
  content: string;
  identity: string;
  sizeBytes: number;
};

// One fully populated workspace fits without eviction; the entry cap also
// bounds empty files and high workspace fan-out.
const MAX_WORKSPACE_FILE_CACHE_BYTES = 6 * MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES;
const MAX_WORKSPACE_FILE_CACHE_ENTRIES = 64;
const workspaceFileCache = new Map<string, WorkspaceFileCacheEntry>();
let workspaceFileCacheBytes = 0;

function deleteWorkspaceFileCacheEntry(filePath: string): void {
  const entry = workspaceFileCache.get(filePath);
  if (!entry) {
    return;
  }
  workspaceFileCache.delete(filePath);
  workspaceFileCacheBytes -= entry.sizeBytes;
}

export function readWorkspaceFileCache(filePath: string, identity: string): string | undefined {
  const entry = workspaceFileCache.get(filePath);
  if (!entry) {
    return undefined;
  }
  if (entry.identity !== identity) {
    deleteWorkspaceFileCacheEntry(filePath);
    return undefined;
  }
  workspaceFileCache.delete(filePath);
  workspaceFileCache.set(filePath, entry);
  return entry.content;
}

export function writeWorkspaceFileCache(params: {
  filePath: string;
  content: string;
  identity: string;
}): void {
  deleteWorkspaceFileCacheEntry(params.filePath);
  const entry = {
    content: params.content,
    identity: params.identity,
    sizeBytes: Buffer.byteLength(params.content, "utf8"),
  };
  workspaceFileCache.set(params.filePath, entry);
  workspaceFileCacheBytes += entry.sizeBytes;

  while (
    workspaceFileCache.size > MAX_WORKSPACE_FILE_CACHE_ENTRIES ||
    workspaceFileCacheBytes > MAX_WORKSPACE_FILE_CACHE_BYTES
  ) {
    const oldest = workspaceFileCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    deleteWorkspaceFileCacheEntry(oldest);
  }
}

export function retireWorkspaceFileCache(workspaceRoot: string): void {
  // SQLite identities are NFC even when the vanished filesystem path was not.
  // Normalize only retirement comparisons; cache reads keep raw paths distinct.
  const rootIdentityPath = workspaceRoot.normalize("NFC");
  for (const filePath of workspaceFileCache.keys()) {
    if (isPathInside(rootIdentityPath, filePath.normalize("NFC"))) {
      deleteWorkspaceFileCacheEntry(filePath);
    }
  }
}
