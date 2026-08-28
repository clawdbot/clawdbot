import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { MAX_RECONCILIATION_ENTRIES } from "./workspace-manifest.js";

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

const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const WORKER_HASH_IDENTITY_PATTERN = /^worker:\d+:\d+:\d+:\d+:\d+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const remoteWorkspaceManifestEnvelopeSchema = z
  .object({
    version: z.literal(1),
    manifestRef: z.string().regex(MANIFEST_REF_PATTERN),
    memo: z
      .array(
        z.tuple([z.string().regex(WORKER_HASH_IDENTITY_PATTERN), z.string().regex(SHA256_PATTERN)]),
      )
      .max(MAX_RECONCILIATION_ENTRIES),
    metrics: z
      .object({
        contentHashCount: z.number().finite().nonnegative(),
        contentHashDurationMs: z.number().finite().nonnegative(),
        memoHitCount: z.number().finite().nonnegative(),
        memoTruncatedCount: z.number().finite().nonnegative(),
        totalDurationMs: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type RemoteWorkspaceManifestEnvelope = z.infer<typeof remoteWorkspaceManifestEnvelopeSchema>;

/** Parses and validates a memo-v1 capture response from the remote manifest script. */
export function parseRemoteWorkspaceManifestEnvelope(
  stdout: string,
): RemoteWorkspaceManifestEnvelope {
  return remoteWorkspaceManifestEnvelopeSchema.parse(JSON.parse(stdout));
}

/** Replaces the memo's worker-owned entries with the latest capture's entries wholesale. */
export function replaceWorkerWorkspaceHashMemoEntries(
  memo: WorkspaceHashMemo,
  entries: RemoteWorkspaceManifestEnvelope["memo"],
): void {
  for (const identity of memo.keys()) {
    if (identity.startsWith("worker:")) {
      memo.delete(identity);
    }
  }
  for (const [identity, sha256] of entries) {
    memo.set(identity, sha256);
  }
}

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

// A placement-lifetime memo self-bounds its worker entries (each remote capture
// replaces them wholesale) but gateway entries accumulate as stat identities
// change across turns. Reset the whole memo once its estimated footprint
// crosses the shared byte cap so one placement cannot hold unbounded hash state.
export function pruneWorkspaceHashMemo(memo: WorkspaceHashMemo): void {
  let bytes = 0;
  for (const [identity, sha256] of memo) {
    // Identities and digests are ASCII, so string length equals byte length.
    bytes += identity.length + sha256.length;
    if (bytes > MAX_WORKSPACE_HASH_MEMO_BYTES) {
      memo.clear();
      return;
    }
  }
}

/** Returns the placement-owned memo for a key, pruning it before each reuse. */
export function takeWorkspaceHashMemo(
  store: Map<string, WorkspaceHashMemo>,
  key: string,
): WorkspaceHashMemo {
  const memo = store.get(key) ?? new Map();
  pruneWorkspaceHashMemo(memo);
  store.set(key, memo);
  return memo;
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
  stats: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
): string {
  return `${owner}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}
