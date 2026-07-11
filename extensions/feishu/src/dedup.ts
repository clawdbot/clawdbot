// Feishu inbound replay protection rides the core claimable dedupe: Feishu
// redelivers events after reconnects/restarts and multi-account groups receive
// the same event once per bot, so handlers claim a dedupe key before
// processing, commit once handling is dispatched, and release on retryable
// failure so the event can be redelivered.
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

// Persisted namespaces resolve to `feishu.dedup.<namespace hash>` in the shared
// plugin-state SQLite store. Rows from the retired hand-rolled `dedup.*` store
// are dropped without import: replay protection is cache and rebuilds after
// upgrade, leaving only a brief unclean-shutdown redelivery gap.
const DEDUPE_NAMESPACE_PREFIX = "feishu.dedup";
// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const STORE_MAX_ENTRIES = 10_000;

type FeishuDedupeLog = (...args: unknown[]) => void;

type FeishuMessageClaim = "claimed" | "duplicate" | "inflight";

function createFeishuDedupeGuard() {
  return createClaimableDedupe({
    pluginId: "feishu",
    namespacePrefix: DEDUPE_NAMESPACE_PREFIX,
    ttlMs: DEDUP_TTL_MS,
    memoryMaxSize: MEMORY_MAX_SIZE,
    stateMaxEntries: STORE_MAX_ENTRIES,
  });
}

let guard = createFeishuDedupeGuard();

function dedupeKey(messageId: string | undefined | null): string {
  return messageId?.trim() ?? "";
}

function dedupeOptions(namespace: string | undefined, log: FeishuDedupeLog | undefined) {
  return {
    ...(namespace ? { namespace } : {}),
    // Persistence is best effort: a broken state DB must never block inbound
    // handling, so disk errors surface to the caller's log while the memory
    // layer keeps deduping.
    ...(log
      ? {
          onDiskError: (error: unknown) =>
            log(`feishu-dedup: persistent state error: ${String(error)}`),
        }
      : {}),
  };
}

/**
 * Claims a dedupe key for exclusive handling. Duplicate (already committed)
 * and in-flight keys are reported; blank keys fail open as claimed so an
 * unidentifiable event is never suppressed.
 */
export async function claimUnprocessedFeishuMessage(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: FeishuDedupeLog;
}): Promise<FeishuMessageClaim> {
  const key = dedupeKey(params.messageId);
  if (!key) {
    return "claimed";
  }
  return (await guard.claim(key, dedupeOptions(params.namespace, params.log))).kind;
}

/** Drops an uncommitted claim so a failed handler can retry the message. */
export function releaseFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): void {
  const key = dedupeKey(messageId);
  if (key) {
    guard.release(key, { namespace });
  }
}

/**
 * Claims (unless the caller already holds the claim) and commits a message.
 * False means another handler owns it, it was already handled, or the key is
 * blank; handlers must skip dispatch then.
 */
export async function finalizeFeishuMessageProcessing(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: FeishuDedupeLog;
  claimHeld?: boolean;
}): Promise<boolean> {
  const key = dedupeKey(params.messageId);
  if (!key) {
    return false;
  }
  const options = dedupeOptions(params.namespace, params.log);
  if (!params.claimHeld && (await guard.claim(key, options)).kind !== "claimed") {
    return false;
  }
  return await guard.commit(key, options);
}

/** Records a handled message so restart/replay cannot dispatch it again; false when already recorded. */
export async function recordProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  const key = dedupeKey(messageId);
  if (!key) {
    return false;
  }
  return await guard.commit(key, dedupeOptions(namespace, log));
}

/** Forgets a recorded message so a retryable synthetic event can be handled on redelivery. */
export async function forgetProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  const key = dedupeKey(messageId);
  if (!key) {
    return false;
  }
  return await guard.forget(key, dedupeOptions(namespace, log));
}

/** Checks recency without claiming or recording. */
export async function hasProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: FeishuDedupeLog,
): Promise<boolean> {
  const key = dedupeKey(messageId);
  if (!key) {
    return false;
  }
  return await guard.hasRecent(key, dedupeOptions(namespace, log));
}

/** Loads recent persisted entries into memory at account start; returns the loaded count. */
export async function warmupDedupFromPluginState(
  namespace: string,
  log?: FeishuDedupeLog,
): Promise<number> {
  return await guard.warmup(namespace, (error) =>
    log?.(`feishu-dedup: warmup persistent state error: ${String(error)}`),
  );
}

export const testingHooks = {
  /** Drops in-flight claims and process memory; persisted rows follow the test's state dir. */
  resetFeishuDedupForTests() {
    guard = createFeishuDedupeGuard();
  },
};
