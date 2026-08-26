/* @vitest-environment jsdom */

import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createInitializationContext,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { prepareInitialUserMessageHandoff } from "./initial-turn-handoff.ts";
import {
  observeChatCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import "./chat-pane.ts";

describe("stored chat snapshot hydration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createMountedPane(targetSessionKey: string, sharedMessages: ChatMessageCache) {
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    vi.spyOn(pane, "requestUpdate").mockImplementation(() => undefined);
    vi.spyOn(pane, "performUpdate").mockImplementation(() => undefined);
    pane.sessionKey = targetSessionKey;
    pane.chatMessagesBySession = sharedMessages;
    pane.context = createInitializationContext();
    return pane;
  }

  async function writeStoredSnapshot(
    targetSessionKey: string,
    messages: ReturnType<typeof nativeHistoryMessage>[],
  ) {
    const writer = new SessionSnapshotStore();
    writer.write(targetSessionKey, {
      messages,
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "persistent-session",
    });
    await writer.flush();
  }

  it("paints a persistent snapshot while the network refresh is already in flight", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const targetSessionKey = "agent:main:persistent";
    const cachedMessages = [nativeHistoryMessage(1, "persistent history")];
    const networkMessages = [nativeHistoryMessage(1, "network history")];
    await writeStoredSnapshot(targetSessionKey, cachedMessages);
    const response = createDeferred<Record<string, unknown>>();
    const request = vi.fn(() => response.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const sharedMessages: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(sharedMessages);
    store.connect();
    observeChatCache(sharedMessages, store);
    const pane = createMountedPane(targetSessionKey, sharedMessages);
    pane.sessionSnapshotStore = store;
    const stopAfterAttach = new Error("stop after attach");
    let attachedState: ChatPageHost | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedState = state;
      state.client = client;
      state.connected = true;
      state.connectionEpoch = 1;
      void loadChatHistory(state);
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      expect(request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey: targetSessionKey }),
      );
      await vi.waitFor(() => expect(attachedState?.chatMessages).toEqual(cachedMessages));

      response.resolve({ messages: networkMessages, sessionId: "network-session" });
      await vi.waitFor(() => expect(attachedState?.chatMessages).toEqual(networkMessages));
    } finally {
      pane.disconnectedCallback();
      store.disconnect();
      await store.whenIdle();
      await clearStoredChatSnapshots();
    }
  });

  it("discards persistent hydration when the network snapshot lands first", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const targetSessionKey = "agent:main:network-first";
    await writeStoredSnapshot(targetSessionKey, [
      nativeHistoryMessage(1, "stale persistent history"),
    ]);
    const networkMessages = [nativeHistoryMessage(1, "authoritative network history")];
    const request = vi.fn(async () => ({
      messages: networkMessages,
      sessionId: "network-session",
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const sharedMessages: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(sharedMessages);
    store.connect();
    observeChatCache(sharedMessages, store);
    const pane = createMountedPane(targetSessionKey, sharedMessages);
    pane.sessionSnapshotStore = store;
    const stopAfterAttach = new Error("stop after attach");
    let attachedState: ChatPageHost | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedState = state;
      state.client = client;
      state.connected = true;
      state.connectionEpoch = 1;
      void loadChatHistory(state);
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      await vi.waitFor(() => expect(attachedState?.chatMessages).toEqual(networkMessages));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(attachedState?.chatMessages).toEqual(networkMessages);
    } finally {
      pane.disconnectedCallback();
      store.disconnect();
      await store.whenIdle();
      await clearStoredChatSnapshots();
    }
  });

  it("merges stored history with an admitted prompt when hydration resolves late", async () => {
    const targetSessionKey = "agent:main:first-turn-retry";
    const client = {
      addEventListener: vi.fn(() => vi.fn()),
      request: vi.fn(),
    } as unknown as GatewayBrowserClient;
    const context = createInitializationContext();
    context.gateway.snapshot.client = client;
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    vi.spyOn(pane, "requestUpdate").mockImplementation(() => undefined);
    vi.spyOn(pane, "performUpdate").mockImplementation(() => undefined);
    pane.sessionKey = targetSessionKey;
    const sharedMessages: ChatMessageCache = new Map();
    pane.chatMessagesBySession = sharedMessages;
    let deliverStoredSnapshot: ((snapshot: unknown) => void) | undefined;
    pane.sessionSnapshotStore = {
      read: () =>
        new Promise((resolve) => {
          deliverStoredSnapshot = resolve;
        }),
    } as never;
    pane.context = context;
    prepareInitialUserMessageHandoff(
      context.initialUserMessage,
      targetSessionKey,
      { attachments: [], createdAt: 1, text: "retry the rejected prompt" },
      client,
      { runId: "initial-run" },
    );
    const stopAfterAttach = new Error("stop after attach");
    let attachedState: ChatPageHost | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedState = state;
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      expect(attachedState?.chatMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "text", text: "retry the rejected prompt" })],
        }),
      ]);
      const storedMessage = nativeHistoryMessage(1, "stored transcript");
      const storedPagination = { hasMore: true as const, nextOffset: 1, totalMessages: 3 };
      deliverStoredSnapshot?.({
        deltaCursor: "stored-cursor",
        displayedLeafEntryId: "stored-leaf",
        messages: [storedMessage],
        pagination: storedPagination,
        sessionId: "stored-session",
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(deliverStoredSnapshot).toBeDefined();
      expect(attachedState?.chatMessages).toEqual([
        storedMessage,
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "text", text: "retry the rejected prompt" })],
        }),
      ]);
      expect(attachedState).toMatchObject({
        chatDisplayedLeafEntryId: "stored-leaf",
        chatHistoryPagination: storedPagination,
        currentSessionId: "stored-session",
      });
      expect(
        readChatSessionSnapshot(sharedMessages, pane.state, {
          sessionKey: targetSessionKey,
        }),
      ).toEqual({
        deltaCursor: "stored-cursor",
        displayedLeafEntryId: "stored-leaf",
        messages: attachedState?.chatMessages,
        pagination: storedPagination,
        sessionId: "stored-session",
      });
    } finally {
      pane.disconnectedCallback();
    }
  });
});
