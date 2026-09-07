/* @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsersPrefsSetParams } from "../../../../packages/gateway-protocol/src/index.js";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ChatBookmarks, type ChatBookmarkScope } from "./chat-bookmarks.ts";

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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    const pending = deferred<unknown>();
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
    const pending = deferred<unknown>();
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
