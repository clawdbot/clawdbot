/* @vitest-environment jsdom */
import { IDBFactory } from "fake-indexeddb";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChatHistory, resumePendingChatHistoryLoad } from "./chat-history.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  nativeHistoryMessage,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./components/chat-transcript.test-support.ts";
import type { ChatMessageCache } from "./session-message-cache.ts";
import { clearStoredChatSnapshots } from "./session-snapshot-invalidation.ts";
import { SessionSnapshotStore } from "./session-snapshot-store.ts";
import "./chat-pane.ts";

describe("chat pane warm reload", () => {
  afterEach(resetTranscriptTestDom);

  it("renders stored history before connecting and resumes startup with its delta cursor", async () => {
    installTranscriptDomMocks();
    vi.stubGlobal("indexedDB", new IDBFactory());
    const sessionKey = "agent:main:warm-reload";
    const messages = [nativeHistoryMessage(1, "The browser remembers this conversation.")];
    const writer = new SessionSnapshotStore();
    writer.write(sessionKey, {
      deltaCursor: "warm-reload-cursor",
      messages,
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "warm-reload-session",
    });
    await writer.flush();

    const memory: ChatMessageCache = new Map();
    const store = new SessionSnapshotStore(memory);
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    vi.spyOn(pane, "requestUpdate").mockImplementation(() => undefined);
    vi.spyOn(pane, "performUpdate").mockImplementation(() => undefined);
    pane.context = createInitializationContext();
    pane.context.gateway.snapshot.phase = "connecting";
    pane.sessionKey = sessionKey;
    pane.chatMessagesBySession = memory;
    pane.sessionSnapshotStore = store;
    const attached = new Error("pane state attached");
    vi.spyOn(pane.chatState, "attach").mockImplementation(() => {
      throw attached;
    });
    const request = vi.fn(() => ({
      kind: "delta",
      messages: [],
      deltaCursor: "warm-reload-next-cursor",
      sessionInfo: { key: sessionKey, kind: "direct", sessionId: "warm-reload-session" },
    }));
    const client = createGatewayBrowserClientFixture({ request });
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));

    try {
      expect(() => pane.connectedCallback()).toThrow(attached);
      await loadChatHistory(pane.state, { startup: true });
      await vi.waitFor(() => expect(pane.state.chatMessages).toEqual(messages));
      expect(pane.state.connected).toBe(false);
      expect(request).not.toHaveBeenCalled();
      render(
        renderChatThread(
          threadProps("warm-reload-pane", sessionKey, pane.state.chatMessages),
          transcript,
        ),
        container,
      );
      transcript.hostConnected();
      transcript.hostUpdated();
      expect(container.textContent).toContain("The browser remembers this conversation.");

      pane.state.client = client;
      pane.state.connected = true;
      pane.state.connectionEpoch = 1;
      await resumePendingChatHistoryLoad(pane.state);

      expect(request).toHaveBeenCalledExactlyOnceWith(
        "chat.startup",
        expect.objectContaining({ sessionKey, cursor: "warm-reload-cursor" }),
      );
      expect(pane.state.chatMessages).toEqual(messages);
    } finally {
      render(null, container);
      transcript.hostDisconnected();
      pane.disconnectedCallback();
      await clearStoredChatSnapshots();
    }
  });
});
