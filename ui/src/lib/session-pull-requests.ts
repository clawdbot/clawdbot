import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ControlUiSessionPullRequestSnapshot,
  ControlUiSessionPullRequestsChanged,
} from "../../../src/gateway/control-ui-contract.js";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";
import { createGatewayRetryOwner } from "./gateway-retry.ts";
import { readSessionChangedEvent } from "./sessions/reconcile.ts";
import { normalizeAgentId, parseAgentSessionKey } from "./sessions/session-key.ts";

export const SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD = "controlUi.sessionPullRequests.subscribe";

export type SessionPullRequestSnapshotStore = {
  watch: (
    owner: object,
    sessionKeys: readonly string[],
    options?: { foreground?: boolean },
  ) => void;
  unwatch: (owner: object) => void;
  load: (
    owner: object,
    sessionKey: string,
  ) => Promise<ControlUiSessionPullRequestSnapshot | undefined>;
  refresh: (sessionKey: string) => void;
  get: (sessionKey: string) => ControlUiSessionPullRequestSnapshot | undefined;
  subscribe: (listener: () => void) => () => void;
};

const stores = new WeakMap<ApplicationGateway, SessionPullRequestSnapshotStore>();

export function scopedSessionPullRequestKey(sessionKey: string, agentId?: string): string {
  const key = sessionKey.trim();
  if (!key || parseAgentSessionKey(key) || !agentId?.trim()) {
    return key;
  }
  return `agent:${normalizeAgentId(agentId)}:${key}`;
}

function readChangedSessions(
  payload: unknown,
): ControlUiSessionPullRequestsChanged["sessions"] | null {
  if (!payload || typeof payload !== "object" || !("sessions" in payload)) {
    return null;
  }
  const sessions = (payload as { sessions?: unknown }).sessions;
  return asNullableRecord(sessions) as ControlUiSessionPullRequestsChanged["sessions"] | null;
}

