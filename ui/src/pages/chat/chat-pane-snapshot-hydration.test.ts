import { IDBFactory } from "fake-indexeddb";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createInitializationContext,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { extractImages } from "./components/chat-message-media.ts";
import {
  observeChatCache,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";
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

  it.each(
    ["memory", "stored"].flatMap((cacheMode) =>
      ["Gateway Author", undefined].map((senderName) => ({ cacheMode, senderName })),
    ),
  )(
    "keeps one attributed initial source through $cacheMode remount, custody, and promotion ($senderName)",
    async ({ cacheMode, senderName }) => {
      vi.stubGlobal("indexedDB", new IDBFactory());
      const targetSessionKey = "agent:main:cached-initial";
      const runId = "cached-initial-send";
      const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
      const request = vi.fn().mockResolvedValue({
        messages: [],
        sessionId: "cached-initial-session",
        sessionInfo: { key: targetSessionKey, hasActiveRun: true, status: "running" },
      });
      const client = {
        request,
        addEventListener: vi.fn(() => vi.fn()),
      } as unknown as GatewayBrowserClient;
      const context = createInitializationContext();
      context.gateway.snapshot.client = client;
      context.chatSubmissions.retain(
        buildInitialChatSubmission(
          targetSessionKey,
          {
            text: "Keep the attributed initial image",
            createdAt: 1,
            sender: { id: "local-author", name: "Local Author" },
            attachments: [{ id: "cached-image", mimeType: "image/png", dataUrl }],
          },
          client,
          runId,
        ),
      );
      const sharedMessages: ChatMessageCache = new Map();
      const store = new SessionSnapshotStore(sharedMessages);
      observeChatCache(sharedMessages, store);
      const mount = (stored = false) => {
        const pane = createMountedPane(targetSessionKey, sharedMessages);
        pane.context = context;
        if (stored) {
          pane.sessionSnapshotStore = store;
        }
        const stopAfterAttach = new Error("stop after attach");
        vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
          state.client = client;
          state.connected = true;
          throw stopAfterAttach;
        });
        expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
        return pane;
      };
      const renderedUsers = (state: ChatPageHost) =>
        buildChatItems({
          paneId: "cached-initial-pane",
          sessionKey: targetSessionKey,
          messages: state.chatMessages,
          pendingInputs: getChatPendingInputs(state)?.page.items,
          toolMessages: [],
          streamSegments: [],
          stream: null,
          streamStartedAt: null,
          showToolCalls: true,
        }).flatMap((item) =>
          item.kind === "group" && item.role === "user"
            ? item.messages.map(({ message }) => message)
            : [],
        );
      const first = mount();
      try {
        // A stale network response commits the still-visible local prompt to cache.
        await loadChatHistory(first.state);
        const cached = readChatSessionSnapshot(sharedMessages, first.state, {
          sessionKey: targetSessionKey,
        });
        expect(cached?.messages).toEqual(first.state.chatMessages);
        expect(cached?.messages).toHaveLength(1);
        expect(cached?.messages[0]).toMatchObject({ __openclaw: { senderId: "local-author" } });
      } finally {
        first.disconnectedCallback();
      }
      await store.flush();
      if (cacheMode === "stored") {
        sharedMessages.clear();
      }
      const remounted = mount(cacheMode === "stored");
      try {
        await vi.waitFor(() =>
          expect(
            readChatSessionSnapshot(sharedMessages, remounted.state, {
              sessionKey: targetSessionKey,
            }),
          ).not.toBeNull(),
        );
        expect(renderedUsers(remounted.state)).toHaveLength(1);
        const metadata = {
          id: "pending:cached-input",
          ...(senderName ? { senderName } : {}),
          media: [{ url: "media://inbound/cached-image", contentType: "image/png" }],
        };
        const custodyMessage = {
          role: "user",
          content: "Keep the attributed initial image",
          __openclaw: metadata,
        };
        applyChatPendingInputs(remounted.state, {
          total: 1,
          items: [
            { id: "cached-input", runId, acceptedAt: 1, state: "queued", message: custodyMessage },
          ],
        });
        const custodyUsers = renderedUsers(remounted.state);
        expect(custodyUsers).toHaveLength(1);
        expect(remounted.state.chatMessages).toEqual([]);
        expect(extractImages(custodyUsers[0]).map((image) => image.url)).toEqual([dataUrl]);
        expect(custodyUsers[0]).toMatchObject({
          __openclaw: { id: "pending:cached-input", ...(senderName ? { senderName } : {}) },
        });
        expect(custodyUsers[0]).not.toHaveProperty("__openclaw.senderId");
        expect(custodyUsers[0]).not.toHaveProperty("__openclaw.media");
        if (!senderName) {
          expect(custodyUsers[0]).not.toHaveProperty("__openclaw.senderName");
        }
        expect(custodyMessage["__openclaw"]).toBe(metadata);
        request.mockResolvedValue({
          sessionId: "cached-initial-session",
          messages: [
            {
              ...custodyMessage,
              __openclaw: {
                ...metadata,
                id: "cached-input",
                seq: 1,
                idempotencyKey: `${runId}:user`,
                runId: "execution-run",
              },
            },
          ],
          pendingInputs: { items: [], total: 0 },
        });
        await loadChatHistory(remounted.state);
        const canonicalUsers = renderedUsers(remounted.state);
        expect(canonicalUsers).toHaveLength(1);
        expect(canonicalUsers[0]).toMatchObject({ __openclaw: { id: "cached-input", seq: 1 } });
        expect(extractImages(canonicalUsers[0]).map((image) => image.url)).toEqual([dataUrl]);
        expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
      } finally {
        remounted.disconnectedCallback();
        await store.flush();
        await clearStoredChatSnapshots();
      }
    },
  );

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
    context.chatSubmissions.retain(
      buildInitialChatSubmission(
        targetSessionKey,
        { attachments: [], createdAt: 1, text: "retry the rejected prompt" },
        client,
        "initial-run",
      ),
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
