// Mattermost thread-history recovery for cold inbound turns (issue #93204).
//
// The monitor keeps thread history in a process-local map. After a gateway
// restart or a session clear that map is empty, so a thread the user has been
// talking in for days arrives at the agent with no context at all and nothing
// ever asks the server for it. This module fills that window once per stored
// session, from the authoritative Mattermost thread.
//
// Everything here is about keeping a network call on the inbound path safe:
//
// - one recovery per historyKey + session id, so an active thread never pays
//   for the fetch twice;
// - a `pending:` marker while the session entry has no session id yet, adopted
//   into the real id once it exists, so a first cold turn is not counted twice;
// - a shared in-flight promise per historyKey, so concurrent cold turns make
//   one request between them;
// - `perPage` clamped to Mattermost's documented 200-item maximum;
// - an AbortController timeout, so a slow server cannot hold the turn open;
// - insertion-ordered eviction on both maps, so a long-lived process cannot
//   accumulate unbounded recovery state;
// - completion is discarded when the marker rotated mid-flight, so a stale
//   response cannot overwrite a newer session's window;
// - bounded retry for transient failures (see below).
//
// Retry policy. Marking the session attempted before the request means a single
// timeout suppresses recovery for the whole stored session, leaving the thread
// contextless until the session id rotates. Instead, a failure the shared
// Mattermost client classifies as retryable releases the marker and schedules
// another attempt; anything else (a revoked token, a deleted thread) keeps the
// marker so a hopeless request is never repeated. The budget is what makes this
// safe: an unreachable server costs at most THREAD_BACKFILL_MAX_ATTEMPTS
// requests per thread per session, spaced by the cooldown — never one request
// per inbound message.
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { isRetryableError, type MattermostClient, type MattermostPost } from "./client.js";
import type { HistoryEntry } from "./runtime-api.js";

/** Mattermost rejects `perPage` above this; the API contract documents 200. */
const MATTERMOST_THREAD_PER_PAGE_MAX = 200;
/**
 * Upper bound on how long a cold turn may wait for the server. Deliberately far
 * below the client's 30s default: this request sits on the inbound path, so a
 * slow server must cost the reply seconds, not half a minute.
 */
const THREAD_BACKFILL_TIMEOUT_MS = 5_000;
/** Total fetches allowed per marker before recovery gives up. */
const THREAD_BACKFILL_MAX_ATTEMPTS = 3;
/** Minimum spacing between attempts for the same marker. */
const THREAD_BACKFILL_COOLDOWN_MS = 60_000;
/** Insertion-ordered eviction bound for both recovery maps. */
const THREAD_BACKFILL_MARKER_CAP = 1_000;

type RetryRecord = {
  marker: string;
  attempts: number;
  nextAttemptAt: number;
};

type MattermostThreadBackfillDeps = {
  client: MattermostClient;
  channelHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  /** Resolves the stored session id backing a history key, if the store has one. */
  resolveSessionId: (params: { historyKey: string; agentId: string }) => string | undefined;
  logVerboseMessage?: (message: string) => void;
  now?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  cooldownMs?: number;
  markerCap?: number;
};

type EnsureThreadHistoryParams = {
  historyKey: string;
  threadRootId: string;
  /** The post being handled; it is already in the turn and must not be replayed. */
  currentPostId: string;
  /** Routed agent for this turn; the session store is partitioned by agent. */
  agentId: string;
};

type MattermostThreadBackfill = {
  ensureThreadHistory: (params: EnsureThreadHistoryParams) => Promise<void>;
};

/**
 * Clamps the requested page size to the Mattermost maximum.
 *
 * One extra post is requested because the post being handled is filtered out of
 * the response, so a full window still yields `historyLimit` entries.
 */
function resolveThreadFetchLimit(historyLimit: number): number {
  const requested = Math.max(historyLimit + 1, 1);
  return Math.min(requested, MATTERMOST_THREAD_PER_PAGE_MAX);
}

/** A session id means the store settled; until then recovery is tracked as pending. */
function resolveRecoveryMarker(params: {
  historyKey: string;
  sessionId: string | undefined;
}): string {
  return params.sessionId ? `session:${params.sessionId}` : `pending:${params.historyKey}`;
}

