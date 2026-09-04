/* @vitest-environment jsdom */

import { IDBFactory } from "fake-indexeddb";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  clearChatMessagesFromCache,
  observeChatCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { installSessionPrefetch } from "./session-prefetch.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";

const NOW = 1_000_000;
const snapshotHost = { assistantAgentId: "main", agentsList: null, hello: null };

type SessionPrefetchUpdate = {
  client: GatewayBrowserClient | null;
  listRevision: number;
  openSessionKeys: readonly string[];
  /** Presented panes still fetching their transcript; omitted panes report committed. */
  loadingSessionKeys?: readonly string[];
  rows: readonly GatewaySessionRow[] | null;
};

function row(
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

function historySnapshot(message: string, sessionId = `session-${message}`): ChatSessionSnapshot {
  return {
    messages: [{ role: "assistant", content: message }],
    pagination: { hasMore: false, completeSnapshot: true },
    sessionId,
  };
}

function historyResult(sessionKey: string) {
  return {
    completeSnapshot: true,
    messages: [{ role: "assistant", content: sessionKey }],
    sessionId: `id:${sessionKey}`,
  };
}

function sessionKeyFromCall(call: unknown[]): string {
  return (call[1] as { sessionKey: string }).sessionKey;
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await Promise.resolve();
  }
}

