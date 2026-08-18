/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  listStoredChatOutboxes,
  listStoredDraftScopes,
  summarizeStoredChatOutboxes,
} from "./outbox-store-projection.ts";
import {
  resolveStoredChatOutboxScope,
  retireStoredComposerDrafts,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
} from "./outbox-store.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stored outbox summaries", () => {
  it("keeps the exact aliased scope when sessionStorage retirement fails", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        mainAlias: { key: "workspace", agentId: "work" },
        sessions: {
          "global\u0000agent:work": {
            draft: "retire me",
            draftRevision: 10,
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 10,
          },
        },
      }),
    );
    const before = sessionStorage.getItem(storageKey);
    vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    const retired = retireStoredComposerDrafts({ settings: { gatewayUrl } }, [
      { key: "workspace", retireBeforeRevision: 20 },
    ]);
    expect(retired).toEqual({
      gatewayOwner: gatewayUrl,
      retirements: [
        {
          scope: { sessionKey: "global", agentId: "work" },
          minimumRevision: expect.any(Number),
          retireBeforeRevision: 20,
        },
      ],
      storageFailed: true,
    });
    expect(sessionStorage.getItem(storageKey)).toBe(before);
  });

  it("retires a batch with one write and notification while preserving newer replacements", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "older\u0000agent:main": {
            draft: "retire me",
            draftRevision: 10,
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 10,
          },
          "newer\u0000agent:main": {
            draft: "replacement",
            draftRevision: 1_000,
            updatedAt: 1_000,
          },
        },
      }),
    );
    const write = vi.spyOn(sessionStorage, "setItem");
    const listener = vi.fn();
    const unsubscribe = subscribeStoredChatOutboxChanges(listener);

    const result = retireStoredComposerDrafts({ settings: { gatewayUrl } }, [
      { key: "older", agentId: "main", retireBeforeRevision: 100 },
      { key: "newer", agentId: "main", retireBeforeRevision: 100 },
    ]);
    const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
      sessions: Record<string, { draft?: string; draftRevision?: number; queue?: unknown[] }>;
    };

    expect(result.storageFailed).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(stored.sessions["older\u0000agent:main"]).toEqual({
      draftRevision: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(stored.sessions["newer\u0000agent:main"]).toMatchObject({
      draft: "replacement",
      draftRevision: 1_000,
    });
    unsubscribe();
  });

  it("lists only non-empty drafts under the same scope used by sidebar sessions", () => {
    const gatewayUrl = "ws://gateway.test/control";
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "thread-draft\u0000agent:main": {
            draft: "finish this message",
            draftRevision: 3,
            updatedAt: 3,
          },
          "thread-empty\u0000agent:main": { draftRevision: 2, updatedAt: 2 },
          "thread-queue\u0000agent:main": {
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 1,
          },
        },
      }),
    );
    const state = { settings: { gatewayUrl } };

    expect([...listStoredDraftScopes(state)]).toEqual([
      storedChatOutboxScopeKey(resolveStoredChatOutboxScope(state, "thread-draft")),
    ]);
  });

  it("bridges matching storage events until the last subscriber leaves", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const unsubscribeFirst = subscribeStoredChatOutboxChanges(firstListener);
    const unsubscribeSecond = subscribeStoredChatOutboxChanges(secondListener);

    expect(addEventListener).toHaveBeenCalledWith("storage", expect.any(Function));

    window.dispatchEvent(
      new StorageEvent("storage", { key: "openclaw.control.chatComposer.v2:gateway" }),
    );
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new StorageEvent("storage", { key: "openclaw.control.settings.v1" }));
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new StorageEvent("storage", { key: "openclaw.control.chatComposer.v1:gateway" }),
    );
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    expect(removeEventListener).not.toHaveBeenCalledWith("storage", expect.any(Function));

    unsubscribeSecond();
    expect(removeEventListener).toHaveBeenCalledWith("storage", expect.any(Function));
  });

  it("routes shipped bare-main rows to the known default agent", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      legacyKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "main\u0000agent:previous": {
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 1,
          },
        },
      }),
    );

    const summary = summarizeStoredChatOutboxes({
      settings: { gatewayUrl },
      assistantAgentId: "previous",
      agentsList: { defaultId: "work", mainKey: "main" },
    });

    expect(summary.total).toBe(1);
    expect(
      summary.countsByScope.get(
        storedChatOutboxScopeKey({ sessionKey: "global", agentId: "work" }),
      ),
    ).toBe(1);
    expect(
      summary.countsByScope.get(
        storedChatOutboxScopeKey({ sessionKey: "global", agentId: "previous" }),
      ),
    ).toBeUndefined();
  });

  it("refreshes custom-main ownership for a later offline reload", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        mainAlias: { key: "old-main", agentId: "previous" },
        sessions: {},
      }),
    );

    summarizeStoredChatOutboxes({
      settings: { gatewayUrl },
      agentsList: { defaultId: "work", mainKey: "workspace" },
    });

    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "{}").mainAlias).toEqual({
      key: "workspace",
      agentId: "work",
    });
    expect(
      resolveStoredChatOutboxScope(
        { settings: { gatewayUrl }, agentsList: null, hello: null },
        "workspace",
      ),
    ).toEqual({ sessionKey: "global", agentId: "work" });
  });

  it("resolves legacy bare-main rows through the persisted alias on an offline reload", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        mainAlias: { key: "main", agentId: "work" },
        sessions: {
          "main\u0000agent:previous": {
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 1,
          },
        },
      }),
    );

    // Offline reload: no session defaults available, only the persisted alias.
    const offlineState = { settings: { gatewayUrl }, agentsList: null, hello: null };
    const summary = summarizeStoredChatOutboxes(offlineState);

    expect(summary.total).toBe(1);
    const sidebarScopeKey = storedChatOutboxScopeKey(
      resolveStoredChatOutboxScope(offlineState, "main"),
    );
    expect(summary.countsByScope.get(sidebarScopeKey)).toBe(1);
    expect(listStoredChatOutboxes(offlineState)).toEqual([
      {
        sessionKey: "global",
        agentId: "work",
        queue: [
          {
            id: "queued",
            text: "queued",
            createdAt: 1,
            sessionKey: "global",
            agentId: "work",
          },
        ],
      },
    ]);
  });

  it("rejects a v2 store owned by another gateway", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: "ws://other.test/control",
        sessions: {
          "global\u0000agent:work": {
            queue: [{ id: "queued", text: "queued", createdAt: 1 }],
            updatedAt: 1,
          },
        },
      }),
    );

    expect(
      summarizeStoredChatOutboxes({
        settings: { gatewayUrl },
        agentsList: { defaultId: "work", mainKey: "workspace" },
      }).total,
    ).toBe(0);
    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "{}").gatewayOwner).toBe(
      "ws://other.test/control",
    );
  });

  it("retains custom-main aliases independently for each gateway", () => {
    for (const [gatewayUrl, key, agentId] of [
      ["ws://a.test/control", "workspace-a", "alpha"],
      ["ws://b.test/control", "workspace-b", "beta"],
    ] as const) {
      sessionStorage.setItem(
        `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
        JSON.stringify({
          version: 2,
          gatewayOwner: gatewayUrl,
          mainAlias: { key, agentId },
          sessions: {},
        }),
      );
      summarizeStoredChatOutboxes({ settings: { gatewayUrl }, agentsList: null, hello: null });
    }

    expect(
      resolveStoredChatOutboxScope(
        { settings: { gatewayUrl: "ws://a.test/control" }, agentsList: null, hello: null },
        "workspace-a",
      ),
    ).toEqual({ sessionKey: "global", agentId: "alpha" });
    expect(
      resolveStoredChatOutboxScope(
        { settings: { gatewayUrl: "ws://b.test/control" }, agentsList: null, hello: null },
        "workspace-b",
      ),
    ).toEqual({ sessionKey: "global", agentId: "beta" });
  });

  it("deduplicates item ids within a scope, not across scopes", () => {
    const gatewayUrl = "ws://gateway.test/control";
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "thread-a\u0000agent:main": {
            queue: [{ id: "same", text: "first", createdAt: 1 }],
            updatedAt: 1,
          },
          "thread-b\u0000agent:main": {
            queue: [{ id: "same", text: "second", createdAt: 2 }],
            updatedAt: 2,
          },
        },
      }),
    );

    const summary = summarizeStoredChatOutboxes({ settings: { gatewayUrl } });
    expect(summary.total).toBe(2);
    expect(summary.countsByScope.get(storedChatOutboxScopeKey({ sessionKey: "thread-a" }))).toBe(1);
    expect(summary.countsByScope.get(storedChatOutboxScopeKey({ sessionKey: "thread-b" }))).toBe(1);
  });

  it("counts only durable operator-review states for session-row attention", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const quietSendStates = [
      undefined,
      "waiting-idle",
      "executing-command",
      "steering",
      "sending",
      "waiting-reconnect",
    ] as const;
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "thread-a\u0000agent:main": {
            queue: [
              ...quietSendStates.map((sendState, index) => ({
                id: `healthy-${index}`,
                text: `healthy ${index}`,
                createdAt: index,
                sendState,
              })),
              { id: "failed", text: "failed", createdAt: 10, sendState: "failed" },
              { id: "failed", text: "duplicate", createdAt: 11, sendState: "failed" },
              {
                id: "unconfirmed",
                text: "unconfirmed",
                createdAt: 12,
                sendState: "unconfirmed",
              },
              {
                id: "unconfirmed",
                text: "duplicate uncertainty",
                createdAt: 13,
                sendState: "unconfirmed",
              },
            ],
            updatedAt: 13,
          },
          "thread-b\u0000agent:main": {
            queue: [
              {
                id: "unconfirmed",
                text: "other scope",
                createdAt: 14,
                sendState: "unconfirmed",
              },
            ],
            updatedAt: 14,
          },
        },
      }),
    );

    const summary = summarizeStoredChatOutboxes({ settings: { gatewayUrl } });
    const threadA = storedChatOutboxScopeKey({ sessionKey: "thread-a" });
    const threadB = storedChatOutboxScopeKey({ sessionKey: "thread-b" });

    expect(summary.total).toBe(9);
    expect(summary.countsByScope.get(threadA)).toBe(8);
    expect(summary.countsByScope.get(threadB)).toBe(1);
    expect(summary.attentionCountsByScope.get(threadA)).toBe(2);
    expect(summary.attentionCountsByScope.get(threadB)).toBe(1);
  });

  it("derives badges and replay from the same migrated durable queue", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      legacyKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "main\u0000agent:previous": {
            queue: [
              { id: "removed", text: "removed", createdAt: 1 },
              { id: "shared", text: "older", createdAt: 2 },
            ],
            removedQueueItemIds: ["removed"],
            updatedAt: 2,
          },
          "global\u0000agent:work": {
            queue: [{ id: "shared", text: "newer", createdAt: 3 }],
            updatedAt: 3,
          },
        },
      }),
    );
    const state = {
      settings: { gatewayUrl },
      assistantAgentId: "work",
      agentsList: { defaultId: "work", mainKey: "main" },
    };

    const summary = summarizeStoredChatOutboxes(state);
    const outboxes = listStoredChatOutboxes(state);

    expect(summary.total).toBe(1);
    expect(summary.countsByScope.get(storedChatOutboxScopeKey(outboxes[0]!))).toBe(1);
    expect(outboxes[0]?.queue).toEqual([
      {
        id: "shared",
        text: "newer",
        createdAt: 3,
        sessionKey: "global",
        agentId: "work",
      },
    ]);
    expect(sessionStorage.getItem(legacyKey)).toBeNull();
  });
});
