/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
  summarizeStoredChatOutboxes,
} from "./outbox-store.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stored outbox summaries", () => {
  it("bridges matching cross-tab storage changes until the last subscriber leaves", () => {
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
});
