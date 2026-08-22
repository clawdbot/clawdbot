import { AsyncLocalStorage } from "node:async_hooks";

type WorkspaceHashMetrics = {
  contentHashCount: number;
  contentHashDurationMs: number;
  memoHitCount: number;
};

export type WorkspaceHashMemo = Map<string, string>;

export type WorkspaceReconcileMetrics = {
  gateway: WorkspaceHashMetrics;
  remoteManifestCalls: number;
  remoteContentHashCount: number;
  remoteMemoHitCount: number;
  remoteMemoTruncatedCount: number;
  remoteHashDurationMs: number;
  remoteManifestDurationMs: number;
  remoteManifestWallDurationMs: number;
  localReconciliationDurationMs: number;
};

type RemoteWorkspaceHashMetrics = WorkspaceHashMetrics & {
  memoTruncatedCount: number;
  totalDurationMs: number;
};

export const MAX_WORKSPACE_HASH_MEMO_BYTES = 8 * 1024 * 1024;

type WorkspaceHashContext = {
  memo: WorkspaceHashMemo;
  metrics?: WorkspaceHashMetrics;
};

const workspaceHashContext = new AsyncLocalStorage<WorkspaceHashContext>();

export function createWorkspaceReconcileMetrics(): WorkspaceReconcileMetrics {
  return {
    gateway: {
      contentHashCount: 0,
      contentHashDurationMs: 0,
      memoHitCount: 0,
    },
    remoteManifestCalls: 0,
    remoteContentHashCount: 0,
    remoteMemoHitCount: 0,
    remoteMemoTruncatedCount: 0,
    remoteHashDurationMs: 0,
    remoteManifestDurationMs: 0,
    remoteManifestWallDurationMs: 0,
    localReconciliationDurationMs: 0,
  };
}

export function activeWorkspaceHashContext(): WorkspaceHashContext | undefined {
  return workspaceHashContext.getStore();
}

export async function withWorkspaceHashMemo<T>(
  memo: WorkspaceHashMemo,
  operation: () => Promise<T>,
  metrics?: WorkspaceHashMetrics,
): Promise<T> {
  const active = workspaceHashContext.getStore();
  const inheritedMetrics = metrics ?? active?.metrics;
  if (active?.memo === memo && active.metrics === inheritedMetrics) {
    return await operation();
  }
  return await workspaceHashContext.run({ memo, metrics: inheritedMetrics }, operation);
}

export async function withWorkspaceHashContext<T>(operation: () => Promise<T>): Promise<T> {
  const active = workspaceHashContext.getStore();
  return await withWorkspaceHashMemo(active?.memo ?? new Map(), operation, active?.metrics);
}

export function serializeRemoteWorkspaceHashMemo(memo: WorkspaceHashMemo): string {
  const serialized = JSON.stringify(
    [...memo]
      .filter(([identity]) => identity.startsWith("worker:"))
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
  if (Buffer.byteLength(serialized) > MAX_WORKSPACE_HASH_MEMO_BYTES) {
    throw new Error("Workspace hash memo exceeds its byte limit");
  }
  return serialized;
}

export function recordRemoteWorkspaceHashMetrics(
  aggregate: WorkspaceReconcileMetrics,
  metrics: RemoteWorkspaceHashMetrics,
): void {
  aggregate.remoteContentHashCount += metrics.contentHashCount;
  aggregate.remoteMemoHitCount += metrics.memoHitCount;
  aggregate.remoteMemoTruncatedCount += metrics.memoTruncatedCount;
  aggregate.remoteHashDurationMs += metrics.contentHashDurationMs;
  aggregate.remoteManifestDurationMs += metrics.totalDurationMs;
}

export async function measureLocalWorkspaceReconciliation<T>(
  metrics: WorkspaceReconcileMetrics,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    metrics.localReconciliationDurationMs += performance.now() - startedAt;
  }
}

export function workspaceStatIdentity(
  owner: "gateway" | "worker",
  stats: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
): string {
  return `${owner}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}
