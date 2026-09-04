import pLimit from "p-limit";
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
const CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY = 4;

type LoadSessionPullRequests = (
  params: ControlUiSessionPullRequestsParams,
) => Promise<ControlUiSessionPullRequests>;

type WatchedKeyState = {
  hash?: string;
  snapshot?: ControlUiSessionPullRequestSnapshot;
};

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
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const key = entry.trim();
    if (!key || key.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
      return null;
    }
    keys.add(key);
  }
  return [...keys];
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
  // A retained key keeps its work and delivery lifetime; removing it retires that cell.
  const subscriptions = new Map<
    string,
    Map<string, { delivered?: ControlUiSessionPullRequestSnapshot }>
  >();
  const keyStates = new Map<string, WatchedKeyState>();
  const inflight = new Map<
    string,
    {
      promise: Promise<ControlUiSessionPullRequestSnapshot>;
      refresh: boolean;
      state: WatchedKeyState;
      demands: Set<() => boolean>;
    }
  >();
  const setTimer = deps.setTimer ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimer ?? globalThis.clearTimeout;
  const load = deps.load ?? loadSessionPullRequests;
  const limit = pLimit(CONTROL_UI_SESSION_PR_LOAD_CONCURRENCY);
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let stopped = false;

  const subscribersForKey = (sessionKey: string): Set<string> => {
    const connIds = new Set<string>();
    for (const [connId, keys] of subscriptions) {
      if (keys.has(sessionKey)) {
        connIds.add(connId);
      }
    }
    return connIds;
  };

  const watchedKeys = (): Set<string> => {
    const keys = new Set<string>();
    for (const watched of subscriptions.values()) {
      for (const key of watched.keys()) {
        keys.add(key);
      }
    }
    return keys;
  };

  const loadSnapshot = (
    sessionKey: string,
    isCurrent: () => boolean,
    refresh = false,
  ): Promise<ControlUiSessionPullRequestSnapshot> => {
    const state = keyStates.get(sessionKey);
    if (!state || !isCurrent()) {
      return Promise.resolve(UNAVAILABLE_SNAPSHOT);
    }
    const pending = inflight.get(sessionKey);
    if (pending) {
      if (pending.state === state && (!refresh || pending.refresh)) {
        pending.demands.add(isCurrent);
        return pending.promise;
      }
      // Serialize a forced refresh behind an older normal load so that older
      // poll results can never land after the refresh and revert its snapshot.
      return pending.promise.then(() => loadSnapshot(sessionKey, isCurrent, refresh));
    }
    const demands = new Set([isCurrent]);
    const promise = limit(async () => {
      // Joiners retain their own watched-key lifetimes. A later force-only
      // watcher must not revive normal work retired while waiting for a slot.
      if (!Array.from(demands).some((current) => current())) {
        return UNAVAILABLE_SNAPSHOT;
      }
      // Fresh result identity acknowledges forced loads even when the failure is unchanged.
      const snapshot = await load(loaderParams(sessionKey, refresh))
        .then(pushedSnapshot)
        .catch(() => ({ ...UNAVAILABLE_SNAPSHOT }));
      if (keyStates.get(sessionKey) === state) {
        const hash = JSON.stringify(snapshot);
        const changed = state.hash !== hash;
        Object.assign(state, { hash, snapshot });
        // Publish once at the shared owner, using the latest snapshot and watcher union.
        if (changed) {
          push(subscribersForKey(sessionKey), sessionKey, snapshot);
        }
      }
      return snapshot;
    }).finally(() => {
      if (inflight.get(sessionKey)?.promise === promise) {
        inflight.delete(sessionKey);
      }
    });
    inflight.set(sessionKey, { promise, refresh, state, demands });
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
    const sessions = Object.create(null) as ControlUiSessionPullRequestsChanged["sessions"];
    sessions[sessionKey] = snapshot;
    deps.broadcastToConnIds(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, { sessions }, connIds);
    for (const connId of connIds) {
      const watched = subscriptions.get(connId)?.get(sessionKey);
      if (watched) {
        watched.delivered = snapshot;
      }
    }
  };

  const pruneOrphans = () => {
    const watched = watchedKeys();
    for (const key of keyStates.keys()) {
      if (!watched.has(key)) {
        keyStates.delete(key);
      }
    }
  };

  const schedulePoll = () => {
    if (stopped || timer !== null || subscriptions.size === 0) {
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
    await Promise.all(
      Array.from(keyStates, ([sessionKey, state]) =>
        loadSnapshot(sessionKey, () => keyStates.get(sessionKey) === state),
      ),
    );
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
    const previousSubscription = subscriptions.get(normalizedConnId);
    const subscription = new Map(
      sessionKeys.map((key) => [key, previousSubscription?.get(key) ?? {}]),
    );
    if (subscription.size === 0) {
      unsubscribe(normalizedConnId);
      return;
    }
    subscriptions.set(normalizedConnId, subscription);
    pruneOrphans();
    schedulePoll();

    await Promise.all(
      Array.from(subscription, async ([sessionKey, watched]) => {
        let state = keyStates.get(sessionKey);
        if (!state) {
          keyStates.set(sessionKey, (state = {}));
        }
        const isCurrent = () => subscriptions.get(normalizedConnId)?.get(sessionKey) === watched;
        const refresh = refreshSessionKeys.has(sessionKey);
        const cached = refresh ? undefined : state.snapshot;
        // A shared cached snapshot does not prove this connection received it.
        if (cached) {
          if (!watched.delivered) {
            push(new Set([normalizedConnId]), sessionKey, cached);
          }
          return;
        }
        const snapshot = await loadSnapshot(sessionKey, isCurrent, refresh);
        // A removed/re-added key has a new cell; retained keys still need their result.
        if (isCurrent() && (refresh ? watched.delivered !== snapshot : !watched.delivered)) {
          push(new Set([normalizedConnId]), sessionKey, snapshot);
        }
      }),
    );
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (!normalizedConnId) {
      return;
    }
    subscriptions.delete(normalizedConnId);
    pruneOrphans();
    if (subscriptions.size === 0 && timer !== null) {
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
    keyStates.clear();
    inflight.clear();
  };

  return { replace, unsubscribe, pollNow, stop };
}