function createStore(gateway: ApplicationGateway): SessionPullRequestSnapshotStore {
  const watchedByOwner = new Map<object, { keys: Set<string>; foreground: boolean }>();
  const loadTokens = new WeakMap<object, object>();
  const snapshots = new Map<string, ControlUiSessionPullRequestSnapshot>();
  const listeners = new Set<() => void>();
  const waiters = new Map<
    string,
    Set<(snapshot: ControlUiSessionPullRequestSnapshot | undefined) => void>
  >();
  const pendingRefreshKeys = new Set<string>();
  const retry = createGatewayRetryOwner();
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  let lastHello: object | null = null;
  let lastSignature: string | null = null;
  let syncRequestGeneration = 0;
  let syncScheduled = false;
  let syncScheduleGeneration = 0;
  let attached = false;
  let stopGatewaySnapshots: (() => void) | null = null;
  let stopGatewayEvents: (() => void) | null = null;
  let visibilityDocument: Document | null = null;

  const notify = () => {
    for (const listener of Array.from(listeners)) {
      listener();
    }
  };

  const settle = (sessionKey: string, snapshot?: ControlUiSessionPullRequestSnapshot) => {
    const pending = waiters.get(sessionKey);
    if (!pending) {
      return;
    }
    waiters.delete(sessionKey);
    for (const resolve of pending) {
      resolve(snapshot);
    }
  };

  const watchedKeys = (): string[] => {
    const keys = new Map<string, boolean>();
    for (const watched of watchedByOwner.values()) {
      for (const key of watched.keys) {
        keys.set(key, (keys.get(key) ?? false) || watched.foreground);
      }
    }
    return [...keys]
      .toSorted(
        ([leftKey, leftForeground], [rightKey, rightForeground]) =>
          Number(rightForeground) - Number(leftForeground) || leftKey.localeCompare(rightKey),
      )
      .slice(0, CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS)
      .map(([key]) => key);
  };

  const pruneUnwatched = () => {
    const watched = new Set(watchedKeys());
    for (const key of pendingRefreshKeys) {
      if (!watched.has(key)) {
        pendingRefreshKeys.delete(key);
      }
    }
    for (const key of waiters.keys()) {
      if (!watched.has(key)) {
        settle(key);
      }
    }
    for (const key of snapshots.keys()) {
      if (!watched.has(key)) {
        snapshots.delete(key);
      }
    }
  };

  const isActive = () => watchedByOwner.size > 0 || listeners.size > 0 || waiters.size > 0;

  const retireConnection = () => {
    syncRequestGeneration += 1;
    lastHello = null;
    lastSignature = null;
    const hadSnapshots = snapshots.size > 0;
    snapshots.clear();
    for (const key of waiters.keys()) {
      settle(key);
    }
    if (hadSnapshots) {
      notify();
    }
  };

  const handleGatewaySnapshot = (snapshot: ApplicationGateway["snapshot"]) => {
    const changed = connection.transition(snapshot);
    if (changed) {
      retireConnection();
    }
    if (changed || snapshot.hello !== lastHello) {
      retry.reset();
      scheduleSync();
    }
  };

  const handleGatewayEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] = (event) => {
    if (event.event === "sessions.changed") {
      const changed = readSessionChangedEvent(event.payload);
      if (!changed?.isStructural) {
        return;
      }
      const scopedEventKey = scopedSessionPullRequestKey(changed.key, changed.agentId ?? undefined);
      if (!watchedKeys().includes(scopedEventKey)) {
        return;
      }
      const removed = snapshots.delete(scopedEventKey);
      pendingRefreshKeys.add(scopedEventKey);
      retry.reset();
      if (removed) {
        notify();
      }
      scheduleSync();
      return;
    }
    if (event.event !== CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT) {
      return;
    }
    const changed = readChangedSessions(event.payload);
    if (!changed) {
      return;
    }
    const watched = new Set(watchedKeys());
    for (const [sessionKey, snapshot] of Object.entries(changed)) {
      if (!watched.has(sessionKey)) {
        continue;
      }
      const current = snapshots.get(sessionKey);
      let next = snapshot;
      if (current && snapshot.status === "rate-limited" && snapshot.pullRequests.length === 0) {
        next = {
          ...snapshot,
          pullRequests: current.pullRequests,
          branch: snapshot.branch ?? current.branch,
        };
      } else if (
        current &&
        snapshot.status === "unavailable" &&
        (current.pullRequests.length > 0 || current.branch !== undefined)
      ) {
        next = { ...current, status: "unavailable" };
      }
      snapshots.set(sessionKey, next);
      settle(sessionKey, next);
    }
    notify();
  };

  const handleVisibilityChange = () => {
    retry.reset();
    scheduleSync();
  };

  const attachExternalRegistrations = () => {
    if (attached) {
      return;
    }
    attached = true;
    if (connection.transition(gateway.snapshot)) {
      retireConnection();
    }
    lastHello = null;
    lastSignature = null;
    // Active consumers own these registrations: isolate:false workers share document, so an
    // always-on visibility listener would root every per-gateway store and fake gateway.
    stopGatewaySnapshots = gateway.subscribe(handleGatewaySnapshot);
    stopGatewayEvents = gateway.subscribeEvents(handleGatewayEvent);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
      visibilityDocument = document;
    }
  };

  const detachExternalRegistrations = () => {
    if (!attached) {
      return;
    }
    attached = false;
    stopGatewaySnapshots?.();
    stopGatewaySnapshots = null;
    stopGatewayEvents?.();
    stopGatewayEvents = null;
    visibilityDocument?.removeEventListener("visibilitychange", handleVisibilityChange);
    visibilityDocument = null;
    retry.reset();
    syncRequestGeneration += 1;
    syncScheduleGeneration += 1;
    syncScheduled = false;
    lastHello = null;
    lastSignature = null;
    snapshots.clear();
  };

  function sync() {
    syncScheduled = false;
    if (!attached) {
      return;
    }
    const snapshot = gateway.snapshot;
    const client = snapshot.client;
    const available =
      snapshot.phase === "connected" &&
      client !== null &&
      snapshot.hello !== null &&
      isGatewayMethodAdvertised(snapshot, SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) === true;
    if (!available) {
      lastHello = null;
      lastSignature = null;
      for (const key of waiters.keys()) {
        settle(key);
      }
      if (!isActive()) {
        detachExternalRegistrations();
      }
      return;
    }
    const sessionKeys =
      typeof document !== "undefined" && document.visibilityState === "hidden" ? [] : watchedKeys();
    const sessionKeySet = new Set(sessionKeys);
    const refreshSessionKeys = [...pendingRefreshKeys].filter((key) => sessionKeySet.has(key));
    const signature = JSON.stringify(sessionKeys);
    if (
      snapshot.hello === lastHello &&
      signature === lastSignature &&
      refreshSessionKeys.length === 0
    ) {
      if (!isActive()) {
        detachExternalRegistrations();
      }
      return;
    }
    lastHello = snapshot.hello;
    lastSignature = signature;
    const requestGeneration = ++syncRequestGeneration;
    const isCurrentRequest = () =>
      attached &&
      isActive() &&
      requestGeneration === syncRequestGeneration &&
      snapshot.hello === lastHello &&
      signature === lastSignature;
    retry.cancel();
    const request = client.request(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD, {
      sessionKeys,
      ...(refreshSessionKeys.length > 0 ? { refreshSessionKeys } : {}),
    });
    if (!isActive()) {
      detachExternalRegistrations();
    }
    void request
      .then(() => {
        if (isCurrentRequest()) {
          for (const key of refreshSessionKeys) {
            pendingRefreshKeys.delete(key);
          }
          retry.reset();
        }
      })
      .catch(() => {
        if (isCurrentRequest()) {
          lastSignature = null;
          retry.schedule(() => {
            if (attached && isActive()) {
              scheduleSync();
            }
          });
          for (const key of sessionKeys) {
            settle(key);
          }
        }
      });
  }

  function scheduleSync() {
    if (!attached || syncScheduled) {
      return;
    }
    syncScheduled = true;
    const generation = syncScheduleGeneration;
    globalThis.queueMicrotask(() => {
      if (generation === syncScheduleGeneration) {
        sync();
      }
    });
  }

  const watch = (
    owner: object,
    sessionKeys: readonly string[],
    options: { foreground?: boolean } = {},
  ) => {
    const wasActive = isActive();
    const next = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
    const current = watchedByOwner.get(owner);
    const unchanged =
      current === undefined
        ? next.size === 0
        : current.keys.size === next.size &&
          current.foreground === (options.foreground === true) &&
          [...next].every((sessionKey) => current.keys.has(sessionKey));
    if (unchanged) {
      return;
    }
    if (next.size === 0) {
      watchedByOwner.delete(owner);
    } else {
      watchedByOwner.set(owner, { keys: next, foreground: options.foreground === true });
    }
    retry.reset();
    pruneUnwatched();
    if (isActive()) {
      if (!wasActive) {
        lastHello = null;
        lastSignature = null;
      }
      attachExternalRegistrations();
      scheduleSync();
    } else if (attached) {
      sync();
    }
  };

  return {
    watch,
    unwatch: (owner) => {
      loadTokens.delete(owner);
      watch(owner, []);
    },
    load: async (owner, sessionKey) => {
      const key = sessionKey.trim();
      if (!key) {
        return undefined;
      }
      const loadToken = {};
      loadTokens.set(owner, loadToken);
      // A one-shot load owns a foreground watch until it settles, which attaches the store
      // before the waiter is registered and keeps gateway events available for resolution.
      watch(owner, [key], { foreground: true });
      try {
        const current = snapshots.get(key);
        if (current) {
          return current;
        }
        if (
          gateway.snapshot.phase !== "connected" ||
          isGatewayMethodAdvertised(gateway.snapshot, SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD) !==
            true
        ) {
          return undefined;
        }
        return await new Promise((resolve) => {
          const pending = waiters.get(key) ?? new Set();
          pending.add(resolve);
          waiters.set(key, pending);
          scheduleSync();
        });
      } finally {
        const currentWatch = watchedByOwner.get(owner);
        if (
          loadTokens.get(owner) === loadToken &&
          currentWatch?.keys.size === 1 &&
          currentWatch.keys.has(key)
        ) {
          loadTokens.delete(owner);
          watch(owner, []);
        }
      }
    },
    refresh: (sessionKey) => {
      const key = sessionKey.trim();
      if (!key || !watchedKeys().includes(key)) {
        return;
      }
      pendingRefreshKeys.add(key);
      retry.reset();
      scheduleSync();
    },
    get: (sessionKey) => snapshots.get(sessionKey),
    subscribe: (listener) => {
      const wasActive = isActive();
      listeners.add(listener);
      if (!wasActive) {
        lastHello = null;
        lastSignature = null;
      }
      attachExternalRegistrations();
      return () => {
        if (listeners.delete(listener)) {
          if (isActive()) {
            scheduleSync();
          } else if (attached) {
            sync();
          }
        }
      };
    },
  };
}

export function sessionPullRequestsForGateway(
  gateway: ApplicationGateway,
): SessionPullRequestSnapshotStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
  const store = createStore(gateway);
  stores.set(gateway, store);
  return store;
}
