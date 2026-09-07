/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatBookmark, ChatBookmarkAccess } from "../chat-bookmarks.ts";
import { renderChatPositionRail } from "./chat-position-rail.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

function saved(id: string): ChatBookmark {
  return {
    id: "saved-" + id,
    agentId: "main",
    sessionKey: "agent:main:chat",
    sessionId: "generation",
    messageId: id,
    name: "Decision " + id,
  };
}
afterEach(() => {
  document.body.replaceChildren();
});

it("keeps crowded bookmarks keyboard reachable with names and cycles every source without overlapping new markers", () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({
    role: "user",
    content: "Message " + index,
    __openclaw: { id: String(index), seq: index + 1 },
  }));
  const revealMessage = vi.fn(() => true);
  const transcript = {
    activeMessageId: () => "0",
    revealMessage,
  } as unknown as ChatTranscriptSession;
  const access: ChatBookmarkAccess = {
    revision: 0,
    bookmarks: [saved("older"), saved("1"), saved("2")],
    selectedId: null,
    open: vi.fn(),
  };
  const container = document.body.appendChild(document.createElement("div"));
  const draw = () =>
    render(
      renderChatPositionRail({ messages, transcript, bookmarkAccess: access, requestUpdate: draw }),
      container,
    );
  draw();
  const markers = container.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker");
  expect(markers).toHaveLength(10);
  expect(markers[0]?.title).toBe("3 nearby bookmarks");
  expect(markers[0]?.getAttribute("aria-description")).toContain("3 nearby bookmarks");
  for (const bookmark of access.bookmarks) {
    markers[0]!.click();
    expect(access.open).toHaveBeenLastCalledWith(bookmark);
    access.selectedId = bookmark.id;
    draw();
  }
  expect(container.querySelector(".chat-position-rail__marker--selected")).not.toBeNull();
  markers[0]!.focus();
  markers[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(markers[1]);
  markers[1]!.click();
  expect(revealMessage).toHaveBeenCalledWith("5");
});

it("shows a named bookmark for a one-message conversation", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const access: ChatBookmarkAccess = {
    revision: 1,
    bookmarks: [saved("one")],
    selectedId: null,
    open: vi.fn(),
  };
  render(
    renderChatPositionRail({
      messages: [{ role: "assistant", content: "Only answer", __openclaw: { id: "one" } }],
      transcript: { activeMessageId: () => "one" } as unknown as ChatTranscriptSession,
      bookmarkAccess: access,
      requestUpdate: vi.fn(),
    }),
    container,
  );
  const marker = container.querySelector<HTMLButtonElement>(".chat-position-rail__marker")!;
  expect(marker.title).toBe("Decision one");
  marker.click();
  expect(access.open).toHaveBeenCalledWith(access.bookmarks[0]);
});

it("previews the bookmarked source rather than the nearby sampled message", () => {
  const messages = Array.from({ length: 50 }, (_, index) => ({
    role: "user",
    content: "Message " + index,
    __openclaw: { id: String(index) },
  }));
  const container = document.body.appendChild(document.createElement("div"));
  const transcript = { activeMessageId: () => "0" } as unknown as ChatTranscriptSession;
  const access: ChatBookmarkAccess = {
    revision: 1,
    bookmarks: [saved("1")],
    selectedId: null,
    open: vi.fn(),
  };
  const draw = () =>
    render(
      renderChatPositionRail({ messages, transcript, bookmarkAccess: access, requestUpdate: draw }),
      container,
    );
  draw();
  const marker = container.querySelector<HTMLButtonElement>(
    ".chat-position-rail__marker--bookmark",
  )!;
  expect(marker.dataset.positionMarkerId).toBe("0");
  marker.dispatchEvent(new Event("pointerenter"));
  expect(container.querySelector(".chat-position-rail__preview-copy")?.textContent).toBe(
    "Message 1",
  );
  expect(marker.getAttribute("aria-description")).toContain("Message 1.");
});
