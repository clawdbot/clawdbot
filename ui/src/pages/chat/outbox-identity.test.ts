// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import {
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  loadChatComposerSnapshot,
  persistChatComposerState,
  resolveStoredChatOutboxScope,
  updateStoredChatComposerQueueItem,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

const gatewayUrl = "ws://outbox.test";
const state = {
  settings: { gatewayUrl },
  assistantAgentId: "selected",
  agentsList: { defaultId: "default", mainKey: "workspace", scope: "per-sender" },
  sessionKey: "agent:default:workspace",
  chatMessage: "draft",
  chatQueue: [],
};

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());

describe("outbox destination identity", () => {
  it.each([
    ["main", "agent:default:workspace", "default"],
    ["workspace", "agent:default:workspace", "default"],
    ["agent:other:main", "agent:other:workspace", "other"],
    ["agent:other:workspace", "agent:other:workspace", "other"],
    ["global", "global", "selected"],
    ["agent:other:global", "agent:other:global", "other"],
    ["agent:bad agent:notes", "agent:bad agent:notes", "bad-agent"],
    [
      "agent:other:matrix:channel:!AbC:example.org",
      "agent:other:matrix:channel:!AbC:example.org",
      "other",
    ],
  ])(
    "retains %s through admission, reload, and a selected-agent change",
    (input, sessionKey, agentId) => {
      const host = { ...state, sessionKey: input };
      expect(persistChatComposerState(host)).toBe(true);
      expect(
        admitStoredChatComposerQueueItem(host, input, {
          id: "queued",
          text: "follow up",
          createdAt: 1,
          sendState: "waiting-idle",
        }),
      ).toBe(true);
      const reloaded = { ...state, assistantAgentId: "different" };
      expect(listStoredChatOutboxes(reloaded)).toEqual([
        {
          sessionKey,
          agentId,
          queue: [
            {
              id: "queued",
              text: "follow up",
              createdAt: 1,
              sendState: "waiting-idle",
              sessionKey,
              agentId,
            },
          ],
        },
      ]);
      expect(loadChatComposerSnapshot(reloaded, sessionKey, agentId)?.draft).toBe("draft");
    },
  );

  it("maps main aliases to global only under configured global scope", () => {
    const host = { ...state, agentsList: { ...state.agentsList, scope: "global" } };
    expect(resolveStoredChatOutboxScope(host, "main")).toEqual({
      sessionKey: "global",
      agentId: "default",
    });
    expect(resolveStoredChatOutboxScope(host, "agent:other:workspace")).toEqual({
      sessionKey: "global",
      agentId: "other",
    });
  });

  it("never restores a sole global agent draft into unresolved main", () => {
    expect(persistChatComposerState({ ...state, sessionKey: "global" })).toBe(true);
    expect(loadChatComposerSnapshot({ settings: { gatewayUrl } }, "main")).toBeNull();
  });

  it("does not replay collapsed v2 global data using today's selected agent or main key", () => {
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "global\u0000agent:selected": {
            draft: "lost destination",
            draftRevision: 8,
            updatedAt: 8,
            queue: [
              {
                id: "uncertain",
                text: "possibly sent",
                createdAt: 1,
                sessionKey: "global",
                agentId: "selected",
                sendRunId: "original-attempt",
                sendAttempts: 1,
                sendState: "unconfirmed",
              },
            ],
          },
        },
      }),
    );
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(loadChatComposerSnapshot(state, "global")).toBeNull();
  });
});

