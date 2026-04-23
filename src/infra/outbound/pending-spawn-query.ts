import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";

/**
 * Synchronous predicate: does `sessionKey` have pending spawned subagent runs?
 * Runs on the outbound plan hot path, so implementations must be cheap/bounded
 * (default in `subagent-registry.ts` is an in-memory map lookup). Internal to
 * core; not re-exported through `openclaw/plugin-sdk`.
 */
export type PendingSpawnedChildrenQuery = (sessionKey?: string) => boolean;

const log = createSubsystemLogger("outbound/pending-spawn");
const THROW_LOG_INTERVAL_MS = 60_000;
let lastThrowLogAt = 0;
let pendingSpawnedChildrenQuery: PendingSpawnedChildrenQuery | undefined;

export function registerPendingSpawnedChildrenQuery(
  query: PendingSpawnedChildrenQuery | undefined,
): PendingSpawnedChildrenQuery | undefined {
  const previous = pendingSpawnedChildrenQuery;
  pendingSpawnedChildrenQuery = query;
  return previous;
}

function summarizeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "Unknown", message: typeof err === "string" ? err : "non-error throw" };
}

function hashSessionKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) {
    return undefined;
  }
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}

export function resolvePendingSpawnedChildren(sessionKey: string | undefined): boolean {
  if (!pendingSpawnedChildrenQuery) {
    return false;
  }
  try {
    return pendingSpawnedChildrenQuery(sessionKey);
  } catch (err) {
    const now = Date.now();
    if (now - lastThrowLogAt >= THROW_LOG_INTERVAL_MS) {
      lastThrowLogAt = now;
      log.warn("pending-spawn query threw; defaulting to false", {
        err: summarizeError(err),
        sessionKeyHash: hashSessionKey(sessionKey),
      });
    }
    return false;
  }
}
