/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createTestChatPane } from "./chat-pane-history.test-support.ts";
import {
  getTranscriptState,
  resetThreadPresentation,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";

function bookmarkPane() {
  const client = createTestGatewayClient(async () => ({ status: "ok", entries: {} }));
  const fixture = createTestChatPane({ client, sessions: {} as SessionCapability });
  const { pane, state } = fixture;
  pane.paneId = "logical-pane";
  pane.presentationId = "retained-presentation";
  state.settings = { ...loadSettings(), chatShowToolCalls: false, chatPersistCommentary: false };
  state.currentSessionId = "generation-a";
  pane.context.gateway.snapshot.hello = {
    ...expectDefined(pane.context.gateway.snapshot.hello, "connected hello"),
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
  };
  pane.context.gateway.snapshot.selfUser = {
    id: "profile-a",
    name: "Reader",
    identity: { type: "profile", id: "profile-a" },
  };
  const bookmark = {
    id: "chat.bookmark:source",
    agentId: "main",
    sessionKey: state.sessionKey,
    sessionId: state.currentSessionId,
    messageId: "source",
    name: "Decision",
  };
  state.chatMessages = [{ role: "assistant", content: "Source", __openclaw: { id: "source" } }];
  vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
  const reveal = vi.spyOn(pane.transcript, "revealMessage").mockReturnValue(true);
  return { ...fixture, bookmark, reveal };
}

afterEach(() => resetThreadPresentation());

describe("bookmark navigation presentation ownership", () => {
  it.each(["agent", "conversation", "generation"] as const)(
    "does not open an all-conversations reference from another %s",
    async (difference) => {
      const { pane, bookmark, reveal } = bookmarkPane();
      const foreign = { ...bookmark };
      if (difference === "agent") {
        foreign.agentId = "retired";
      } else if (difference === "conversation") {
        foreign.sessionKey = "agent:main:deleted";
      } else {
        foreign.sessionId = "retired-generation";
      }
      expectDefined(pane.syncBookmarks(), "bookmark access").open(foreign);
      await Promise.resolve();
      expect(reveal).not.toHaveBeenCalled();
      expect(getTranscriptState(pane.presentationId).bookmarkReveal).toBeUndefined();
    },
  );
  it("closes only the rendered presentation's search and retires reveal on a new search", async () => {
    const { pane, bookmark, reveal } = bookmarkPane();
    const logical = getTranscriptState(pane.paneId);
    const rendered = getTranscriptState(pane.presentationId);
    logical.searchOpen = rendered.searchOpen = true;
    logical.searchQuery = rendered.searchQuery = "not the source";
    expectDefined(pane.syncBookmarks(), "bookmark access").open(bookmark);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("source"));
    expect(rendered.searchOpen).toBe(false);
    expect(rendered.searchQuery).toBe("");
    expect(logical.searchQuery).toBe("not the source");
    expect(rendered.bookmarkReveal?.messageId).toBe("source");
    toggleTranscriptSearch(pane.presentationId, vi.fn());
    expect(rendered.bookmarkReveal).toBeUndefined();
  });

  it.each(["profile", "generation", "session", "connection", "read access", "incognito"] as const)(
    "retires a source reveal and its retained action after a %s change",
    async (change) => {
      const { pane, state, bookmark, reveal } = bookmarkPane();
      const access = expectDefined(pane.syncBookmarks(), "bookmark access");
      access.open(bookmark);
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledOnce());
      expect(getTranscriptState(pane.presentationId).bookmarkReveal?.messageId).toBe("source");
      if (change === "profile") {
        pane.context.gateway.snapshot.selfUser = {
          id: "profile-b",
          name: "Other reader",
          identity: { type: "profile", id: "profile-b" },
        };
      } else if (change === "generation") {
        state.currentSessionId = "generation-b";
      } else if (change === "session") {
        state.sessionKey = "agent:main:other";
      } else if (change === "connection") {
        pane.connectionGeneration += 1;
      } else if (change === "read access") {
        pane.context.gateway.snapshot.hello = {
          ...expectDefined(pane.context.gateway.snapshot.hello, "connected hello"),
          auth: { role: "operator", scopes: [] },
        };
      } else {
        state.selectedChatSessionIncognito = true;
      }
      pane.syncBookmarks();
      expect(getTranscriptState(pane.presentationId).bookmarkReveal).toBeUndefined();
      access.open(bookmark);
      await Promise.resolve();
      expect(getTranscriptState(pane.presentationId).bookmarkReveal).toBeUndefined();
      expect(reveal).toHaveBeenCalledOnce();
    },
  );
});