describe("outbox browser-state transfer", () => {
  const seed = (version: 1 | 2, sessions: Record<string, unknown>) => {
    const key = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
    const raw = JSON.stringify({ version, gatewayOwner: gatewayUrl, sessions });
    sessionStorage.setItem(key, raw);
    return { key, raw };
  };
  const queue = Array.from({ length: 60 }, (_, i) => ({
    id: `saved-${i}`,
    text: `message ${i}`,
    createdAt: i + 1,
    sendRunId: `attempt-${i}`,
    sendAttempts: i === 0 ? 1 : 0,
    sendState: i === 0 ? "unconfirmed" : "waiting-reconnect",
    attachments: [
      { id: `attachment-${i}`, mimeType: "text/plain", dataUrl: "data:text/plain;base64,YQ==" },
    ],
  }));
  const legacy = {
    draft: "saved objective",
    goalMode: { action: "start" },
    draftRevision: 42,
    updatedAt: 50,
    queue,
  };

  it("preserves v1 literal global separately from qualified main, including IDs and attachments", () => {
    const source = seed(1, {
      "global\u0000agent:selected": legacy,
      "agent:selected:main\u0000agent:selected": { ...legacy, queue: [queue[0]] },
    });
    const outboxes = listStoredChatOutboxes(state);
    expect(outboxes).toHaveLength(2);
    expect(outboxes.map((box) => box.sessionKey)).toEqual(["agent:selected:main", "global"]);
    expect(outboxes.find((box) => box.sessionKey === "global")?.queue).toEqual(
      queue.map((item) => ({ ...item, sessionKey: "global", agentId: "selected" })),
    );
    expect(sessionStorage.getItem(source.key)).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key)!).sessions[
        "global\u0000agent:selected"
      ].draftRevision,
    ).toBe(42);
  });

  it("retains every collapsed entry unsent and restores it only into an explicitly confirmed empty destination", () => {
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const [entry] = readChatOutboxRecovery(state).entries;
    expect(entry?.session).toEqual(legacy);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: "agent:selected:review",
      agentId: "selected",
    })!;
    expect(restoreChatOutboxRecovery(state, entry!, destination)).toBe("restored");
    expect(readChatOutboxRecovery(state).entries).toEqual([]);
    const restored = listStoredChatOutboxes(state)[0]!;
    expect(restored.queue).toHaveLength(60);
    expect(
      restored.queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]),
    ).toEqual(queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]));
    expect(restored.queue[0]?.sendState).toBe("unconfirmed");
    expect(restored.queue.slice(1).every((item) => item.sendState === "failed")).toBe(true);
    expect(loadChatComposerSnapshot(state, restored.sessionKey)?.goalMode).toEqual({
      action: "start",
    });
    expect(sessionStorage.getItem(source.key)).toBeNull();
    expect(restoreChatOutboxRecovery(state, entry!, destination)).toBe("conflict");
  });

  it.each(["throw", "noop"])("keeps source bytes when migration storage writes %s", (failure) => {
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      if (failure === "throw") {
        throw new DOMException("quota", "QuotaExceededError");
      }
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session.queue).toHaveLength(60);
    expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    write.mockRestore();
    expect(readChatOutboxRecovery(state).entries).toHaveLength(1);
    expect(sessionStorage.getItem(source.key)).toBeNull();
  });

  it("does not overwrite a newer destination edit or remove its recoverable source", () => {
    seed(2, { "global\u0000agent:selected": legacy });
    const entry = readChatOutboxRecovery(state).entries[0]!;
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: state.sessionKey,
      agentId: "default",
    })!;
    expect(persistChatComposerState({ ...state, chatMessage: "newer input" })).toBe(true);
    expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("conflict");
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("newer input");
    expect(readChatOutboxRecovery(state).entries[0]).toEqual(entry);
  });

  it("retains later writes from an older UI for review after the current namespace exists", () => {
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const first = readChatOutboxRecovery(state).entries[0]!;
    const later = { ...legacy, draft: "written after downgrade", draftRevision: 99 };
    seed(2, { "global\u0000agent:selected": later });
    const entries = readChatOutboxRecovery(state).entries;
    expect(entries.map((entry) => entry.session.draft)).toEqual([
      first.session.draft,
      "written after downgrade",
    ]);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(sessionStorage.getItem(source.key)).toBeNull();
  });

  it("does not reimport an acknowledged source when legacy deletion failed", () => {
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {});
    const entry = readChatOutboxRecovery(state).entries[0]!;
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: state.sessionKey,
      agentId: "default",
    })!;
    expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("restored");
    expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    expect(readChatOutboxRecovery(state).entries).toEqual([]);
    expect(listStoredChatOutboxes(state)[0]?.queue).toHaveLength(60);
    remove.mockRestore();
  });

  it("keeps full recovery usable while a later source waits intact for space", () => {
    const target = storageTargetForGateway(gatewayUrl);
    sessionStorage.setItem(
      target.key,
      JSON.stringify({
        version: 3,
        gatewayOwner: gatewayUrl,
        sessions: {},
        recovery: Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [
            `old-${i}`,
            {
              sourceVersion: 2,
              sourceScopeKey: `old-${i}`,
              session: { draft: `draft ${i}`, draftRevision: i + 1, updatedAt: i + 1 },
            },
          ]),
        ),
      }),
    );
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const recovery = readChatOutboxRecovery(state);
    expect(recovery.blocked).toBe(true);
    expect(recovery.entries).toHaveLength(80);
    expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: state.sessionKey,
      agentId: "default",
    })!;
    expect(restoreChatOutboxRecovery(state, recovery.entries[0]!, destination)).toBe("restored");
    const resumed = readChatOutboxRecovery(state);
    expect(resumed.blocked).toBe(false);
    expect(resumed.entries).toHaveLength(80);
    expect(resumed.entries.at(-1)?.session).toEqual(legacy);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("draft 0");
    expect(sessionStorage.getItem(source.key)).toBeNull();
  });

  it("leaves recovery intact on failed transfer and current reopen", () => {
    seed(2, { "global\u0000agent:selected": legacy });
    const entry = readChatOutboxRecovery(state).entries[0]!;
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: state.sessionKey,
      agentId: "default",
    })!;
    const source = sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key);
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("storage-failed");
    expect(sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key)).toBe(source);
    write.mockRestore();
    const reopened = createStorageMock();
    reopened.setItem(storageTargetForGateway(gatewayUrl).key, source!);
    vi.stubGlobal("sessionStorage", reopened);
    expect(readChatOutboxRecovery(state).entries[0]).toEqual(entry);
    expect(listStoredChatOutboxes(state)).toEqual([]);
  });
});

