import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export { createAsyncLock, readJsonIfExists, tryReadJson, writeJson } from "./json-files.js";

/** Resolve pending/paired JSON file locations for one pairing namespace. */
export function resolvePairingPaths(baseDir: string | undefined, subdir: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, subdir);
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

/** Coerce persisted pairing maps, treating malformed arrays/scalars as empty state. */
export function coercePairingStateRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, T>;
}

/** Remove pending requests older than the caller's pairing TTL. */
export function pruneExpiredPending<T extends { ts: number }>(
  pendingById: Record<string, T>,
  nowMs: number,
  ttlMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > ttlMs) {
      delete pendingById[id];
    }
  }
}

/** Result shape for creating or refreshing a pending pairing request. */
export type PendingPairingRequestResult<TPending> = {
  status: "pending";
  request: TPending;
  created: boolean;
};

/** Refresh one compatible pending request or replace a superseded request set atomically. */
export async function reconcilePendingPairingRequests<
  TPending extends { requestId: string },
  TIncoming,
>(params: {
  pendingById: Record<string, TPending>;
  existing: readonly TPending[];
  incoming: TIncoming;
  canRefreshSingle: (existing: TPending, incoming: TIncoming) => boolean;
  refreshSingle: (existing: TPending, incoming: TIncoming) => TPending;
  buildReplacement: (params: { existing: readonly TPending[]; incoming: TIncoming }) => TPending;
  persist: () => Promise<void>;
}): Promise<PendingPairingRequestResult<TPending>> {
  if (
    params.existing.length === 1 &&
    params.canRefreshSingle(params.existing[0], params.incoming)
  ) {
    const refreshed = params.refreshSingle(params.existing[0], params.incoming);
    params.pendingById[refreshed.requestId] = refreshed;
    await params.persist();
    return { status: "pending", request: refreshed, created: false };
  }

  for (const existing of params.existing) {
    delete params.pendingById[existing.requestId];
  }

  const request = params.buildReplacement({
    existing: params.existing,
    incoming: params.incoming,
  });
  params.pendingById[request.requestId] = request;
  await params.persist();
  return { status: "pending", request, created: true };
}
