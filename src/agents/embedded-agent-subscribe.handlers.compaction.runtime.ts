/**
 * Runtime helpers for reconciling compaction counts after subscribe events.
 */
import { resolveStorePath } from "../config/sessions/paths.js";
import { updateSessionEntry } from "../config/sessions/session-accessor.js";

/**
 * Persist the highest observed compaction count after a successful subscribed run.
 *
 * Exported as a named binding rather than `default`: the unified dist emits this
 * lazy runtime as its own chunk, and the stable-name re-export shim rolldown
 * generates uses `export *`, which per ESM does not forward `default`. Any
 * dynamic importer would then see `default: undefined` and silently skip
 * reconciliation. Named exports are forwarded by `export *`, so this keeps the
 * shim correct without a bundler-side workaround.
 */
export async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { sessionKey, agentId, configStore, observedCompactionCount, now = Date.now() } = params;
  if (!sessionKey || observedCompactionCount <= 0) {
    return undefined;
  }
  const storePath = resolveStorePath(configStore, { agentId });
  const nextEntry = await updateSessionEntry({ sessionKey, storePath }, async (entry) => {
    // The live stream and store can both observe compactions. Keep the max so
    // late lower-count updates cannot make future resume labels regress.
    const currentCount = Math.max(0, entry.compactionCount ?? 0);
    const nextCount = Math.max(currentCount, observedCompactionCount);
    if (nextCount === currentCount) {
      return null;
    }
    return {
      compactionCount: nextCount,
      updatedAt: Math.max(entry.updatedAt ?? 0, now),
    };
  });
  return nextEntry?.compactionCount;
}
