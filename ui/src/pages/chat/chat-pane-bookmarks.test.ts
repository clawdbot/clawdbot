/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createTestChatPane } from "./chat-pane-history.test-support.ts";
import * as bookmarkDialog from "./components/chat-bookmarks-dialog.ts";
import { openResolvedImage } from "./components/chat-message-image-open.ts";
import {
  cacheManagedImageBlobUrl,
  retainManagedImageBlobUrl,
  observeChatMediaResource,
  isChatMediaResourceCurrent,
  releaseChatMediaResourceSubscriber,
} from "./components/chat-message-media.ts";
import {
  getTranscriptState,
  resetThreadPresentation,
  toggleTranscriptSearch,
} from "./components/chat-thread-interactions.ts";

function bookmarkPane(
  request: Parameters<typeof createTestGatewayClient>[0] = async () => ({
    status: "ok",
    entries: {},
  }),
) {
  const client = createTestGatewayClient(request);
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
    "does not redirect the live transcript to a reference from another %s",
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

it("releases a late retained image after the historical reader closes while a shared reader remains", async () => {
  const { pane, state, bookmark } = bookmarkPane(async (method) =>
    method === "chat.history"
      ? {
          sessionId: "retired-generation",
          messages: [{ role: "assistant", content: "Saved image", __openclaw: { id: "source" } }],
        }
      : { status: "ok", entries: {} },
  );
  const handled = vi.fn();
  state.handleOpenImage = handled;
  expectDefined(pane.syncBookmarks(), "bookmark access").open({
    ...bookmark,
    sessionId: "retired-generation",
  });
  await vi.waitFor(() => expect(pane.bookmarks.history?.result.status).toBe("loaded"));
  const renderer = vi.spyOn(bookmarkDialog, "renderChatBookmarksDialog");
  pane.renderBookmarksDialog();
  const media = expectDefined(renderer.mock.calls.at(-1)?.[1].media, "reader media callbacks");
  const open = expectDefined(media.onOpenImage, "image ownership receiver");
  const reader = expectDefined(pane.bookmarks.history, "historical reader");
  const sharedUpdate = vi.fn();
  const key = "historical-shared-full-image";
  const shared = observeChatMediaResource("managed-image", key, sharedUpdate);
  observeChatMediaResource("managed-image", key, reader.updateMedia);
  const deferred = createDeferred();
  let retained: (() => void) | undefined;
  const released = vi.fn(() => retained?.());
  const opening = deferred.promise.then(() => {
    const url = "blob:http://localhost/historical-shared-full-image";
    cacheManagedImageBlobUrl(key, url);
    retained = expectDefined(retainManagedImageBlobUrl(key), "retained full image");
    openResolvedImage(open, url, "Saved image", released);
  });
  try {
    pane.bookmarks.close();
    expect(isChatMediaResourceCurrent(shared)).toBe(true);
    deferred.resolve();
    await opening;
    expect(handled).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledOnce();
  } finally {
    retained?.();
    releaseChatMediaResourceSubscriber(sharedUpdate);
    renderer.mockRestore();
  }
});
