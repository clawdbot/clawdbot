// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { rewindChatHistory } from "./chat-history-actions.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { ChatComposerPersistence, loadChatComposerSnapshot } from "./composer-persistence.ts";
import { handleChatDraftChange } from "./input-history.ts";

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createRewindHost(response: Promise<{ editorText: string }>) {
  const state = Object.assign(
    makeChatHost({
      requestHandlers: { "chat.history": { messages: [] } },
      sessionKey: "agent:main:session-a",
    }),
    {
      chatHistoryPagination: { hasMore: false as const },
      handleChatDraftChange: (next: string, mentions?: ChatState["chatMentions"]): void =>
        handleChatDraftChange(state, next, mentions),
      sessions: {
        rewind: vi.fn(() => response),
        refreshReplacement: vi.fn(async () => null),
      },
    },
  );
  return state;
}

describe("rewind composer ownership", () => {
  it.each(["start", "edit"] as const)(
    "restores ordinary message semantics from existing Goal %s mode",
    async (action) => {
      const state = createRewindHost(Promise.resolve({ editorText: "original prompt" }));
      state.chatGoalDraftMode =
        action === "start"
          ? { action }
          : { action, goalId: "goal", previousDraft: "borrowed draft" };

      await rewindChatHistory(state, "original-user");

      expect(state.chatMessage).toBe("original prompt");
      expect(state.chatGoalDraftMode).toBeNull();
      expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toBeUndefined();
    },
  );

  it.each(
    ["same", "different"].flatMap((session) =>
      [false, true].map((debounced) => ({ session, debounced })),
    ),
  )(
    "respects $session-session peer edits (debounced: $debounced)",
    async ({ session, debounced }) => {
      vi.useFakeTimers();
      const response = createDeferred<{ editorText: string }>();
      const source = createRewindHost(response.promise);
      const peer = {
        settings: source.settings,
        sessionKey: session === "same" ? source.sessionKey : "agent:main:session-b",
        chatMessage: "",
        chatQueue: [],
        selectedChatSessionIncognito: false,
      };
      const persistence = new ChatComposerPersistence(() => peer);
      persistence.start();
      try {
        const pending = rewindChatHistory(source, "original-user");
        peer.chatMessage = "newer peer draft";
        persistence.schedule();
        if (debounced) {
          await vi.advanceTimersByTimeAsync(200);
        }
        response.resolve({ editorText: "original prompt" });
        await pending;
        persistence.persistNow();

        expect(peer.chatMessage).toBe("newer peer draft");
        expect(loadChatComposerSnapshot(peer, peer.sessionKey)?.draft).toBe("newer peer draft");
        expect(source.chatMessage).toBe(session === "same" ? "" : "original prompt");
      } finally {
        persistence.stop();
      }
    },
  );

  it("lets a later same-session pane own the rewind replacement", async () => {
    const older = createDeferred<{ editorText: string }>();
    const newer = createDeferred<{ editorText: string }>();
    const first = createRewindHost(older.promise);
    const second = createRewindHost(newer.promise);
    const firstPending = rewindChatHistory(first, "earlier-user");
    const secondPending = rewindChatHistory(second, "later-user");
    older.resolve({ editorText: "superseded rewind" });
    await firstPending;
    const firstDraft = first.chatMessage;
    newer.resolve({ editorText: "selected rewind" });
    await secondPending;

    expect(firstDraft).toBe("");
    expect(second.chatMessage).toBe("selected rewind");
    expect(loadChatComposerSnapshot(second, second.sessionKey)?.draft).toBe("selected rewind");
  });

  it.each(
    ["rewind", "history"].flatMap((stage) =>
      ["text", "mentions", "attachments", "goal mode"].map((edit) => ({ stage, edit })),
    ),
  )("preserves newer composer $edit while awaiting $stage", async ({ stage, edit }) => {
    const response = createDeferred<{ editorText: string }>();
    const history = createDeferred<ChatHistoryResult>();
    const requestedHistory = createDeferred();
    const canonical = { role: "assistant", content: "retained prefix" };
    const state = Object.assign(
      makeChatHost({
        requestHandlers: {
          "chat.history": () => {
            requestedHistory.resolve();
            return stage === "history" ? history.promise : { messages: [canonical] };
          },
        },
        sessionKey: "main",
      }),
      {
        chatHistoryPagination: { hasMore: false as const },
        handleChatDraftChange: (next: string, mentions?: ChatState["chatMentions"]): void =>
          handleChatDraftChange(state, next, mentions),
        sessions: {
          rewind: vi.fn(() => response.promise),
          refreshReplacement: vi.fn(async () => null),
        },
      },
    );
    state.chatMessage = edit === "goal mode" ? "" : "@Alex keep this draft";
    state.chatMentions = edit === "goal mode" ? [] : [{ profileId: "alex", start: 0, end: 5 }];
    const pending = rewindChatHistory(state, "original-user");
    if (stage === "history") {
      response.resolve({ editorText: "original prompt" });
      await requestedHistory.promise;
    }
    if (edit === "text") {
      state.handleChatDraftChange("newer draft", []);
    } else if (edit === "mentions") {
      state.handleChatDraftChange(state.chatMessage, []);
    } else if (edit === "attachments") {
      state.chatAttachments = [
        { id: "new-image", mimeType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" },
      ];
    } else {
      state.chatGoalDraftMode = { action: "start" };
    }
    const composer = {
      text: state.chatMessage,
      mentions: state.chatMentions,
      attachments: state.chatAttachments,
      goalMode: state.chatGoalDraftMode,
    };
    response.resolve({ editorText: "original prompt" });
    history.resolve({ messages: [canonical] });

    await pending;

    expect(state.chatMessages).toEqual([canonical]);
    expect(state.chatMessage).toBe(composer.text);
    expect(state.chatMentions).toEqual(composer.mentions);
    expect(state.chatAttachments).toBe(composer.attachments);
    expect(state.chatGoalDraftMode).toEqual(composer.goalMode);
    expect(state.request).toHaveBeenCalledOnce();
  });

  it("lets only the latest rewind replace the composer", async () => {
    const older = createDeferred<{ editorText: string }>();
    const newer = createDeferred<{ editorText: string }>();
    const state = Object.assign(
      makeChatHost({ requestHandlers: { "chat.history": { messages: [] } }, sessionKey: "main" }),
      {
        chatHistoryPagination: { hasMore: false as const },
        handleChatDraftChange: (next: string, mentions?: ChatState["chatMentions"]): void =>
          handleChatDraftChange(state, next, mentions),
        sessions: {
          rewind: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise),
          refreshReplacement: vi.fn(async () => null),
        },
      },
    );
    state.chatMessage = "current draft";
    const first = rewindChatHistory(state, "earlier-user");
    const second = rewindChatHistory(state, "later-user");
    older.resolve({ editorText: "superseded rewind" });
    await first;
    expect(state.chatMessage).toBe("current draft");
    newer.resolve({ editorText: "selected rewind" });
    await second;
    expect(state.chatMessage).toBe("selected rewind");
  });
});
