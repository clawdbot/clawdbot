import { expectDefined } from "@openclaw/normalization-core";
import { IDBFactory } from "fake-indexeddb";
import { render } from "lit";
/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMediaGetResult } from "../../../../src/gateway/control-ui-contract.js";
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
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
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
  afterEach(resetTranscriptTestDom);

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
      installTranscriptDomMocks();
      vi.stubGlobal("indexedDB", new IDBFactory());
      const mediaResponse = createDeferred<AssistantMediaGetResult>();
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
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const renderPane = () => {
        render(
          renderChatThread(
            {
              ...threadProps("cached-initial-pane", targetSessionKey, remounted.state.chatMessages),
              pendingInputs: getChatPendingInputs(remounted.state)?.page.items,
              assistantAttachmentAuthToken: "test-auth-token",
              connectionEpoch: 1,
              resolveAssistantMedia: () => mediaResponse.promise,
              onRequestUpdate: renderPane,
            },
            transcript,
          ),
          container,
        );
        transcript.hostUpdated();
      };
      try {
        await vi.waitFor(() =>
          expect(
            readChatSessionSnapshot(sharedMessages, remounted.state, {
              sessionKey: targetSessionKey,
            }),
          ).not.toBeNull(),
        );
        renderPane();
        transcript.hostConnected();
        const displayed = expectDefined(
          container.querySelector<HTMLImageElement>(".chat-message-image"),
          "remounted initial image",
        );
        // jsdom has no decoder; deliver the loaded-preview boundary before custody.
        Object.defineProperty(displayed, "naturalWidth", { value: 1 });
        displayed.dispatchEvent(new Event("load"));
        const expectRenderedInput = (text: string, author: string) => {
          expect(container.querySelectorAll(".chat-bubble")).toHaveLength(1);
          expect(container.querySelectorAll(".chat-message-image")).toHaveLength(1);
          expect(container.querySelector(".chat-message-image")).toBe(displayed);
          expect(displayed.getAttribute("src")).toBe(dataUrl);
          expect(container.querySelector('[aria-busy="true"]')).toBeNull();
          expect(container.textContent).toContain(text);
          expect(container.querySelector(".chat-sender-name")?.textContent?.trim()).toBe(author);
        };
        expectRenderedInput("Keep the attributed initial image", "Local Author");
        const metadata = {
          id: "pending:cached-input",
          ...(senderName ? { senderName } : {}),
          media: [{ url: "media://inbound/cached-image", contentType: "image/png" }],
          mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
        };
        const custodyMessage = {
          role: "user",
          content: "Gateway accepted the initial image",
          __openclaw: metadata,
        };
        applyChatPendingInputs(remounted.state, {
          total: 1,
          items: [
            { id: "cached-input", runId, acceptedAt: 1, state: "queued", message: custodyMessage },
          ],
        });
        renderPane();
        expect(remounted.state.chatMessages).toEqual([]);
        expect(
          getChatPendingInputs(remounted.state)?.page.items.map((item) => item.message),
        ).toEqual([custodyMessage]);
        expectRenderedInput(custodyMessage.content, senderName ?? "You");
        expect(container.textContent).not.toContain("Keep the attributed initial image");
        expect(custodyMessage["__openclaw"]).toBe(metadata);
        const canonicalMessage = {
          ...custodyMessage,
          content: "Gateway persisted the initial image",
          __openclaw: {
            ...metadata,
            id: "cached-input",
            seq: 1,
            idempotencyKey: `${runId}:user`,
            runId: "execution-run",
          },
        };
        request.mockResolvedValue({
          sessionId: "cached-initial-session",
          messages: [canonicalMessage],
          pendingInputs: { items: [], total: 0 },
        });
        await loadChatHistory(remounted.state);
        renderPane();
        expect(remounted.state.chatMessages).toEqual([canonicalMessage]);
        expectRenderedInput(canonicalMessage.content, senderName ?? "You");
        expect(container.textContent).not.toContain(custodyMessage.content);
        expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
      } finally {
        render(null, container);
        releaseChatMediaResourceSubscriber(renderPane);
        transcript.hostDisconnected();
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
