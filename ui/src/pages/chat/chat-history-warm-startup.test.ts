/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  resetChatHistoryProjection,
  synchronizeInitialChatSnapshotConnection,
} from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";
import type { ChatMessageCache, ChatSessionSnapshot } from "./session-message-cache.ts";
import * as snapshotDatabase from "./session-snapshot-database.ts";
import { markPrewarmedChatSnapshotReady, prewarmChatSnapshot } from "./session-snapshot-prewarm.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import "./chat-pane.ts";

const sessionKey = "agent:main:warm-startup";
const stored: ChatSessionSnapshot = {
  deltaCursor: "stored-cursor",
  messages: [nativeHistoryMessage(1, "Stored conversation")],
  pagination: { hasMore: false, completeSnapshot: true },
  sessionId: "warm-session",
};
const liveMessages = [nativeHistoryMessage(2, "Live conversation")];
const panes: TestChatPane[] = [];

function mountPane(
  withStore = true,
  key = sessionKey,
  connectedAtMount = false,
  snapshotStore?: SessionSnapshotStore,
) {
  const read = createDeferred<ChatSessionSnapshot | null>();
  const memory: ChatMessageCache = new Map();
  const store = snapshotStore ?? new SessionSnapshotStore(memory);
  if (!snapshotStore) {
    vi.spyOn(store, "read").mockReturnValue(read.promise);
  }
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  panes.push(pane);
  vi.spyOn(pane, "requestUpdate").mockImplementation(() => undefined);
  vi.spyOn(pane, "performUpdate").mockImplementation(() => undefined);
  pane.context = createInitializationContext();
  pane.context.gateway.snapshot.phase = connectedAtMount ? "connected" : "connecting";
  pane.sessionKey = key;
  pane.chatMessagesBySession = memory;
  if (withStore) {
    pane.sessionSnapshotStore = store;
  }
  const attached = new Error("pane state attached");
  vi.spyOn(pane.chatState, "attach").mockImplementation(() => {
    throw attached;
  });
  expect(() => pane.connectedCallback()).toThrow(attached);
  const state = pane.state;
  const liveResult = {
    messages: liveMessages,
    sessionId: "warm-session",
    sessionInfo: { key, kind: "direct", sessionId: "warm-session" },
    hasMore: false,
    deltaCursor: "live-cursor",
  };
  const request = vi.fn(async () => liveResult);
  const client = createGatewayBrowserClientFixture({ request });
  return {
    state,
    read,
    request,
    liveResult,
    connect() {
      state.client = client;
      state.connected = true;
      state.connectionEpoch += 1;
      synchronizeInitialChatSnapshotConnection(state);
    },
    start() {
      return loadChatHistory(state, { startup: true, deferBranches: true });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const pane of panes.splice(0)) {
    pane.disconnectedCallback();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetTranscriptTestDom();
});

describe("first chat startup snapshot ordering", () => {
  it("waits for hydration after a long offline mount and shares the cursor startup between callers", async () => {
    const h = mountPane();
    await vi.advanceTimersByTimeAsync(1_000);
    h.connect();
    await vi.advanceTimersByTimeAsync(200);
    const first = h.start();
    const joined = h.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.request).not.toHaveBeenCalled();

    h.read.resolve(stored);
    await Promise.all([first, joined]);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ sessionKey, cursor: "stored-cursor" }),
    );
  });

  it("caps the wait at 300 ms from connection readiness and fences a late stored snapshot", async () => {
    const h = mountPane();
    const network = createDeferred<typeof h.liveResult>();
    h.request.mockReturnValueOnce(network.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    h.connect();
    await vi.advanceTimersByTimeAsync(100);
    const loading = h.start();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
    expect(h.state.chatMessages).toEqual([]);

    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.state.chatMessages).toEqual([]);
    network.resolve(h.liveResult);
    await loading;
    expect(h.state.chatMessages).toEqual(liveMessages);
    const refresh = h.start();
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenLastCalledWith(
      "chat.startup",
      expect.objectContaining({ cursor: "live-cursor" }),
    );
    await refresh;
  });

  it("continues as soon as a pending read reports no stored snapshot", async () => {
    const h = mountPane();
    h.connect();
    const loading = h.start();
    expect(h.request).not.toHaveBeenCalled();
    h.read.resolve(null);
    await loading;
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
  });

  it("still requests startup after an ordinary history refresh completes during the wait", async () => {
    const h = mountPane();
    h.connect();
    const startup = h.start();
    await loadChatHistory(h.state, { deferBranches: true });
    expect(h.request).toHaveBeenCalledExactlyOnceWith("chat.history", expect.anything());
    h.read.resolve(stored);
    await startup;
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request).toHaveBeenLastCalledWith(
      "chat.startup",
      expect.objectContaining({ cursor: "live-cursor" }),
    );
  });

  it.each([
    ["main", "agent:main:main"],
    ["AGENT:MAIN:WARM-STARTUP", sessionKey],
  ])(
    "retains startup when %s becomes its canonical key %s during hydration",
    async (alias, canonical) => {
      const h = mountPane(true, canonical);
      h.state.sessionKey = alias;
      h.connect();
      const loading = h.start();
      h.state.sessionKey = canonical;
      h.read.resolve(stored);
      await loading;
      expect(h.request).toHaveBeenCalledExactlyOnceWith(
        "chat.startup",
        expect.objectContaining({ sessionKey: canonical, cursor: "stored-cursor" }),
      );
      expect(h.state.chatMessages).toEqual(liveMessages);
    },
  );

  it("does not defer startup when the pane has no stored read", async () => {
    const h = mountPane(false);
    h.connect();
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    await loading;
  });

  it("does not defer startup for a stored read begun after connection readiness", async () => {
    const h = mountPane(true, sessionKey, true);
    h.connect();
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    await loading;
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it("waits for a boot prewarm consumed by a pane mounted after readiness", async () => {
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    prewarmChatSnapshot(sessionKey);
    markPrewarmedChatSnapshotReady();
    const h = mountPane(true, sessionKey, true, new SessionSnapshotStore());
    h.connect();
    const loading = h.start();
    expect(h.request).not.toHaveBeenCalled();
    record.resolve({
      savedAt: Date.now(),
      sessionKey,
      sessionId: stored.sessionId,
      snapshot: stored,
    });
    await loading;
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.objectContaining({ sessionKey, cursor: "stored-cursor" }),
    );
  });

  it("keeps the prewarm deadline anchored to hello when the pane mounts later", async () => {
    const record = createDeferred<unknown>();
    vi.spyOn(snapshotDatabase, "readStoredChatSnapshotRecord").mockReturnValueOnce(record.promise);
    prewarmChatSnapshot(sessionKey);
    await vi.advanceTimersByTimeAsync(50);
    markPrewarmedChatSnapshotReady();
    await vi.advanceTimersByTimeAsync(100);
    markPrewarmedChatSnapshotReady();
    const h = mountPane(true, sessionKey, true, new SessionSnapshotStore());
    h.connect();
    const loading = h.start();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledExactlyOnceWith(
      "chat.startup",
      expect.not.objectContaining({ cursor: expect.anything() }),
    );
    await loading;
    record.resolve({
      savedAt: Date.now(),
      sessionKey,
      sessionId: stored.sessionId,
      snapshot: stored,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it("starts immediately if the connection budget expired before startup was requested", async () => {
    const h = mountPane();
    h.connect();
    await vi.advanceTimersByTimeAsync(300);
    const loading = h.start();
    expect(h.request).toHaveBeenCalledOnce();
    await loading;
    h.read.resolve(stored);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual(liveMessages);
  });

  it.each(["disconnect", "reset"])(
    "retires the first wait on %s without delaying the next startup",
    async (transition) => {
      const h = mountPane();
      h.connect();
      const loading = h.start();
      if (transition === "disconnect") {
        h.state.connected = false;
        synchronizeInitialChatSnapshotConnection(h.state);
      } else {
        resetChatHistoryProjection(h.state);
      }
      await loading;
      expect(h.request).not.toHaveBeenCalled();
      h.connect();
      const retry = h.start();
      expect(h.request).toHaveBeenCalledOnce();
      await retry;
      h.read.resolve(stored);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.state.chatMessages).toEqual(liveMessages);
    },
  );
});
