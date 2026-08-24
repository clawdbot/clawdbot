export type WorkerWorkspaceResultConflict = {
  paths: string[];
  stagedResultRef: string;
  totalCount?: number;
};

export const WORKSPACE_CONFLICT_TRANSCRIPT_TYPE = "cloud-workspace-conflict";
export const WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE = "cloud-workspace-conflict-cleared";

const MAX_PROJECTED_CONFLICT_PATHS = 256;
const MAX_PROJECTED_CONFLICT_PATH_BYTES = 32 * 1024;

export function projectWorkspaceResultConflict(
  paths: readonly string[],
  stagedResultRef: string,
  knownTotalCount?: number,
): Required<WorkerWorkspaceResultConflict> {
  const uniquePaths = [...new Set(paths)].toSorted();
  const projectedPaths: string[] = [];
  let projectedBytes = 0;
  for (const entryPath of uniquePaths) {
    const bytes = Buffer.byteLength(entryPath);
    if (
      projectedPaths.length >= MAX_PROJECTED_CONFLICT_PATHS ||
      projectedBytes + bytes > MAX_PROJECTED_CONFLICT_PATH_BYTES
    ) {
      break;
    }
    projectedPaths.push(entryPath);
    projectedBytes += bytes;
  }
  if (projectedPaths.length === 0) {
    throw new Error("Cloud workspace result conflict projection has no bounded path");
  }
  return {
    paths: projectedPaths,
    stagedResultRef,
    totalCount: Math.max(knownTotalCount ?? uniquePaths.length, uniquePaths.length),
  };
}

export function formatWorkspaceConflictSummary(
  paths: readonly string[],
  stagedResultRef: string,
  totalCount = paths.length,
): string {
  const visibleLimit = 20;
  const visiblePaths = paths.slice(0, visibleLimit);
  const visible = visiblePaths.join(", ");
  const remainder =
    totalCount > visiblePaths.length ? ` (+${totalCount - visiblePaths.length} more)` : "";
  return `Cloud result applied with ${totalCount} conflict(s); kept local versions: ${visible}${remainder}. Cloud versions staged at ${stagedResultRef}.`;
}
