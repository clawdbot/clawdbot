import { IDBFactory } from "fake-indexeddb";
import type { ReactiveController } from "lit";
import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { observeChatCache, type ChatMessageCache } from "./session-message-cache.ts";
import { installSessionPrefetch } from "./session-prefetch.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

export const PREFETCH_TEST_NOW = 1_000_000;
export const prefetchSnapshotHost = { assistantAgentId: "main", agentsList: null, hello: null };

export type SessionPrefetchUpdate = {
  client: GatewayBrowserClient | null;
  listRevision: number;
  openSessionKeys: readonly string[];
  /** Presented panes still fetching their transcript; omitted panes report committed. */
  loadingSessionKeys?: readonly string[];
  rows: readonly GatewaySessionRow[] | null;
};

export function prefetchSessionRow(
  key: string,
  activityAt: number | undefined,
  updatedAt = activityAt ?? 0,
): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt,
    ...(activityAt === undefined ? {} : { lastActivityAt: activityAt }),
  };
}

export function prefetchHistoryResult(sessionKey: string) {
  return {
    completeSnapshot: true,
    messages: [{ role: "assistant", content: sessionKey }],
    sessionId: `id:${sessionKey}`,
  };
}

export function prefetchSessionKeyFromCall(call: unknown[]): string {
  return (call[1] as { sessionKey: string }).sessionKey;
}

export async function settleSessionPrefetch(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await Promise.resolve();
  }
}

export function createSessionPrefetchFixture() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(PREFETCH_TEST_NOW);
  vi.stubGlobal("indexedDB", new IDBFactory());
  let visibility: DocumentVisibilityState = "visible";
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  const originalCancelIdleCallback = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: (callback: IdleRequestCallback) =>
      window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0),
  });
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const cache: ChatMessageCache = new Map();
  const store = new SessionSnapshotStore(cache);
  store.connect();
  observeChatCache(cache, store);
  let current: SessionPrefetchUpdate = {
    client: null,
    listRevision: 0,
    openSessionKeys: [],
    rows: null,
  };
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const gatewayListeners = new Set<() => void>();
  const context = {
    agents: { state: { agentsList: null } },
    gateway: {
      snapshot: { assistantAgentId: "main", hello: null },
      subscribe: (listener: () => void) => {
        gatewayListeners.add(listener);
        return () => gatewayListeners.delete(listener);
      },
    },
    sessions: {
      captureConnectionScope: () => connection.capture(),
      isConnectionScopeCurrent: (scope: Parameters<typeof connection.isCurrent>[0]) =>
        connection.isCurrent(scope),
      subscribe: () => () => undefined,
      get canonicalListRevision() {
        return current.listRevision;
      },
      get state() {
        return { result: current.rows ? { sessions: current.rows } : null };
      },
    },
  };
  const host = Object.assign(document.createElement("div"), {
    addController: (_controller: ReactiveController) => undefined,
    removeController: (_controller: ReactiveController) => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
  });
  const shell = document.createElement("openclaw-app-shell");
  shell.append(host);
  document.body.append(shell);
  const controller = installSessionPrefetch(host, cache, store, () => context);
  controller.hostConnected?.();

  function updatePrefetch(update: SessionPrefetchUpdate): void {
    current = update;
    connection.transition({
      client: update.client,
      phase: update.client ? "connected" : "stopped",
    });
    host.replaceChildren(
      ...update.openSessionKeys.map((sessionKey) =>
        Object.assign(document.createElement("openclaw-chat-pane"), {
          sessionKey,
          transcriptLoading: update.loadingSessionKeys?.includes(sessionKey) === true,
        }),
      ),
    );
    controller.hostUpdated?.();
  }

  return {
    cache,
    store,
    host,
    shell,
    updatePrefetch,
    setVisibility: (value: DocumentVisibilityState) => {
      visibility = value;
    },
    dispose: async () => {
      controller.hostDisconnected?.();
      shell.remove();
      await store.flush();
      store.disconnect();
      await store.whenIdle();
      await clearStoredChatSnapshots();
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
      if (originalLocks) {
        Object.defineProperty(navigator, "locks", originalLocks);
      } else {
        Reflect.deleteProperty(navigator, "locks");
      }
      if (originalRequestIdleCallback) {
        Object.defineProperty(window, "requestIdleCallback", originalRequestIdleCallback);
      } else {
        Reflect.deleteProperty(window, "requestIdleCallback");
      }
      if (originalCancelIdleCallback) {
        Object.defineProperty(window, "cancelIdleCallback", originalCancelIdleCallback);
      } else {
        Reflect.deleteProperty(window, "cancelIdleCallback");
      }
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}
