/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { readChatOutboxRecovery } from "./outbox-recovery.ts";
import { listStoredChatOutboxes, summarizeStoredChatOutboxes } from "./outbox-store-projection.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import {
  readProjectedOutboxStore,
  readStoredOutboxStore,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
} from "./outbox-store.ts";

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stored outbox summaries", () => {
  it("normalizes an unchanged projection once and refreshes after an external write", () => {
    const unsubscribe = subscribeStoredChatOutboxChanges(() => undefined);
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ version: 4, recovery: {}, gatewayOwner: gatewayUrl, sessions: {} }),
    );
    const target = {
      gatewayOwner: gatewayUrl,
      key: storageKey,
      legacyKey: "unused",
      previousKey: "unused-v2",
      blobKey: "unused-v3",
      legacyOwnerIsUnambiguous: true,
    };
    const first = readProjectedOutboxStore(sessionStorage, target);
    expect(readProjectedOutboxStore(sessionStorage, target)).toBe(first);

    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        recovery: {},
        gatewayOwner: gatewayUrl,
        sessions: { "main\u0000agent:main": { draft: "new", updatedAt: 1 } },
      }),
    );
    const storageEvent = new StorageEvent("storage", { key: storageKey });
    Object.defineProperty(storageEvent, "storageArea", { value: sessionStorage });
    window.dispatchEvent(storageEvent);
    expect(readProjectedOutboxStore(sessionStorage, target)).not.toBe(first);
    unsubscribe();
  });

  it.each([1, 2])("refreshes a retained v%i projection after an external write", (version) => {
    const unsubscribe = subscribeStoredChatOutboxChanges(() => undefined);
    const gatewayUrl = "ws://gateway.test/control";
    const legacyKey = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
    const stored = (ids: string[]) =>
      JSON.stringify({
        version,
        ...(version === 2 ? { gatewayOwner: gatewayUrl } : {}),
        sessions: {
          "thread\u0000agent:main": {
            queue: ids.map((id, createdAt) => ({ id, text: id, createdAt })),
            updatedAt: ids.length,
          },
        },
      });
    sessionStorage.setItem(legacyKey, stored(["first"]));
    const write = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      if (key !== legacyKey) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    const state = { settings: { gatewayUrl } };
    expect(summarizeStoredChatOutboxes(state).total).toBe(1);

    sessionStorage.setItem(legacyKey, stored(["first", "second"]));
    const storageEvent = new StorageEvent("storage", { key: legacyKey });
    Object.defineProperty(storageEvent, "storageArea", { value: sessionStorage });
    window.dispatchEvent(storageEvent);

    const refreshedTotal = summarizeStoredChatOutboxes(state).total;
    unsubscribe();
    expect(refreshedTotal).toBe(2);
  });

  it.each([1, 2, 3])(
    "retains the last v%i source when quota blocks verified retirement",
    (version) => {
      const target = storageTargetForGateway("ws://gateway.test/control");
      const sourceKey =
        version === 1 ? target.legacyKey : version === 2 ? target.previousKey : target.blobKey;
      const scopeKey = storedChatOutboxScopeKey({ sessionKey: "thread", agentId: "main" });
      sessionStorage.setItem(
        sourceKey,
        JSON.stringify({
          version,
          ...(version !== 1 ? { gatewayOwner: target.gatewayOwner } : {}),
          sessions: {
            [scopeKey]: {
              queue: [{ id: "queued", text: "retire me", createdAt: 1 }],
              updatedAt: 1,
            },
          },
        }),
      );
      vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });
      const store = readStoredOutboxStore(sessionStorage, target);
      expect(store.sessions[scopeKey]?.queue).toHaveLength(1);
      store.sessions = {};
      expect(() => writeStoredOutboxStore(sessionStorage, target, store)).toThrow("quota exceeded");
      expect(readStoredOutboxStore(sessionStorage, target).sessions[scopeKey]?.queue).toEqual([
        { id: "queued", text: "retire me", createdAt: 1, sessionKey: "thread" },
      ]);
      expect(sessionStorage.getItem(sourceKey)).toContain("retire me");
    },
  );

  it("clears every retained projection after an external storage clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeStoredChatOutboxChanges(listener);
    const gatewayUrls = ["ws://first.test/control", "ws://second.test/control"];
    for (const gatewayUrl of gatewayUrls) {
      sessionStorage.setItem(
        `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`,
        JSON.stringify({
          version: 4,
          recovery: {},
          gatewayOwner: gatewayUrl,
          sessions: {
            "thread\u0000agent:main": {
              queue: [{ id: gatewayUrl, text: gatewayUrl, createdAt: 1 }],
              updatedAt: 1,
            },
          },
        }),
      );
      expect(summarizeStoredChatOutboxes({ settings: { gatewayUrl } }).total).toBe(1);
    }

    sessionStorage.clear();
    const storageEvent = new StorageEvent("storage", { key: null });
    Object.defineProperty(storageEvent, "storageArea", { value: sessionStorage });
    window.dispatchEvent(storageEvent);
    unsubscribe();

    for (const gatewayUrl of gatewayUrls) {
      expect(summarizeStoredChatOutboxes({ settings: { gatewayUrl } }).total).toBe(0);
    }
    expect(listener).toHaveBeenCalledOnce();
  });

  it("retires a captured main destination without consulting changed defaults", () => {
    const target = storageTargetForGateway("ws://captured-retirement.test");
    const original = storedChatOutboxScopeKey({ sessionKey: "agent:main:main" });
    const current = storedChatOutboxScopeKey({ sessionKey: "agent:main:current" });
    const store = readStoredOutboxStore(sessionStorage, target);
    store.sessions[original] = { draft: "old target", draftRevision: 10, updatedAt: 10 };
    store.sessions[current] = { draft: "new target", draftRevision: 11, updatedAt: 11 };
    writeStoredOutboxStore(sessionStorage, target, store);
    const state = {
      settings: { gatewayUrl: target.gatewayOwner },
      agentsList: { defaultId: "main", mainKey: "current", scope: "per-sender" },
    };
    expect(
      retireStoredComposerDrafts(state, [{ key: "agent:main:main", retireBeforeRevision: 20 }])
        .storageFailed,
    ).toBe(false);
    const retired = readStoredOutboxStore(sessionStorage, target);
    expect(retired.sessions[original]?.draft).toBeUndefined();
    expect(retired.sessions[original]?.draftRevision).toBeGreaterThan(20);
    expect(retired.sessions[current]).toEqual(store.sessions[current]);
  });

  it("keeps the exact captured scope when sessionStorage retirement fails", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        recovery: {},
        gatewayOwner: gatewayUrl,
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
    const retired = retireStoredComposerDrafts(
      {
        settings: { gatewayUrl },
      },
      [{ key: "global", agentId: "work", retireBeforeRevision: 20 }],
    );
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
    const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        recovery: {},
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

  it.each([
    {
      name: "named sessions before defaults",
      state: { hello: null },
      storedKey: "thread-draft\u0000agent:main",
      present: ["thread-draft"],
      absent: ["agent:main:thread-draft"],
    },
    {
      name: "unresolved main before defaults",
      state: { hello: null },
      storedKey: "main\u0000agent:@unresolved",
      present: ["main"],
      absent: ["agent:main:main"],
    },
    {
      name: "configured default-main aliases",
      state: {
        assistantAgentId: "previous",
        agentsList: { defaultId: "work", mainKey: "workspace" },
      },
      storedKey: "agent:work:workspace\u0000agent:work",
      present: ["main", "workspace", "agent:work:main", "agent:work:workspace"],
      absent: ["agent:previous:main"],
    },
    {
      name: "qualified cross-agent main aliases",
      state: { agentsList: { defaultId: "main", mainKey: "workspace" } },
      storedKey: "agent:work:workspace\u0000agent:work",
      present: ["agent:work:main", "agent:work:workspace"],
      absent: ["main", "workspace", "agent:main:workspace"],
    },
    {
      name: "raw global and qualified selected-agent aliases",
      state: {
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
      },
      storedKey: "global\u0000agent:work",
      present: ["global", "agent:work:main", "agent:work:workspace"],
      absent: ["main", "workspace", "agent:main:main", "agent:work:global"],
    },
    {
      name: "global default-main aliases with another agent selected",
      state: {
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
      },
      storedKey: "global\u0000agent:main",
      present: ["main", "workspace", "agent:main:main"],
      absent: ["global", "agent:work:main"],
    },
    {
      name: "qualified global-named session",
      state: {
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
      },
      storedKey: "agent:work:global\u0000agent:work",
      present: ["agent:work:global"],
      absent: ["global", "main", "agent:work:main"],
    },
    {
      name: "opaque qualified session casing",
      state: { agentsList: { defaultId: "main", mainKey: "main" } },
      storedKey: "agent:work:matrix:channel:!Room:Server\u0000agent:work",
      present: ["agent:work:matrix:channel:!Room:Server", "Agent:Work:MATRIX:CHANNEL:!Room:Server"],
      absent: ["agent:work:matrix:channel:!room:server"],
    },
  ])("queries draft and attention snapshots for $name", ({ state, storedKey, present, absent }) => {
    const gatewayUrl = "ws://gateway.test/control";
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 4,
        recovery: {},
        gatewayOwner: gatewayUrl,
        sessions: {
          [storedKey]: {
            draft: "finish this message",
            draftRevision: 3,
            queue: [
              { id: "failed", text: "retry this message", createdAt: 3, sendState: "failed" },
            ],
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
    const summary = summarizeStoredChatOutboxes({ ...state, settings: { gatewayUrl } });
    const read = vi.spyOn(sessionStorage, "getItem");
    sessionStorage.clear();

    expect(summary.total).toBe(2);
    for (const sessionKey of present) {
      expect(summary.hasSessionDraft(sessionKey), sessionKey).toBe(true);
      expect(summary.attentionCountForSession(sessionKey), sessionKey).toBe(1);
    }
    for (const sessionKey of [...absent, "thread-empty", "thread-queue", "absent"]) {
      expect(summary.hasSessionDraft(sessionKey), sessionKey).toBe(false);
      expect(summary.attentionCountForSession(sessionKey), sessionKey).toBe(0);
    }
    expect(read).not.toHaveBeenCalled();
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
      new StorageEvent("storage", { key: "openclaw.control.chatComposer.v4:gateway" }),
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

    expect(summary.total).toBe(0);
    expect(
      readChatOutboxRecovery({ settings: { gatewayUrl } }).entries[0]?.session.queue?.[0]?.id,
    ).toBe("queued");
  });

  it("rejects a v2 store owned by another gateway", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        recovery: {},
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

  it("deduplicates item ids within a scope, not across scopes", () => {
    const gatewayUrl = "ws://gateway.test/control";
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 4,
        recovery: {},
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
  });

  it("counts only durable operator-review states for session-row attention", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const restoredSendStates = [
      undefined,
      "waiting-idle",
      "executing-command",
      "sending",
      "waiting-reconnect",
    ] as const;
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 4,
        recovery: {},
        gatewayOwner: gatewayUrl,
        sessions: {
          "thread-a\u0000agent:main": {
            queue: [
              ...restoredSendStates.map((sendState, index) => ({
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
              {
                id: "other-owner",
                text: "another credential's attachment",
                createdAt: 14,
                sendState: "failed",
                attachmentPayload: { key: "bundle", recoveryScope: "other-owner", tabId: "tab" },
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
    expect(summary.total).toBe(8);
    expect(summary.attentionCountForSession("thread-a")).toBe(3);
    expect(summary.attentionCountForSession("thread-b")).toBe(1);
    expect(summary.attentionCountForSession("absent")).toBe(0);
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