describe("partially preserved legacy identity", () => {
  it("migrates an independently targeted item while retaining the ambiguous bucket draft", () => {
    sessionStorage.setItem(
      storageTargetForGateway(gatewayUrl).previousKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "global\u0000agent:selected": {
            draft: "ambiguous draft",
            updatedAt: 1,
            queue: [
              {
                id: "exact",
                text: "qualified",
                createdAt: 1,
                sessionKey: "agent:other:thread",
                agentId: "other",
                sendAttempts: 1,
                sendRunId: "original",
                sendState: "unconfirmed",
              },
              { id: "ambiguous", text: "collapsed", createdAt: 2, sessionKey: "global" },
            ],
          },
        },
      }),
    );
    expect(listStoredChatOutboxes(state)[0]).toMatchObject({
      sessionKey: "agent:other:thread",
      agentId: "other",
      queue: [{ id: "exact", sendRunId: "original", sendAttempts: 1, sendState: "unconfirmed" }],
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session).toMatchObject({
      draft: "ambiguous draft",
      queue: [{ id: "ambiguous" }],
    });
  });
});

describe("captured outbox scope review regressions", () => {
  it("verifies the admitted queue target when a notification changes defaults", () => {
    const host = { ...state, agentsList: { ...state.agentsList } };
    const unsubscribe = subscribeStoredChatOutboxChanges(() => {
      host.agentsList.mainKey = "changed";
    });
    try {
      const item = { id: "captured-admission", text: "keep target", createdAt: 1 };
      const admitted = admitStoredChatComposerQueueItem(host, "main", item);
      expect(listStoredChatOutboxes(host)).toEqual([
        {
          sessionKey: state.sessionKey,
          agentId: "default",
          queue: [{ ...item, sessionKey: state.sessionKey, agentId: "default" }],
        },
      ]);
      expect(admitted).toBe(true);
    } finally {
      unsubscribe();
    }
  });
  it("updates and removes an enumerated captured scope after mainKey changes", () => {
    const initial = {
      ...state,
      sessionKey: "agent:main:main",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    };
    expect(
      admitStoredChatComposerQueueItem(initial, initial.sessionKey, {
        id: "captured",
        text: "keep target",
        createdAt: 1,
      }),
    ).toBe(true);
    const changed = { ...initial, agentsList: { ...initial.agentsList, mainKey: "workspace" } };
    const original = listStoredChatOutboxes(changed)[0]!;
    const item = original.queue[0]!;
    const next = {
      ...item,
      sendState: "unconfirmed" as const,
      sendAttempts: 1,
      sendRunId: "captured-attempt",
    };
    expect(
      updateStoredChatComposerQueueItem(changed, original.sessionKey, item, next, "other"),
    ).toBe(false);
    removeStoredChatComposerQueueItem(changed, original.sessionKey, item.id, item, "other");
    expect(listStoredChatOutboxes(changed)).toEqual([original]);
    expect(
      updateStoredChatComposerQueueItem(changed, original.sessionKey, item, next, original.agentId),
    ).toBe(true);
    expect(listStoredChatOutboxes(changed)[0]).toMatchObject({
      sessionKey: initial.sessionKey,
      queue: [next],
    });
    expect(
      removeStoredChatComposerQueueItem(
        changed,
        original.sessionKey,
        item.id,
        next,
        original.agentId,
      ),
    ).toBe(true);
    expect(listStoredChatOutboxes(changed)).toEqual([]);
  });
  it.each(["bucket", "item"])(
    "quarantines conflicting %s agent facts in legacy state",
    (conflict) => {
      const scopeKey = `agent:main:notes\u0000agent:${conflict === "bucket" ? "work" : "main"}`;
      sessionStorage.setItem(
        storageTargetForGateway(gatewayUrl).legacyKey,
        JSON.stringify({
          version: 1,
          sessions: {
            [scopeKey]: {
              updatedAt: 1,
              queue: [
                {
                  id: "conflicting",
                  text: "preserve me",
                  createdAt: 1,
                  sessionKey: "agent:main:notes",
                  agentId: "work",
                },
              ],
            },
          },
        }),
      );
      expect(listStoredChatOutboxes(state)).toEqual([]);
      expect(readChatOutboxRecovery(state).entries[0]?.session.queue?.[0]).toMatchObject({
        id: "conflicting",
        agentId: "work",
        sessionKey: "agent:main:notes",
      });
    },
  );
});