describe("recent session prefetch", () => {
  let visibility: DocumentVisibilityState;
  let cache: ChatMessageCache;
  let store: SessionSnapshotStore;
  let controller: ReactiveController;
  let host: HTMLElement & ReactiveControllerHost;
  let current: SessionPrefetchUpdate;
  let context: ApplicationContext;
  let connection: ReturnType<typeof createGatewayConnectionLifecycle>;
  let originalVisibility: PropertyDescriptor | undefined;
  let originalLocks: PropertyDescriptor | undefined;
  let originalRequestIdleCallback: PropertyDescriptor | undefined;
  let originalCancelIdleCallback: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("indexedDB", new IDBFactory());
    visibility = "visible";
    originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
    originalRequestIdleCallback = Object.getOwnPropertyDescriptor(window, "requestIdleCallback");
    originalCancelIdleCallback = Object.getOwnPropertyDescriptor(window, "cancelIdleCallback");
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
    cache = new Map();
    store = new SessionSnapshotStore(cache);
    store.connect();
    observeChatCache(cache, store);
    current = { client: null, listRevision: 0, openSessionKeys: [], rows: null };
    connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
    const gatewayListeners = new Set<() => void>();
    context = {
      agents: { state: { agentsList: null } },
      gateway: {
        get snapshot() {
          return {
            assistantAgentId: "main",
            client: current.client,
            hello: null,
            phase: current.client ? ("connected" as const) : ("stopped" as const),
          };
        },
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
    } as unknown as ApplicationContext;
    host = Object.assign(document.createElement("div"), {
      addController: (_controller: ReactiveController) => undefined,
      removeController: (_controller: ReactiveController) => undefined,
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
    });
    controller = installSessionPrefetch(host, cache, store, () => context);
    controller.hostConnected?.();
  });

  afterEach(async () => {
    controller.hostDisconnected?.();
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
  });

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

  /** Resolves pending history requests in arrival order, one per settle, like a serial socket. */
  async function drainSequentially(
    pending: Array<{
      resolve: (value: ReturnType<typeof historyResult>) => void;
      sessionKey: string;
    }>,
    request: { mock: { calls: unknown[][] } },
    expectedOrder: readonly string[],
  ): Promise<void> {
    for (const [index, sessionKey] of expectedOrder.entries()) {
      // Only the head of the queue is on the wire until it resolves.
      expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(expectedOrder.slice(0, index + 1));
      const head = pending.shift();
      expect(head?.sessionKey).toBe(sessionKey);
      head?.resolve(historyResult(sessionKey));
      await settlePromises();
    }
  }

  it("does not repopulate a removed session from an in-flight prefetch before the next list revision", async () => {
    const key = "agent:main:deleted";
    const response = createDeferred<ReturnType<typeof historyResult>>();
    const request = vi.fn(() => response.promise);
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [row(key, NOW - 1)],
    };
    updatePrefetch(snapshot);
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request).toHaveBeenCalledOnce();
    updatePrefetch({ ...snapshot, rows: [] });
    response.resolve(historyResult(key));
    await settlePromises();
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key })).toBeNull();
    await store.flush();
    expect(await store.read(key)).toBeNull();
  });

  it("keeps unchanged history warm while a queued session becomes active", async () => {
    const key = "agent:main:report";
    const otherKey = "agent:main:active";
    const queuedKey = "agent:main:queued";
    const response = createDeferred<ReturnType<typeof historyResult>>();
    const request = vi.fn(() => response.promise);
    const unchanged = { ...row(key, NOW - 1), sessionId: `id:${key}` };
    const other = { ...row(otherKey, NOW), hasActiveRun: true };
    const queued = row(queuedKey, NOW - 2);
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [otherKey],
      rows: [unchanged, queued, other],
    };
    updatePrefetch(snapshot);
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request).toHaveBeenCalledOnce();

    updatePrefetch({
      ...snapshot,
      listRevision: 2,
      rows: [{ ...unchanged }, { ...queued, hasActiveRun: true }, { ...other, updatedAt: NOW + 1 }],
    });
    response.resolve(historyResult(key));
    await settlePromises();
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key })?.messages).toEqual(
      historyResult(key).messages,
    );
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: queuedKey })).toBeNull();
    await store.flush();
    expect((await store.read(key))?.messages).toEqual(historyResult(key).messages);
    await vi.advanceTimersByTimeAsync(31_000);
    await settlePromises();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(
    [
      { name: "replacement incarnation", patch: { sessionId: "replacement" } },
      { name: "branch reset", patch: { activeLeafEntryId: "new-leaf" } },
      { name: "updated transcript", patch: { updatedAt: NOW + 1 } },
      { name: "new activity", patch: { lastActivityAt: NOW + 1 } },
      { name: "active run custody", patch: { hasActiveRun: true } },
    ].flatMap((change) => [
      { ...change, changedKey: "agent:main:main" },
      { ...change, changedKey: "global" },
    ]),
  )("rejects a prefetch after $changedKey gains $name", async ({ patch, changedKey }) => {
    const key = "agent:main:main";
    const response = createDeferred<ReturnType<typeof historyResult>>();
    const request = vi.fn(() => response.promise);
    const original = { ...row(key, NOW - 1), sessionId: "original", activeLeafEntryId: "leaf" };
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [original],
    };
    updatePrefetch(snapshot);
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request).toHaveBeenCalledOnce();

    const changed: GatewaySessionRow = {
      ...original,
      key: changedKey,
      kind: changedKey === "global" ? "global" : "direct",
      ...patch,
    };
    updatePrefetch({
      ...snapshot,
      listRevision: 2,
      rows: [...(changedKey === key ? [] : [original]), changed],
    });
    response.resolve(historyResult(key));
    await settlePromises();
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key })).toBeNull();
    await store.flush();
    expect(await store.read(key)).toBeNull();
  });

  it.each([
    { name: "a same-age alias", aliasActivityAt: NOW - 1, keepOriginal: true },
    { name: "an older alias", aliasActivityAt: NOW - 2, keepOriginal: true },
    { name: "only an older alias", aliasActivityAt: NOW - 2, keepOriginal: false },
  ])(
    "requires the captured history to survive beside $name",
    async ({ aliasActivityAt, keepOriginal }) => {
      const key = "agent:main:main";
      const response = createDeferred<ReturnType<typeof historyResult>>();
      const request = vi.fn(() => response.promise);
      const original = { ...row(key, NOW - 1), sessionId: `id:${key}` };
      const snapshot = {
        client: { request } as unknown as GatewayBrowserClient,
        listRevision: 1,
        openSessionKeys: [],
        rows: [original],
      };
      updatePrefetch(snapshot);
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(request).toHaveBeenCalledOnce();
      updatePrefetch({
        ...snapshot,
        listRevision: 2,
        rows: [
          ...(keepOriginal ? [{ ...original }] : []),
          { ...row("global", aliasActivityAt), kind: "global", sessionId: original.sessionId },
        ],
      });
      response.resolve(historyResult(key));
      await settlePromises();
      expect(
        readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key })?.messages ?? null,
      ).toEqual(keepOriginal ? historyResult(key).messages : null);
      await store.flush();
      expect((await store.read(key))?.messages ?? null).toEqual(
        keepOriginal ? historyResult(key).messages : null,
      );
    },
  );

  it.each([
    "client replacement",
    "same-client reconnect",
    "session invalidation",
    "profile cache clear",
    "newer pane snapshot",
  ] as const)("rejects a held prefetch after %s without a roster revision", async (change) => {
    const key = "agent:main:owned";
    const response = createDeferred<ReturnType<typeof historyResult>>();
    const request = vi.fn(() => response.promise);
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [row(key, NOW - 1)],
    };
    updatePrefetch(snapshot);
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request).toHaveBeenCalledOnce();

    let expected: ChatSessionSnapshot | null = null;
    if (change === "client replacement") {
      updatePrefetch({ ...snapshot, client: { request } as unknown as GatewayBrowserClient });
    } else if (change === "same-client reconnect") {
      updatePrefetch({ ...snapshot, client: null });
      updatePrefetch(snapshot);
    } else if (change === "session invalidation") {
      clearChatMessagesFromCache(cache, snapshotHost, { sessionKey: key });
    } else if (change === "profile cache clear") {
      await clearStoredChatSnapshots();
    } else {
      expected = historySnapshot("Newer pane history");
      cacheChatSessionSnapshot(cache, snapshotHost, { sessionKey: key }, expected);
    }
    response.resolve(historyResult(key));
    await settlePromises();
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key })).toEqual(expected);
    await store.flush();
    expect(await store.read(key)).toEqual(expected);
  });

  it.each([false, true])(
    "hydrates persisted history and fences its cursor-reset reread (clear during reread: %s)",
    async (clearDuringReread) => {
      const key = "agent:main:persisted";
      cacheChatSessionSnapshot(
        cache,
        snapshotHost,
        { sessionKey: key },
        {
          ...historySnapshot("Stored history"),
          deltaCursor: "stored-cursor",
        },
      );
      await store.flush();
      cache.clear();
      const page = createDeferred<ReturnType<typeof historyResult>>();
      const request = vi.fn(async (_method: string, params: unknown) =>
        (params as { cursor?: string }).cursor
          ? { kind: "reset", reason: "stale-cursor" }
          : page.promise,
      );
      updatePrefetch({
        client: { request } as unknown as GatewayBrowserClient,
        listRevision: 1,
        openSessionKeys: [],
        rows: [row(key, NOW + 1)],
      });
      await vi.advanceTimersByTimeAsync(300);
      await settlePromises();
      expect(
        request.mock.calls.map(([, params]) => (params as { cursor?: string }).cursor),
      ).toEqual(["stored-cursor", undefined]);
      if (clearDuringReread) {
        await clearStoredChatSnapshots();
      }
      page.resolve(historyResult(key));
      await settlePromises();
      const snapshot = readChatSessionSnapshot(cache, snapshotHost, { sessionKey: key });
      expect(snapshot?.messages ?? null).toEqual(
        clearDuringReread ? null : historyResult(key).messages,
      );
      await store.flush();
      expect(await store.read(key)).toEqual(snapshot);
    },
  );

  it("warms five eligible sessions one at a time without reopening fresh or active history", async () => {
    store.write("agent:main:fresh", historySnapshot("fresh"));
    await store.flush();
    const open = vi.spyOn(indexedDB, "open");
    const pending: Array<{
      resolve: (value: ReturnType<typeof historyResult>) => void;
      sessionKey: string;
    }> = [];
    const request = vi.fn((_method: string, params: unknown) => {
      const sessionKey = (params as { sessionKey: string }).sessionKey;
      return new Promise<ReturnType<typeof historyResult>>((resolve) => {
        pending.push({ resolve, sessionKey });
      });
    });
    const locksRequest = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => await callback({ name: "openclaw-chat-prefetch", mode: "exclusive" } as Lock),
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: locksRequest },
    });
    const rows = [
      row("agent:main:eligible-6", NOW - 8),
      row("agent:main:eligible-3", NOW - 5, NOW + 500),
      row("agent:main:main", NOW - 1),
      row("agent:main:eligible-1", NOW - 3),
      row("agent:main:fresh", NOW - 2),
      row("agent:main:eligible-5", NOW - 7),
      row("agent:main:eligible-2", undefined, NOW - 4),
      row("agent:main:eligible-4", NOW - 6),
    ];
    const state: SessionPrefetchUpdate = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: ["main"],
      rows,
    };

    updatePrefetch(state);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    await drainSequentially(pending, request, [
      "agent:main:eligible-1",
      "agent:main:eligible-2",
      "agent:main:eligible-3",
      "agent:main:eligible-4",
      "agent:main:eligible-5",
    ]);
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls.every((call) => (call[1] as { limit: number }).limit === 800)).toBe(
      true,
    );
    expect(locksRequest).toHaveBeenCalledWith(
      "openclaw-chat-prefetch",
      { ifAvailable: true },
      expect.any(Function),
    );
    expect(
      readChatSessionSnapshot(cache, snapshotHost, { sessionKey: "agent:main:eligible-5" }),
    ).toEqual({
      messages: [{ role: "assistant", content: "agent:main:eligible-5" }],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "id:agent:main:eligible-5",
    });
    expect(
      request.mock.calls.some((call) => sessionKeyFromCall(call) === "agent:main:eligible-6"),
    ).toBe(false);
    expect(open).toHaveBeenCalledOnce();

    await store.flush();
    open.mockClear();
    updatePrefetch({ ...state, listRevision: 2 });
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();
    expect(open).not.toHaveBeenCalled();
  });

  it("waits for the presented transcript to commit before warming other sessions", async () => {
    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    const state: SessionPrefetchUpdate = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: ["agent:main:main"],
      loadingSessionKeys: ["agent:main:main"],
      rows: [row("agent:main:main", NOW - 1), row("agent:main:recent", NOW - 2)],
    };
    updatePrefetch(state);
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();
    // The visible transcript owns the socket until it has committed.
    expect(request).not.toHaveBeenCalled();

    updatePrefetch({ ...state, loadingSessionKeys: [] });
    host.dispatchEvent(
      new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent"]);
  });

  it("stops the queued warming when a presented transcript starts loading mid-cycle", async () => {
    const pending: Array<{
      resolve: (value: ReturnType<typeof historyResult>) => void;
      sessionKey: string;
    }> = [];
    const request = vi.fn((_method: string, params: unknown) => {
      const sessionKey = (params as { sessionKey: string }).sessionKey;
      return new Promise<ReturnType<typeof historyResult>>((resolve) => {
        pending.push({ resolve, sessionKey });
      });
    });
    const state: SessionPrefetchUpdate = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: ["agent:main:main"],
      rows: [
        row("agent:main:main", NOW - 1),
        row("agent:main:recent-1", NOW - 2),
        row("agent:main:recent-2", NOW - 3),
      ],
    };
    updatePrefetch(state);
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent-1"]);

    // The user opens another session while the first warm-up is in flight.
    updatePrefetch({ ...state, loadingSessionKeys: ["agent:main:main"] });
    pending.shift()?.resolve(historyResult("agent:main:recent-1"));
    await settlePromises();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent-1"]);

    updatePrefetch({ ...state, loadingSessionKeys: [] });
    host.dispatchEvent(
      new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([
      "agent:main:recent-1",
      "agent:main:recent-2",
    ]);
  });

  it("resamples when a presented pane reports a transcript loading edge", async () => {
    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    const state: SessionPrefetchUpdate = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: ["agent:main:main"],
      rows: [row("agent:main:main", NOW - 1), row("agent:main:recent", NOW - 2)],
    };
    updatePrefetch(state);
    // The pane starts its load inside its own update; the page never re-renders,
    // so only the pane's signal can retire the "ready" snapshot the page sampled.
    const pane = host.firstElementChild as HTMLElement & { transcriptLoading: boolean };
    pane.transcriptLoading = true;
    pane.dispatchEvent(
      new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();
    expect(request).not.toHaveBeenCalled();

    pane.transcriptLoading = false;
    pane.dispatchEvent(
      new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent"]);
  });

  it("rechecks readiness after the persisted snapshot read before requesting history", async () => {
    const sessionKey = "agent:main:stored";
    const stored = historySnapshot("stored", "session-stored");
    store.write(sessionKey, stored);
    await store.flush();
    cache.clear();
    const read = createDeferred<ChatSessionSnapshot | null>();
    const readSpy = vi.spyOn(store, "read").mockReturnValueOnce(read.promise);
    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    const state: SessionPrefetchUpdate = {
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: ["agent:main:main"],
      rows: [row("agent:main:main", NOW - 1), row(sessionKey, NOW + 1)],
    };
    updatePrefetch(state);
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(readSpy).toHaveBeenCalledWith(sessionKey);
    expect(request).not.toHaveBeenCalled();

    // The presented pane starts loading while IndexedDB is still answering.
    const pane = host.firstElementChild as HTMLElement & { transcriptLoading: boolean };
    pane.transcriptLoading = true;
    pane.dispatchEvent(
      new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
    );
    read.resolve(stored);
    await settlePromises();
    expect(request).not.toHaveBeenCalled();

    pane.transcriptLoading = false;
    pane.dispatchEvent(
      new CustomEvent("openclaw-chat-transcript-loading-changed", { bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(300);
    await settlePromises();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([sessionKey]);
  });

  it("keeps repeated roster refreshes within the bounded recent-session snapshot window", async () => {
    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const rows = Array.from({ length: 25 }, (_, index) =>
      row(`agent:main:recent-${index}`, NOW - index - 1),
    );

    for (let listRevision = 1; listRevision <= 5; listRevision += 1) {
      updatePrefetch({ client, listRevision, openSessionKeys: [], rows });
      await vi.advanceTimersByTimeAsync(1_000);
      await settlePromises();
      await store.flush();
    }

    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(
      rows.slice(0, 20).map(({ key }) => key),
    );
    expect(store.readSavedAt("agent:main:recent-0")).not.toBeNull();
    expect(store.readSavedAt("agent:main:recent-19")).not.toBeNull();

    updatePrefetch({ client, listRevision: 6, openSessionKeys: [], rows });
    await vi.advanceTimersByTimeAsync(31_000);
    await settlePromises();
    await store.flush();

    expect(request).toHaveBeenCalledTimes(20);
    expect(store.readSavedAt("agent:main:recent-0")).not.toBeNull();
  });

  it("reserves snapshot capacity for presented panes while warming recent background sessions", async () => {
    const presentedSessionKey = "agent:main:presented";
    cacheChatSessionSnapshot(
      cache,
      snapshotHost,
      { sessionKey: presentedSessionKey },
      historySnapshot("presented"),
    );
    for (let index = 1; index < MAX_CACHED_CHAT_SESSIONS; index += 1) {
      cacheChatSessionSnapshot(
        cache,
        snapshotHost,
        { sessionKey: `agent:main:stale-${index}` },
        historySnapshot(`stale-${index}`),
      );
    }
    await store.flush();

    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const backgroundRows = Array.from({ length: 25 }, (_, index) =>
      row(`agent:main:background-${index}`, NOW - index - 1),
    );
    const rows = [row(presentedSessionKey, NOW), ...backgroundRows];

    for (let listRevision = 1; listRevision <= 5; listRevision += 1) {
      updatePrefetch({ client, listRevision, openSessionKeys: [presentedSessionKey], rows });
      await vi.advanceTimersByTimeAsync(1_000);
      await settlePromises();
      await store.flush();
    }

    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(
      backgroundRows.slice(0, 19).map(({ key }) => key),
    );
    expect(
      readChatSessionSnapshot(cache, snapshotHost, { sessionKey: presentedSessionKey }),
    ).toEqual(historySnapshot("presented"));
    expect(store.readSavedAt(presentedSessionKey)).not.toBeNull();
  });

  it("coalesces a newer list revision until the per-session cooldown expires", async () => {
    const request = vi.fn(async (_method: string, params: unknown) =>
      historyResult((params as { sessionKey: string }).sessionKey),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const base = {
      client,
      openSessionKeys: [],
    };
    updatePrefetch({ ...base, listRevision: 1, rows: [row("agent:main:warm", NOW - 1)] });
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();
    expect(request).toHaveBeenCalledTimes(1);

    const newerActivityAt = Date.now() + 1;
    updatePrefetch({
      ...base,
      listRevision: 2,
      rows: [row("agent:main:warm", newerActivityAt)],
    });
    updatePrefetch({
      ...base,
      listRevision: 3,
      rows: [row("agent:main:warm", newerActivityAt + 1)],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();
    expect(request).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(27_000);
    await settlePromises();
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rewarms complete stored history after an interleaved append miss", async () => {
    const sessionKey = "agent:main:delta";
    const priorMessages = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `prior-${index + 1}`,
      __openclaw: { id: `prior-${index + 1}`, seq: index + 1 },
    }));
    cacheChatSessionSnapshot(
      cache,
      snapshotHost,
      { sessionKey },
      {
        deltaCursor: "cursor-1",
        messages: priorMessages,
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "session-delta",
      },
    );
    await store.flush();
    const previousSavedAt = store.readSavedAt(sessionKey);
    cache.clear();
    const liveMessage = {
      role: "user",
      content: "live broadcast",
      __openclaw: { id: "live-user", seq: 6 },
    };
    const liveEvent = {
      sessionKey,
      message: liveMessage,
      messageId: "live-user",
      messageSeq: 6,
    };
    appendChatMessageToCache(cache, snapshotHost, { sessionKey }, liveMessage, liveEvent);
    const deltaMessage = {
      role: "assistant",
      content: "delta reply",
      __openclaw: { id: "delta-assistant", seq: 7 },
    };
    const request = vi.fn(async () => ({
      kind: "delta",
      messages: [
        liveEvent,
        {
          sessionKey,
          message: deltaMessage,
          messageId: "delta-assistant",
          messageSeq: 7,
        },
      ],
      deltaCursor: "cursor-2",
      sessionInfo: { key: sessionKey, kind: "direct", sessionId: "session-delta", updatedAt: 2 },
    }));

    updatePrefetch({
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [row(sessionKey, NOW + 1)],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ cursor: "cursor-1", sessionKey }),
    );
    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey })).toEqual({
      deltaCursor: "cursor-2",
      messages: [...priorMessages, liveMessage, deltaMessage],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "session-delta",
    });
    expect(store.readSavedAt(sessionKey)).toBeGreaterThan(previousSavedAt ?? 0);
    await store.flush();
    expect(await new SessionSnapshotStore().read(sessionKey)).toEqual({
      deltaCursor: "cursor-2",
      messages: [...priorMessages, liveMessage, deltaMessage],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "session-delta",
    });
  });

  it("retains the prior cursor when a delta carries transient active-run replay", async () => {
    const sessionKey = "agent:main:active";
    cacheChatSessionSnapshot(
      cache,
      snapshotHost,
      { sessionKey },
      {
        deltaCursor: "cursor-1",
        messages: [{ role: "user", content: "cached" }],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "session-active",
      },
    );
    const request = vi.fn(async () => ({
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo: {
        key: sessionKey,
        kind: "direct",
        sessionId: "session-active",
        updatedAt: 2,
        hasActiveRun: true,
      },
      inFlightRun: {
        runId: "run-active",
        events: [
          {
            runId: "run-active",
            seq: 1,
            stream: "item",
            ts: 1,
            sessionKey,
            data: { kind: "preamble", itemId: "progress", progressText: "Still working" },
          },
        ],
      },
    }));

    updatePrefetch({
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [row(sessionKey, NOW + 1)],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();

    expect(readChatSessionSnapshot(cache, snapshotHost, { sessionKey })?.deltaCursor).toBe(
      "cursor-1",
    );
  });

  it("leaves active sessions for the presented pane to revalidate", async () => {
    const sessionKey = "agent:main:active";
    const request = vi.fn();

    updatePrefetch({
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [{ ...row(sessionKey, NOW + 1), hasActiveRun: true, status: "running" }],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();

    expect(request).not.toHaveBeenCalled();
  });

  it("skips the cycle when another tab holds the Web Lock", async () => {
    const request = vi.fn();
    const locksRequest = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => await callback(null),
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: locksRequest },
    });
    updatePrefetch({
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [row("agent:main:locked", NOW - 1)],
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();

    expect(locksRequest).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it("does no lock or network work when the tab becomes hidden before idle", async () => {
    const idle = { callback: null as IdleRequestCallback | null };
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      value: (callback: IdleRequestCallback) => {
        idle.callback = callback;
        return 1;
      },
    });
    const request = vi.fn();
    const locksRequest = vi.fn();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: locksRequest },
    });
    updatePrefetch({
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [row("agent:main:hidden", NOW - 1)],
    });
    await vi.advanceTimersByTimeAsync(1_500);
    visibility = "hidden";
    idle.callback?.({ didTimeout: false, timeRemaining: () => 50 });
    await settlePromises();

    expect(locksRequest).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("logs fetch errors without retrying or stopping later candidates", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const request = vi.fn(async (_method: string, params: unknown) => {
      const sessionKey = (params as { sessionKey: string }).sessionKey;
      if (sessionKey.endsWith("failed")) {
        throw new Error("prefetch failed");
      }
      return historyResult(sessionKey);
    });
    updatePrefetch({
      client: { request } as unknown as GatewayBrowserClient,
      listRevision: 1,
      openSessionKeys: [],
      rows: [row("agent:main:failed", NOW - 1), row("agent:main:succeeded", NOW - 2)],
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await settlePromises();

    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([
      "agent:main:failed",
      "agent:main:succeeded",
    ]);
    expect(debug).toHaveBeenCalledWith(
      "[chat-session-prefetch] history fetch failed for agent:main:failed",
      expect.any(Error),
    );
    expect(
      readChatSessionSnapshot(cache, snapshotHost, { sessionKey: "agent:main:succeeded" }),
    ).not.toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    await settlePromises();
    expect(
      request.mock.calls.filter((call) => sessionKeyFromCall(call).endsWith("failed")),
    ).toHaveLength(1);
  });
});
