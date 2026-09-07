import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
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
import { createGatewaySetSyncLifecycle } from "./gateway-set-sync-lifecycle.ts";
import { readSessionChangedEvent } from "./sessions/reconcile.ts";
import { uiSessionEventMatches } from "./sessions/session-key.ts";

export function sessionGitHubRepository(
  snapshot: ControlUiSessionPullRequests | undefined,
): { owner: string; repo: string } | null {
  const repository = snapshot?.repository ?? snapshot?.branch ?? snapshot?.pullRequests[0];
  return repository ? { owner: repository.owner, repo: repository.repo } : null;
}

export function summarizeSessionPullRequests(
  pullRequests: readonly ControlUiSessionPullRequest[],
  previous?: SessionCatalogPullRequestSummary,
): SessionCatalogPullRequestSummary | undefined {
  // Keep active work ahead of newer merged/closed history, as the sidebar and PR menu do.
  const current =
    pullRequests.find(({ state }) => state === "open") ??
    pullRequests.find(({ state }) => state === "draft") ??
    pullRequests.find(({ state }) => state === "merged") ??
    pullRequests[0];
  if (!current) {
    return undefined;
  }
  const numbers = [...new Set(pullRequests.map((pullRequest) => pullRequest.number))]
    .slice(0, 20)
    .toSorted((left, right) => left - right);
  return previous?.state === current.state && previous.numbers.join(",") === numbers.join(",")
    ? previous
    : { numbers, state: current.state };
}

export const SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD = "controlUi.sessionPullRequests.subscribe";

const STRUCTURAL_SESSION_REASONS = new Set<unknown>([
  "new",
  "reset",
  "branch-switch",
  "fork",
  "rewind",
]);

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
  refresh: (sessionKey: string) => boolean;
  get: (sessionKey: string) => ControlUiSessionPullRequestSnapshot | undefined;
  subscribe: (listener: () => void) => () => void;
};

const stores = new WeakMap<ApplicationGateway, SessionPullRequestSnapshotStore>();

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
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  let lastHello: object | null = null;
  let lastSignature: string | null = null;
  let syncRequestGeneration = 0;

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
      lifecycle.schedule();
    }
  };

  const handleGatewayEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] = (event) => {
    if (event.event === "sessions.changed") {
      const changed = readSessionChangedEvent(event.payload);
      const reason = asNullableRecord(event.payload)?.reason;
      if (!changed || !STRUCTURAL_SESSION_REASONS.has(reason)) {
        return;
      }
      const matchingKeys = watchedKeys().filter((sessionKey) =>
        uiSessionEventMatches(
          {
            assistantAgentId: gateway.snapshot.assistantAgentId,
            hello: gateway.snapshot.hello,
            sessionKey,
          },
          changed.key,
          changed.agentId,
        ),
      );
      if (matchingKeys.length === 0) {
        return;
      }
      let removed = false;
      for (const sessionKey of matchingKeys) {
        removed = snapshots.delete(sessionKey) || removed;
        pendingRefreshKeys.add(sessionKey);
      }
      retry.reset();
      if (removed) {
        notify();
      }
      lifecycle.schedule();
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
      const repository = sessionGitHubRepository(snapshot);
      const currentRepository = sessionGitHubRepository(current);
      const canRetainCurrent =
        !repository ||
        (repository.owner === currentRepository?.owner &&
          repository.repo === currentRepository?.repo);
      let next = snapshot;
      if (
        current &&
        canRetainCurrent &&
        snapshot.status === "rate-limited" &&
        snapshot.pullRequests.length === 0
      ) {
        next = {
          ...snapshot,
          pullRequests: current.pullRequests,
          branch: snapshot.branch ?? current.branch,
          repository: snapshot.repository ?? current.repository,
        };
      } else if (
        current &&
        canRetainCurrent &&
        snapshot.status === "unavailable" &&
        (current.pullRequests.length > 0 ||
          current.branch !== undefined ||
          current.repository !== undefined)
      ) {
        next = {
          ...current,
          repository: snapshot.repository ?? current.repository,
          status: "unavailable",
        };
      }
      snapshots.set(sessionKey, next);
      settle(sessionKey, next);
    }
    notify();
  };

  const lifecycle = createGatewaySetSyncLifecycle(gateway, {
    sync,
    onSnapshot: handleGatewaySnapshot,
    onEvent: handleGatewayEvent,
    onAttach: () => {
      if (connection.transition(gateway.snapshot)) {
        retireConnection();
      }
      lastHello = null;
      lastSignature = null;
    },
    onDetach: () => {
      syncRequestGeneration += 1;
      lastHello = null;
      lastSignature = null;
      snapshots.clear();
    },
  });
  const { retry } = lifecycle;

  function sync() {
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
        lifecycle.detach();
      }
      return;
    }
    const sessionKeys =
      typeof document !== "undefined" && document.visibilityState === "hidden" ? [] : watchedKeys();
    const sessionKeySet = new Set(sessionKeys);
    const refreshSessionKeys = [...pendingRefreshKeys].filter((key) => sessionKeySet.has(key));
    const signature = JSON.stringify(sessionKeys.toSorted());
    if (
      snapshot.hello === lastHello &&
      signature === lastSignature &&
      refreshSessionKeys.length === 0
    ) {
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    lastHello = snapshot.hello;
    lastSignature = signature;
    const requestGeneration = ++syncRequestGeneration;
    const isCurrentRequest = () =>
      lifecycle.attached &&
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
      lifecycle.detach();
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
            if (lifecycle.attached && isActive()) {
              lifecycle.schedule();
            }
          });
          for (const key of sessionKeys) {
            settle(key);
          }
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
      lifecycle.attach();
      lifecycle.schedule();
    } else if (lifecycle.attached) {
      lifecycle.sync();
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
          lifecycle.schedule();
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
        return false;
      }
      pendingRefreshKeys.add(key);
      retry.reset();
      lifecycle.schedule();
      return true;
    },
    get: (sessionKey) => snapshots.get(sessionKey),
    subscribe: (listener) => {
      const wasActive = isActive();
      listeners.add(listener);
      if (!wasActive) {
        lastHello = null;
        lastSignature = null;
      }
      lifecycle.attach();
      return () => {
        if (listeners.delete(listener)) {
          if (isActive()) {
            lifecycle.schedule();
          } else if (lifecycle.attached) {
            lifecycle.sync();
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
