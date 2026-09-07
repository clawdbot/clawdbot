/* @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsersPrefsSetParams } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ChatBookmarks, type ChatBookmarkScope } from "./chat-bookmarks.ts";
import {
  resolveAssistantAttachmentAvailability,
  retryAssistantAttachmentAvailability,
} from "./components/chat-message-attachment-availability.ts";
import {
  isChatMediaResourceCurrent,
  observeChatMediaResource,
  releaseChatMediaResourceSubscriber,
} from "./components/chat-message-media.ts";

const source = {
  agentId: "main",
  sessionKey: "agent:main:chat",
  sessionId: "generation-a",
  messageId: "source",
  name: "Café",
};
function scope(request: Parameters<typeof createTestGatewayClient>[0]): ChatBookmarkScope {
  return {
    client: createTestGatewayClient(request),
    generation: 1,
    profileId: "alice",
    agentId: source.agentId,
    key: source.sessionKey,
    sessionId: source.sessionId,
    canWrite: true,
    isCurrent: () => true,
  };
}
function preferences(initial: Record<string, unknown> = {}) {
  const entries = { ...initial };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: { ...entries } };
    }
    if (method === "users.prefs.set") {
      const update = params as UsersPrefsSetParams;
      for (const [key, value] of Object.entries(update.entries)) {
        if (value === null) {
          delete entries[key];
        } else {
          entries[key] = value;
        }
      }
      return { status: "ok" };
    }
    throw new Error("Unexpected API: " + method);
  });
  return { entries, request };
}
async function loaded(request: Parameters<typeof createTestGatewayClient>[0]) {
  const state = new ChatBookmarks(vi.fn());
  state.bind(scope(request));
  await vi.waitFor(() => expect(state.indexReady).toBe(true));
  return state;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat bookmarks in existing personal preferences", () => {
  it("creates stable preference keys without WebCrypto on HTTP origins", async () => {
    vi.stubGlobal("crypto", undefined);
    const store = preferences();
    const state = await loaded(store.request);
    state.edit("http-source");
    state.editor!.name = "HTTP bookmark";
    await state.save();
    expect(state.error).toBeNull();
    const hash = createHash("sha256")
      .update(JSON.stringify([source.agentId, source.sessionKey, source.sessionId, "http-source"]))
      .digest("hex");
    expect(store.entries["chat.bookmark:" + hash]).toMatchObject({
      messageId: "http-source",
      name: "HTTP bookmark",
    });
  });

  it("keeps current-conversation search and manages references whose conversation is gone", async () => {
    const store = preferences({
      theme: "dark",
      "chat.bookmark:one": source,
      "chat.bookmark:other-session": { ...source, sessionId: "replacement" },
      "chat.bookmark:other-agent": { ...source, agentId: "other" },
      "chat.bookmark:deleted": {
        ...source,
        sessionKey: "agent:main:deleted",
        name: "Café archive",
      },
      "chat.bookmark:invalid": { name: 42 },
      "chat.bookmark:empty-session": { ...source, sessionId: " " },
      "chat.bookmark:empty-message": { ...source, messageId: "" },
      "chat.bookmark:invalid-name": { ...source, name: "Café\0" },
    });
    const state = await loaded(store.request);
    state.query = "CAFE\u0301";
    expect(state.results.map((item) => item.id)).toEqual([
      "chat.bookmark:one",
      "chat.bookmark:other-session",
    ]);
    const retired = state.results[1]!;
    state.edit(retired.messageId, retired);
    state.editor!.name = "Retired decision";
    await state.save();
    expect(store.entries[retired.id]).toMatchObject({
      sessionId: "replacement",
      name: "Retired decision",
    });
    expect(store.entries.theme).toBe("dark");
    state.allConversations = true;
    state.query = "CAFÉ";
    expect(state.results.map((item) => item.id).toSorted()).toEqual([
      "chat.bookmark:deleted",
      "chat.bookmark:one",
      "chat.bookmark:other-agent",
    ]);
    const deleted = state.results.find((item) => item.id === "chat.bookmark:deleted")!;
    expect(state.canOpen(deleted)).toBe(false);
    expect(
      state.canOpen(state.results.find((item) => item.id === "chat.bookmark:other-agent")!),
    ).toBe(false);
    await state.remove(deleted);
    expect(store.entries[deleted.id]).toBeUndefined();
    state.allConversations = false;
    state.edit("source");
    expect(state.editor?.bookmark?.id).toBe("chat.bookmark:one");
    expect(store.entries["chat.bookmark:one"]).toEqual(source);
  });

  it("preserves concurrent favorites and unrelated settings through create, rename, reopen and remove", async () => {
    const store = preferences({ theme: "dark" });
    const first = await loaded(store.request);
    const second = await loaded(store.request);
    first.edit("first");
    second.edit("second");
    first.editor!.name = "First";
    second.editor!.name = "Second";
    await Promise.all([first.save(), second.save()]);
    expect(Object.keys(store.entries)).toHaveLength(3);
    const reopened = await loaded(store.request);
    expect(reopened.bookmarks.map((item) => item.name)).toEqual(["First", "Second"]);
    reopened.edit("first");
    reopened.editor!.name = "𝅘𝅥𝅮".repeat(70);
    await reopened.save();
    const again = await loaded(store.request);
    again.query = "𝅘𝅥𝅮".normalize("NFC");
    expect(again.results).toHaveLength(1);
    await again.remove(again.results[0]!);
    expect((await loaded(store.request)).bookmarks.map((item) => item.name)).toEqual(["Second"]);
    expect(store.entries.theme).toBe("dark");
    expect(
      store.request.mock.calls
        .filter(([method]) => method === "users.prefs.set")
        .every(([, params]) => Object.keys((params as UsersPrefsSetParams).entries).length === 1),
    ).toBe(true);
  });

  it("never treats an unread library as empty or adopts a retired profile's delayed load", async () => {
    const pending = createDeferred<unknown>();
    const state = new ChatBookmarks(vi.fn());
    state.bind(scope(() => pending.promise));
    state.toggle("source");
    expect(state.editor).toBeNull();
    const bob = scope(preferences().request);
    bob.profileId = "bob";
    state.bind(bob);
    await vi.waitFor(() => expect(state.indexReady).toBe(true));
    pending.resolve({ status: "ok", entries: { "chat.bookmark:old": source } });
    await pending.promise;
    expect(state.bookmarks).toEqual([]);
    expect(state.scope?.profileId).toBe("bob");
  });

  it("surfaces quota and removal failures without discarding the editor or saved favorite", async () => {
    const store = preferences({ "chat.bookmark:saved": source });
    const state = await loaded(async (method, params) => {
      if (method === "users.prefs.set") {
        throw new Error("Preference quota exceeded");
      }
      return store.request(method, params);
    });
    state.edit("new");
    state.editor!.name = "Keep this name";
    await state.save();
    expect(state.error).toContain("Preference quota");
    expect(state.editor?.name).toBe("Keep this name");
    state.editor = null;
    state.open = false;
    await state.remove(state.bookmarks[0]!);
    expect(state.open).toBe(true);
    expect(state.bookmarks).toHaveLength(1);
  });

  it("does not dispatch for a retired connection", async () => {
    const store = preferences();
    const state = await loaded(store.request);
    let current = true;
    state.scope!.isCurrent = () => current;
    state.edit("new");
    state.editor!.name = "Name";
    current = false;
    await state.save();
    expect(store.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
  });

  it("does not let an old write completion close a replacement profile's editor", async () => {
    const pending = createDeferred<unknown>();
    const state = await loaded(async (method) =>
      method === "users.prefs.set"
        ? pending.promise
        : { status: "ok", entries: { "chat.bookmark:saved": source } },
    );
    const saving = state.remove(state.bookmarks[0]!);
    const bob = scope(preferences().request);
    bob.profileId = "bob";
    state.bind(bob);
    await vi.waitFor(() => expect(state.indexReady).toBe(true));
    state.edit("bob-message");
    state.editor!.name = "Bob's choice";
    pending.resolve({ status: "ok" });
    await saving;
    expect(state.editor?.name).toBe("Bob's choice");
    expect(state.open).toBe(true);
  });
});

describe("read-only bookmarks from an earlier conversation generation", () => {
  const retired = { ...source, id: "chat.bookmark:retired", sessionId: "retired-generation" };
  const excerpt = {
    sessionId: retired.sessionId,
    sessionInfo: { sessionId: source.sessionId },
    messages: [
      { role: "user", content: "Before", __openclaw: { id: "before" } },
      { role: "assistant", content: "Saved content", __openclaw: { id: source.messageId } },
      { role: "toolResult", content: "Do not mount old tool actions", __openclaw: { id: "tool" } },
      { role: "assistant", content: "NO_REPLY", __openclaw: { id: "silent" } },
      { role: "user", content: "After", __openclaw: { id: "after" } },
    ],
  };
  function withHistory(history: () => Promise<unknown>) {
    const store = preferences({ [retired.id]: retired });
    const request = vi.fn(async (method: string, params?: unknown) =>
      method === "chat.history" ? history() : store.request(method, params),
    );
    return { ...store, request };
  }

  it("reads the exact saved generation, ignores live metadata, and does not write preferences", async () => {
    const store = withHistory(async () => excerpt);
    const state = await loaded(store.request);
    state.scope!.canWrite = false;
    state.query = "Café";
    expect(state.canOpen(retired)).toBe(true);
    await state.showHistory(retired);
    expect(store.request).toHaveBeenCalledWith("chat.history", {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: retired.sessionId,
      messageId: source.messageId,
      limit: 5,
      maxChars: 50_000,
      maxBytes: 128_000,
    });
    expect(state.history?.result).toMatchObject({
      status: "loaded",
      messages: [excerpt.messages[0], excerpt.messages[1], excerpt.messages[4]],
    });
    expect(state.scope?.sessionId).toBe(source.sessionId);
    expect(state.open).toBe(true);
    state.backToList();
    expect(state.history).toBeNull();
    expect(state.query).toBe("Café");
    expect(store.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
  });

  it.each([
    { name: "missing anchor", result: { ...excerpt, messages: [] } },
    { name: "replacement generation", result: { ...excerpt, sessionId: source.sessionId } },
    {
      name: "hidden anchor",
      result: {
        ...excerpt,
        messages: [
          { role: "assistant", content: "NO_REPLY", __openclaw: { id: source.messageId } },
        ],
      },
    },
  ])("does not substitute a current message for a $name", async ({ result }) => {
    const state = await loaded(withHistory(async () => result).request);
    await state.showHistory(retired);
    expect(state.history?.result).toEqual({
      status: "error",
      message: "The saved message is no longer available in this conversation.",
    });
  });

  it("surfaces read errors in the reader without replacing the bookmark or editor", async () => {
    const state = await loaded(
      withHistory(async () => {
        throw new Error("Access denied");
      }).request,
    );
    await state.showHistory(retired);
    expect(state.history?.result).toEqual({ status: "error", message: "Access denied" });
    expect(state.bookmarks).toHaveLength(1);
    expect(state.open).toBe(true);
    expect(state.editor).toBeNull();
  });

  it.each(["close", "back", "profile", "generation", "connection", "access"] as const)(
    "retires a delayed historical reply after %s",
    async (change) => {
      const pending = createDeferred<unknown>();
      const state = await loaded(withHistory(() => pending.promise).request);
      const loading = state.showHistory(retired);
      if (change === "close") {
        state.close();
      } else if (change === "back") {
        state.backToList();
      } else if (change === "access") {
        state.scope!.isCurrent = () => false;
      } else {
        const next = scope(preferences().request);
        if (change === "profile") {
          next.profileId = "other";
        }
        if (change === "generation") {
          next.sessionId = "new-generation";
        }
        if (change === "connection") {
          next.generation += 1;
        }
        state.bind(next);
      }
      pending.resolve(excerpt);
      await loading;
      expect(state.history?.result.status).not.toBe("loaded");
      if (change === "close") {
        expect(state.open).toBe(false);
      }
    },
  );

  it("lets the latest historical selection own the result, even for the same message ID", async () => {
    const pending = createDeferred<unknown>();
    let count = 0;
    const next = { ...retired, id: "chat.bookmark:older", sessionId: "older-generation" };
    const state = await loaded(
      withHistory(async () =>
        ++count === 1 ? pending.promise : { ...excerpt, sessionId: next.sessionId },
      ).request,
    );
    const first = state.showHistory(retired);
    await state.showHistory(next);
    pending.resolve(excerpt);
    await first;
    expect(state.history?.bookmark.sessionId).toBe(next.sessionId);
    expect(state.history?.result.status).toBe("loaded");
  });

  it("does not dispatch historical reads for active or foreign conversation targets", async () => {
    const store = withHistory(async () => excerpt);
    const state = await loaded(store.request);
    for (const bookmark of [
      { ...retired, sessionId: source.sessionId },
      { ...retired, agentId: "other" },
      { ...retired, sessionKey: "agent:main:other" },
    ]) {
      await state.showHistory(bookmark);
    }
    expect(store.request.mock.calls.some(([method]) => method === "chat.history")).toBe(false);
  });

  it("does not let an earlier save close a newly opened historical reader in the same profile", async () => {
    const saving = createDeferred<unknown>();
    const store = preferences({ [retired.id]: retired });
    const state = await loaded(async (method, params) => {
      if (method === "chat.history") {
        return excerpt;
      }
      if (method === "users.prefs.set") {
        return saving.promise;
      }
      return store.request(method, params);
    });
    state.edit("new-source");
    state.editor!.name = "New marker";
    const write = state.save();
    await state.showHistory(retired);
    const reader = state.history;
    saving.resolve({ status: "ok" });
    await write;
    expect(state.history).toBe(reader);
    expect(state.history?.result.status).toBe("loaded");
    expect(state.open).toBe(true);
  });
});

describe("historical reader media ownership", () => {
  it("releases only its media subscriptions when closing", async () => {
    const retired = { ...source, id: "chat.bookmark:retired", sessionId: "retired" };
    const store = preferences({ [retired.id]: retired });
    const state = await loaded(async (method, params) =>
      method === "chat.history"
        ? {
            sessionId: retired.sessionId,
            messages: [
              { role: "assistant", content: "Saved", __openclaw: { id: source.messageId } },
            ],
          }
        : store.request(method, params),
    );
    await state.showHistory(retired);
    const liveUpdate = vi.fn();
    const live = observeChatMediaResource("assistant-attachment", "live-owner-test", liveUpdate);
    const archived = observeChatMediaResource(
      "assistant-attachment",
      "archive-owner-test",
      state.history!.updateMedia,
    );
    try {
      state.close();
      expect(isChatMediaResourceCurrent(archived)).toBe(false);
      expect(isChatMediaResourceCurrent(live)).toBe(true);
    } finally {
      releaseChatMediaResourceSubscriber(liveUpdate);
    }
  });

  it("keeps a passive media lookup read-only even when a caller requests a grant", async () => {
    const update = vi.fn();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            available: false,
            retryable: false,
            canAllow: true,
            reason: "Approval required",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const options = {
      allowPermissionRequests: false,
      onRequestUpdate: update,
      sessionKey: source.sessionKey,
      agentId: source.agentId,
    };
    const image = "/tmp/read-only-bookmark.png";
    try {
      resolveAssistantAttachmentAvailability(image, options, true);
      await vi.waitFor(() =>
        expect(resolveAssistantAttachmentAvailability(image, options).status).toBe("unavailable"),
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]).toEqual([
        expect.not.stringContaining("allow=1"),
        expect.objectContaining({ method: "GET" }),
      ]);
      retryAssistantAttachmentAvailability(image, options, true);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      releaseChatMediaResourceSubscriber(update);
    }
  });
});
