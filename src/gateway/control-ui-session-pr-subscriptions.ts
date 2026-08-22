import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequests,
  ControlUiSessionPullRequestsChanged,
} from "./control-ui-contract.js";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "./control-ui-contract.js";
import type { ControlUiSessionPullRequestsParams } from "./control-ui-session-prs.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";

const CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS = 60_000;

type LoadSessionPullRequests = (
  params: ControlUiSessionPullRequestsParams,
) => Promise<ControlUiSessionPullRequests>;

type SubscriptionDeps = {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  isConnectionActive?: (connId: string) => boolean;
  load?: LoadSessionPullRequests;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
};

type ControlUiSessionPullRequestSubscriptions = {
  replace: (
    connId: string,
    sessionKeys: readonly string[],
    refreshSessionKeys?: ReadonlySet<string>,
  ) => Promise<void>;
  unsubscribe: (connId: string) => void;
  pollNow: () => Promise<void>;
  stop: () => void;
};

async function loadSessionPullRequests(
  params: ControlUiSessionPullRequestsParams,
): Promise<ControlUiSessionPullRequests> {
  const { loadControlUiSessionPullRequests } = await import("./control-ui-session-prs.js");
  return await loadControlUiSessionPullRequests(params);
}

function pushedSnapshot(result: ControlUiSessionPullRequests): ControlUiSessionPullRequestSnapshot {
  return {
    ...result,
    status: result.rateLimited ? "rate-limited" : "ready",
  };
}

const UNAVAILABLE_SNAPSHOT: ControlUiSessionPullRequestSnapshot = {
  pullRequests: [],
  rateLimited: false,
  status: "unavailable",
};

function snapshotHash(snapshot: ControlUiSessionPullRequestSnapshot): string {
  return JSON.stringify(snapshot);
}

function emptySessionDeltas(): ControlUiSessionPullRequestsChanged["sessions"] {
  return Object.create(null) as ControlUiSessionPullRequestsChanged["sessions"];
}

function loaderParams(sessionKey: string, refresh: boolean): ControlUiSessionPullRequestsParams {
  const parsed = parseAgentSessionKey(sessionKey);
  // Global is persisted as an unscoped sentinel inside each agent store. The
  // watch key keeps its agent prefix so concurrent global views stay distinct.
  const params: ControlUiSessionPullRequestsParams =
    parsed?.rest === "global" ? { sessionKey: "global", agentId: parsed.agentId } : { sessionKey };
  return refresh ? { ...params, refresh: true } : params;
}

function parseSessionKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS) {
    return null;
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const key = entry.trim();
    if (!key || key.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
      return null;
    }
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function parseControlUiSessionPullRequestsSubscribeParams(
  value: unknown,
): { sessionKeys: string[]; refreshSessionKeys: string[] } | null {
  if (!value || typeof value !== "object" || !("sessionKeys" in value)) {
    return null;
  }
  const raw = value as { sessionKeys?: unknown; refreshSessionKeys?: unknown };
  const sessionKeys = parseSessionKeys(raw.sessionKeys);
  const refreshSessionKeys =
    raw.refreshSessionKeys === undefined ? [] : parseSessionKeys(raw.refreshSessionKeys);
  if (!sessionKeys || !refreshSessionKeys) {
    return null;
  }
  const watched = new Set(sessionKeys);
  for (const key of refreshSessionKeys) {
    if (!watched.has(key)) {
      return null;
    }
  }
  return { sessionKeys, refreshSessionKeys };
}

/**
 * Owns the union of connection replace-sets. Only this union drives GitHub
 * refreshes, so hidden/disconnected clients cannot leave orphan polling work.
 */
export function createControlUiSessionPullRequestSubscriptions(
  deps: SubscriptionDeps,
): ControlUiSessionPullRequestSubscriptions {
  const subscriptions = new Map<string, { keys: Set<string>; delivered: Set<string> }>();
  const replacementTokens = new Map<string, object>();
  const snapshots = new Map<
    string,
    { hash: string; snapshot: ControlUiSessionPullRequestSnapshot }
  >();
  const inflight = new Map<
    string,
    { promise: Promise<ControlUiSessionPullRequestSnapshot>; refresh: boolean }
  >();
  const setTimer = deps.setTimer ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimer ?? globalThis.clearTimeout;
  const load = deps.load ?? loadSessionPullRequests;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let stopped = false;

  const subscribersForKey = (sessionKey: string): Set<string> => {
    const connIds = new Set<string>();
    for (const [connId, { keys }] of subscriptions) {
      if (keys.has(sessionKey)) {
        connIds.add(connId);
      }
    }
    return connIds;
  };

  const watchedKeys = (): Set<string> => {
    const keys = new Set<string>();
    for (const { keys: watched } of subscriptions.values()) {
      for (const key of watched) {
        keys.add(key);
      }
    }
    return keys;
  };

  const loadSnapshot = (
    sessionKey: string,
    refresh = false,
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const pending = inflight.get(sessionKey);
    if (pending) {
      if (!refresh || pending.refresh) {
        return pending.promise;
      }
      // Serialize a forced refresh behind an older normal load so that older
      // poll results can never land after the refresh and revert its snapshot.
      return pending.promise.then(() => loadSnapshot(sessionKey, true));
    }
    const promise = load(loaderParams(sessionKey, refresh))
      .then(pushedSnapshot)
      .catch(() => UNAVAILABLE_SNAPSHOT)
      .finally(() => {
        if (inflight.get(sessionKey)?.promise === promise) {
          inflight.delete(sessionKey);
        }
      });
    inflight.set(sessionKey, { promise, refresh });
    return promise;
  };

  const push = (
    connIds: ReadonlySet<string>,
    sessionKey: string,
    snapshot: ControlUiSessionPullRequestSnapshot,
  ) => {
    if (connIds.size === 0) {
      return;
    }
    const sessions = emptySessionDeltas();
    sessions[sessionKey] = snapshot;
    deps.broadcastToConnIds(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, { sessions }, connIds);
    for (const connId of connIds) {
      const subscription = subscriptions.get(connId);
      if (subscription?.keys.has(sessionKey)) {
        subscription.delivered.add(sessionKey);
      }
    }
  };

  const pruneOrphans = () => {
    const watched = watchedKeys();
    for (const key of snapshots.keys()) {
      if (!watched.has(key)) {
        snapshots.delete(key);
      }
    }
  };

  const schedulePoll = () => {
    if (stopped || timer !== null || watchedKeys().size === 0) {
      return;
    }
    timer = setTimer(() => {
      timer = null;
      void pollNow().finally(schedulePoll);
    }, CONTROL_UI_SESSION_PR_POLL_INTERVAL_MS);
    timer.unref?.();
  };

  const pollNow = async () => {
    if (stopped) {
      return;
    }
    // One union pass owns each key once; the loader retains its failure and
    // rate-limit cache, so the poller never creates a second quota policy.
    for (const sessionKey of watchedKeys()) {
      if (stopped) {
        break;
      }
      const snapshot = await loadSnapshot(sessionKey);
      const connIds = subscribersForKey(sessionKey);
      if (connIds.size === 0) {
        continue;
      }
      const hash = snapshotHash(snapshot);
      if (snapshots.get(sessionKey)?.hash === hash) {
        continue;
      }
      snapshots.set(sessionKey, { hash, snapshot });
      // Publish before awaiting another key; cross-key batching can otherwise
      // deliver an older poll result after a newer forced refresh.
      push(connIds, sessionKey, snapshot);
    }
  };

  const replace = async (
    connId: string,
    sessionKeys: readonly string[],
    refreshSessionKeys: ReadonlySet<string> = new Set(),
  ) => {
    if (stopped) {
      return;
    }
    const normalizedConnId = connId.trim();
    if (!normalizedConnId || deps.isConnectionActive?.(normalizedConnId) === false) {
      return;
    }
    const replacementToken = {};
    replacementTokens.set(normalizedConnId, replacementToken);
    const next = new Set(sessionKeys);
    if (next.size === 0) {
      subscriptions.delete(normalizedConnId);
      pruneOrphans();
      if (watchedKeys().size === 0 && timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      return;
    }
    const delivered = subscriptions.get(normalizedConnId)?.delivered ?? new Set<string>();
    for (const sessionKey of delivered) {
      if (!next.has(sessionKey)) {
        delivered.delete(sessionKey);
      }
    }
    subscriptions.set(normalizedConnId, { keys: next, delivered });
    pruneOrphans();
    schedulePoll();

    for (const sessionKey of next) {
      if (stopped) {
        break;
      }
      const previous = snapshots.get(sessionKey);
      const refresh = refreshSessionKeys.has(sessionKey);
      const cached = refresh ? undefined : previous?.snapshot;
      // A shared cached snapshot does not prove this connection received it.
      if (cached && delivered.has(sessionKey)) {
        continue;
      }
      const snapshot = cached ?? (await loadSnapshot(sessionKey, refresh));
      // A later replace-set owns the connection immediately; an older async
      // initial load must never publish keys after that ownership changed.
      if (replacementTokens.get(normalizedConnId) !== replacementToken) {
        return;
      }
      const hash = snapshotHash(snapshot);
      if (!cached) {
        snapshots.set(sessionKey, { hash, snapshot });
      }
      if (refresh && previous?.hash !== hash) {
        push(subscribersForKey(sessionKey), sessionKey, snapshot);
      } else {
        // Initial snapshots are also per-key so a later async load cannot
        // delay an old cached value past a concurrent refresh.
        push(new Set([normalizedConnId]), sessionKey, snapshot);
      }
    }
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (!normalizedConnId) {
      return;
    }
    replacementTokens.delete(normalizedConnId);
    subscriptions.delete(normalizedConnId);
    pruneOrphans();
    if (watchedKeys().size === 0 && timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    subscriptions.clear();
    replacementTokens.clear();
    snapshots.clear();
    inflight.clear();
  };

  return { replace, unsubscribe, pollNow, stop };
}