/**
 * A recorded failure blocks the next attempt only while it belongs to the
 * current marker, the budget is unspent, and the cooldown has not elapsed.
 */
function mayAttemptRecovery(params: {
  record: RetryRecord | undefined;
  marker: string;
  now: number;
  maxAttempts: number;
}): boolean {
  const { record, marker, now, maxAttempts } = params;
  if (!record || record.marker !== marker) {
    return true;
  }
  return record.attempts < maxAttempts && now >= record.nextAttemptAt;
}

export function createMattermostThreadBackfill(
  deps: MattermostThreadBackfillDeps,
): MattermostThreadBackfill {
  const {
    client,
    channelHistories,
    historyLimit,
    resolveSessionId,
    logVerboseMessage,
    now = () => Date.now(),
    timeoutMs = THREAD_BACKFILL_TIMEOUT_MS,
    maxAttempts = THREAD_BACKFILL_MAX_ATTEMPTS,
    cooldownMs = THREAD_BACKFILL_COOLDOWN_MS,
    markerCap = THREAD_BACKFILL_MARKER_CAP,
  } = deps;

  const markers = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const retries = new Map<string, RetryRecord>();

  // Re-inserting before eviction keeps the map in least-recently-touched order,
  // so an active thread is never the entry that gets dropped.
  const boundedSet = <T>(map: Map<string, T>, key: string, value: T): void => {
    map.delete(key);
    map.set(key, value);
    while (map.size > markerCap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      map.delete(oldest);
    }
  };

  const settleInFlight = async (historyKey: string): Promise<void> => {
    const pending = inFlight.get(historyKey);
    if (pending) {
      await pending.catch(() => {});
    }
  };

  const fetchThreadEntries = async (params: {
    threadRootId: string;
    currentPostId: string;
  }): Promise<HistoryEntry[]> => {
    const perPage = resolveThreadFetchLimit(historyLimit);
    // The shared client owns request deadlines, so the inbound bound is
    // expressed as its `timeoutMs` rather than a second abort controller here.
    // Its abort surfaces as an AbortError, which isRetryableError already
    // classifies as retryable.
    const thread = await client.request<{
      order?: string[];
      posts?: Record<string, MattermostPost>;
    }>(`/posts/${encodeURIComponent(params.threadRootId)}/thread?perPage=${perPage}&direction=up`, {
      timeoutMs,
    });
    const order = Array.isArray(thread?.order) ? thread.order : [];
    const posts = thread?.posts && typeof thread.posts === "object" ? thread.posts : {};
    return order
      .map((id) => posts[id])
      .filter((post): post is MattermostPost => Boolean(post) && post?.id !== params.currentPostId)
      .slice(-historyLimit)
      .map((post) => ({
        sender: post.user_id || "unknown",
        // Attachment-only posts carry no message text; a placeholder keeps the
        // turn ordering intact instead of silently dropping the post.
        body: post.message || "[attachment]",
        timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
        messageId: post.id,
      }));
  };

  const recordFailure = (params: { historyKey: string; marker: string; error: unknown }): void => {
    // Only the owner of the current marker may rewrite recovery state; if a
    // newer session rotated in while this fetch was running, both its marker and
    // its own budget must be left alone.
    if (markers.get(params.historyKey) !== params.marker) {
      logVerboseMessage?.(
        `mattermost: thread backfill failed for a rotated session historyKey=${params.historyKey}`,
      );
      return;
    }
    const prior = retries.get(params.historyKey);
    const attempts = (prior?.marker === params.marker ? prior.attempts : 0) + 1;
    const retryable =
      params.error instanceof Error && isRetryableError(params.error) && attempts < maxAttempts;
    boundedSet(retries, params.historyKey, {
      marker: params.marker,
      attempts,
      nextAttemptAt: retryable ? now() + cooldownMs : 0,
    });
    if (retryable) {
      // Release the marker so a later turn re-enters recovery. The record above
      // is what still holds the cooldown and the remaining budget.
      markers.delete(params.historyKey);
    }
    logVerboseMessage?.(
      `mattermost: thread backfill ${retryable ? "retry scheduled" : "gave up"} ` +
        `historyKey=${params.historyKey} attempt=${attempts}/${maxAttempts}`,
    );
  };

  const runRecovery = async (params: {
    historyKey: string;
    marker: string;
    threadRootId: string;
    currentPostId: string;
  }): Promise<void> => {
    try {
      const entries = await fetchThreadEntries(params);
      if (markers.get(params.historyKey) !== params.marker) {
        // A newer session rotated in mid-flight. Its window and its own retry
        // budget both belong to it, so a stale completion touches neither.
        logVerboseMessage?.(
          `mattermost: thread backfill discarded a stale completion historyKey=${params.historyKey}`,
        );
        return;
      }
      // The request itself succeeded, so this marker is settled regardless of
      // how many posts came back; drop any budget it had spent.
      retries.delete(params.historyKey);
      if (entries.length > 0) {
        channelHistories.set(params.historyKey, entries);
        logVerboseMessage?.(
          `mattermost: thread backfill seeded ${entries.length} entries historyKey=${params.historyKey}`,
        );
      }
    } catch (error) {
      recordFailure({ historyKey: params.historyKey, marker: params.marker, error });
    }
  };

  const ensureThreadHistory = async (params: EnsureThreadHistoryParams): Promise<void> => {
    if (historyLimit <= 0 || !params.historyKey || !params.threadRootId) {
      return;
    }
    const { agentId, historyKey } = params;
    const sessionId = resolveSessionId({ historyKey, agentId });
    const pendingMarker = resolveRecoveryMarker({ historyKey, sessionId: undefined });
    const marker = resolveRecoveryMarker({ historyKey, sessionId });
    const currentMarker = markers.get(historyKey);

    if (currentMarker === marker) {
      await settleInFlight(historyKey);
      return;
    }

    if (sessionId && currentMarker === pendingMarker) {
      // A first cold turn can run before the session entry receives its id. Let
      // that recovery finish under the pending marker before adopting the real
      // one; rotating first would make its completion look stale and throw away
      // context that was correctly recovered.
      await settleInFlight(historyKey);
      if (markers.get(historyKey) === pendingMarker) {
        boundedSet(markers, historyKey, marker);
      }
      return;
    }

    // A retryable failure releases the marker, so reaching here does not prove
    // the thread was never serviced. The retry record is what separates a cold
    // thread from one between attempts, and it has to be read before the
    // first-sighting shortcut below: the failed turn's own message rebuilds the
    // in-memory window, which would otherwise look like history worth keeping
    // and would cancel the remaining attempts.
    const retryRecord = retries.get(historyKey);
    const retryOwned = retryRecord?.marker === marker;
    if (!mayAttemptRecovery({ record: retryRecord, marker, now: now(), maxAttempts })) {
      // Cooling down or out of budget: do not fetch, and do not mark serviced,
      // so a later turn past the cooldown can still recover the thread.
      await settleInFlight(historyKey);
      return;
    }

    const existingHistory = channelHistories.get(historyKey) ?? [];
    if (existingHistory.length > 0 && currentMarker === undefined && !retryOwned) {
      // First sighting already has in-memory history, so the thread is warm.
      // Mark it serviced now: the window the kernel clears after this turn must
      // not make the next turn look cold.
      boundedSet(markers, historyKey, marker);
      return;
    }

    boundedSet(markers, historyKey, marker);
    const recovery = runRecovery({
      historyKey,
      marker,
      threadRootId: params.threadRootId,
      currentPostId: params.currentPostId,
    });
    inFlight.set(historyKey, recovery);
    try {
      await recovery;
    } finally {
      if (inFlight.get(historyKey) === recovery) {
        inFlight.delete(historyKey);
      }
    }
  };

  return { ensureThreadHistory };
}

/**
 * Reads the session id backing a history key, or `undefined` when the store has
 * no entry yet. Store access is best-effort: recovery must not break an inbound
 * turn because the session file is missing or unreadable.
 */
export function createSessionIdResolver(
  configuredStorePath: string | undefined,
): (params: { historyKey: string; agentId: string }) => string | undefined {
  return ({ historyKey, agentId }) => {
    try {
      const storePath = resolveStorePath(configuredStorePath, { agentId });
      return getSessionEntry({ storePath, sessionKey: historyKey, agentId })?.sessionId;
    } catch {
      return undefined;
    }
  };
}
