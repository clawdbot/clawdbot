// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGoalDraftMode, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { readChatOutboxRecovery } from "../../lib/chat/outbox-recovery.ts";
import {
  captureChatOutboxAdmission,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  listStoredChatOutboxes,
  loadChatComposerDraftRevision,
  loadChatComposerSnapshot,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  restoreChatComposerState,
  updateStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

type ComposerState = Parameters<typeof persistChatComposerState>[0] & {
  selectedChatSessionIncognito: boolean;
};

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v4:";

function gatewayOwner(gatewayUrl: string | null | undefined): string {
  return gatewayUrl?.trim() || "default";
}

function legacyStorageKeyForGateway(gatewayUrl: string | null | undefined): string {
  return `${LEGACY_STORAGE_KEY_PREFIX}${encodeURIComponent(gatewayOwner(gatewayUrl)).slice(0, 240)}`;
}

function storageKeyForGateway(gatewayUrl: string | null | undefined): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(gatewayOwner(gatewayUrl))}`;
}

function createState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    selectedChatSessionIncognito: false,
    ...overrides,
  };
}

function reconnectItem(id: string, createdAt: number): ChatQueueItem {
  return {
    id,
    text: `message ${id}`,
    createdAt,
    sendRunId: `run-${id}`,
    sendState: "waiting-reconnect",
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat composer persistence", () => {
  it.each<ChatGoalDraftMode>([
    { action: "start", sessionId: "session-a" },
    {
      action: "edit",
      sessionId: "session-a",
      goalId: "goal-a",
      previousDraft: "Prior conversation draft",
    },
  ])("restores $action mode with its literal draft and exact target", (goalMode) => {
    const state = createState({
      chatMessage: "  /goal clear\n  literal objective ",
      chatGoalDraftMode: goalMode,
    });
    expect(persistChatComposerState(state)).toBe(true);
    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);
    expect(restored.chatMessage).toBe(state.chatMessage);
    expect(restored.chatGoalDraftMode).toEqual(goalMode);
    expect(loadChatComposerSnapshot(state, "agent:lily:other")).toBeNull();

    const queued = reconnectItem("other-message", 1);
    const queuedAdmission = captureChatOutboxAdmission(state, state.sessionKey, queued.agentId);
    expect(admitStoredChatComposerQueueItem(state, queuedAdmission, queued)).toBe(true);
    expect(removeStoredChatComposerQueueItem(state, state.sessionKey, queued.id)).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toEqual(goalMode);
  });

  it("persists empty Goal mode and gives cancellation a new draft revision", () => {
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatGoalDraftMode = { action: "start", sessionId: "session-a" };
    persistence.schedule();
    persistence.persistNow();
    const revision = loadChatComposerDraftRevision(state, state.sessionKey);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toEqual(
      state.chatGoalDraftMode,
    );
    state.chatGoalDraftMode = null;
    persistence.schedule();
    persistence.persistNow();
    expect(loadChatComposerDraftRevision(state, state.sessionKey)).toBeGreaterThan(revision);
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
    persistence.stop();
  });

  it("fences a same-revision retry that changes objective interpretation", () => {
    const state = createState({
      chatMessage: "/goal clear",
      chatGoalDraftMode: { action: "start" },
    });
    expect(persistChatComposerState(state, state.sessionKey, { draftRevision: 10 })).toBe(true);
    expect(
      persistChatComposerState(state, state.sessionKey, { draftRevision: 10, goalMode: null }),
    ).toBe(false);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toEqual({
      action: "start",
    });
  });

  it("does not persist whitespace-only drafts", () => {
    const state = createState({ chatMessage: "  \n  " });

    expect(persistChatComposerState(state)).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
  });

  it("normalizes an existing whitespace-only stored draft during restore", () => {
    const state = createState();
    const gatewayUrl = state.settings?.gatewayUrl;
    sessionStorage.setItem(
      storageKeyForGateway(gatewayUrl),
      JSON.stringify({
        version: 4,
        recovery: {},
        gatewayOwner: gatewayUrl,
        sessions: {
          [`${state.sessionKey}\u0000agent:lily`]: {
            draft: "  \n  ",
            draftRevision: 1,
            updatedAt: 1,
          },
        },
      }),
    );

    expect(restoreChatComposerState(state)).toBe(false);
    expect(state.chatMessage).toBe("");
  });

  it("loads legacy steer rows as generic mode-bearing sends and never rewrites old fields", () => {
    const state = createState();
    const gatewayUrl = state.settings?.gatewayUrl;
    const storageKey = storageKeyForGateway(gatewayUrl);
    sessionStorage.setItem(
      storageKey.replace(".v4:", ".v2:"),
      JSON.stringify({
        version: 2,
        recovery: {},
        gatewayOwner: gatewayUrl,
        sessions: {
          [`${state.sessionKey}\u0000agent:lily`]: {
            queue: [
              {
                id: "steer-reload",
                text: "keep the target",
                createdAt: 1,
                kind: "steered",
                sendRunId: "steer-request",
                sendState: "steering",
                steerTargetRunId: "active-run",
              },
            ],
            updatedAt: 1,
          },
        },
      }),
    );

    const restored = loadChatComposerSnapshot(state, state.sessionKey)?.queue[0];
    expect(restored).toMatchObject({
      id: "steer-reload",
      queueMode: "steer",
      sendRunId: "steer-request",
      sendState: "unconfirmed",
    });
    expect(restored).not.toHaveProperty("kind");
    expect(restored).not.toHaveProperty("steerTargetRunId");

    expect(
      updateStoredChatComposerQueueItem(
        state,
        state.sessionKey,
        restored!,
        { ...restored!, text: "updated" },
        restored?.agentId,
      ),
    ).toBe(true);
    const written = sessionStorage.getItem(storageKey) ?? "";
    expect(written).toContain('"queueMode":"steer"');
    expect(written).not.toContain('"kind":"steered"');
    expect(written).not.toContain("steerTargetRunId");
    expect(written).not.toContain('"sendState":"steering"');
  });

  it("keeps a pending draft and its route handoff on the identity captured before defaults change", () => {
    const state = createState({
      sessionKey: "agent:main:main",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "draft for the original main";
    persistence.schedule();
    state.agentsList = { defaultId: "main", mainKey: "workspace", scope: "per-sender" };
    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    persistence.persistNow();
    const stored = JSON.parse(
      sessionStorage.getItem(storageKeyForGateway(state.settings?.gatewayUrl))!,
    );
    expect(stored.sessions["agent:main:main\u0000agent:main"].draft).toBe(
      "draft for the original main",
    );
    expect(stored.sessions["agent:main:workspace\u0000agent:main"]).toBeUndefined();
    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    persistence.stop();
  });

  it("notifies stored outbox subscribers on draft presence transitions and queue writes", () => {
    const state = createState();
    const original = reconnectItem("notify", 1);
    const updated = { ...original, text: "updated message" };
    const listener = vi.fn();
    const unsubscribe = subscribeStoredChatOutboxChanges(listener);

    try {
      expect(persistChatComposerState({ ...state, chatMessage: "draft only" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      // Content-only re-persists stay silent so projection subscribers cannot
      // react by re-persisting a stale pane over the newer draft.
      expect(persistChatComposerState({ ...state, chatMessage: "draft only, edited" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(persistChatComposerState({ ...state, chatMessage: "" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
      const originalAdmission = captureChatOutboxAdmission(
        state,
        state.sessionKey,
        original.agentId,
      );
      expect(admitStoredChatComposerQueueItem(state, originalAdmission, original)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(
        updateStoredChatComposerQueueItem(
          state,
          state.sessionKey,
          original,
          updated,
          original.agentId,
        ),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
    }

    expect(
      removeStoredChatComposerQueueItem(
        state,
        state.sessionKey,
        updated.id,
        updated,
        updated.agentId,
      ),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("flushes a debounced draft before its owner releases state", () => {
    vi.useFakeTimers();
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "persist during disconnect";
    persistence.schedule();

    persistence.stop();

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "persist during disconnect",
      queue: [],
    });
  });

  it("keeps debounced draft writes out of durable queue ownership", () => {
    const state = createState({
      chatQueue: [reconnectItem("memory-only", 1)],
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatQueue = [reconnectItem("new-memory-only", 2)];

    persistence.persistChangedState();

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
  });

  it("does not erase another split pane draft when its own draft is unchanged", () => {
    const untouchedPane = createState();
    const untouchedPersistence = new ChatComposerPersistence(() => untouchedPane);
    untouchedPersistence.start();

    const editedPane = createState({ chatMessage: "draft from the other pane" });
    expect(persistChatComposerState(editedPane)).toBe(true);

    expect(untouchedPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(loadChatComposerSnapshot(editedPane, editedPane.sessionKey)?.draft).toBe(
      "draft from the other pane",
    );
  });

  it("does not let an older pane timer overwrite a newer split-pane draft", () => {
    vi.useFakeTimers();
    const olderPane = createState();
    const olderPersistence = new ChatComposerPersistence(() => olderPane);
    olderPersistence.start();
    const newerPane = createState();
    const newerPersistence = new ChatComposerPersistence(() => newerPane);
    newerPersistence.start();

    olderPane.chatMessage = "older draft";
    olderPersistence.schedule();
    newerPane.chatMessage = "newer draft";
    newerPersistence.schedule();
    expect(newerPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(newerPane, newerPane.sessionKey)?.draft).toBe("newer draft");
    expect(olderPersistence.persistForRouteSwitchResult().status).toBe("conflict");

    olderPane.chatMessage = "newest draft after conflict";
    olderPersistence.schedule();
    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(olderPane, olderPane.sessionKey)?.draft).toBe(
      "newest draft after conflict",
    );
  });

  it("keeps the later edit when split pane timers flush in natural order", () => {
    vi.useFakeTimers();
    const firstPane = createState();
    const firstPersistence = new ChatComposerPersistence(() => firstPane);
    firstPersistence.start();
    const secondPane = createState();
    const secondPersistence = new ChatComposerPersistence(() => secondPane);
    secondPersistence.start();

    firstPane.chatMessage = "first draft";
    firstPersistence.schedule();
    vi.advanceTimersByTime(10);
    secondPane.chatMessage = "later draft";
    secondPersistence.schedule();

    vi.advanceTimersByTime(190);
    expect(loadChatComposerSnapshot(firstPane, firstPane.sessionKey)?.draft).toBe("first draft");

    vi.advanceTimersByTime(10);
    expect(loadChatComposerSnapshot(secondPane, secondPane.sessionKey)?.draft).toBe("later draft");
  });

  it("does not let an older pane timer resurrect a draft after a newer clear", () => {
    vi.useFakeTimers();
    const initial = createState({ chatMessage: "saved draft" });
    expect(persistChatComposerState(initial)).toBe(true);
    const olderPane = createState({ chatMessage: "saved draft" });
    const olderPersistence = new ChatComposerPersistence(() => olderPane);
    olderPersistence.start();
    const clearingPane = createState({ chatMessage: "saved draft" });
    const clearingPersistence = new ChatComposerPersistence(() => clearingPane);
    clearingPersistence.start();

    olderPane.chatMessage = "stale replacement";
    olderPersistence.schedule();
    clearingPane.chatMessage = "";
    clearingPersistence.schedule();
    expect(clearingPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(initial, initial.sessionKey)).toBeNull();
  });

  it("persists a delayed global draft to the agent scope captured when typed", () => {
    const state = createState({
      assistantAgentId: "alpha",
      chatMessage: "",
      sessionKey: "global",
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "alpha draft";
    persistence.schedule();

    const beta = createState({
      assistantAgentId: "beta",
      chatMessage: "beta draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(beta)).toBe(true);
    state.assistantAgentId = "beta";

    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "global",
      agentId: "alpha",
    });
    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "global",
      agentId: "alpha",
    });
    expect(loadChatComposerSnapshot({ ...state, assistantAgentId: "alpha" }, "global")?.draft).toBe(
      "alpha draft",
    );
    expect(loadChatComposerSnapshot(beta, "global")?.draft).toBe("beta draft");
  });

  it("flushes a route-provided draft applied after persistence starts", () => {
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "draft from route input";
    persistence.schedule();

    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("draft from route input");
  });

  it("reports when durable outboxes leave no storage slot for a draft", () => {
    const state = createState();
    for (let index = 0; index < 20; index += 1) {
      const sessionKey = `agent:worker-${index}:thread`;
      expect(
        admitStoredChatComposerQueueItem(
          state,
          captureChatOutboxAdmission(state, sessionKey),
          reconnectItem(`scope-${index}`, index),
        ),
      ).toBe(true);
    }

    const draft = createState({
      sessionKey: "agent:draft-owner:thread",
      chatMessage: "keep this in memory when storage is full",
    });
    expect(persistChatComposerState(draft)).toBe(false);
    expect(loadChatComposerSnapshot(draft, draft.sessionKey)).toBeNull();
  });

  it("preserves a newer outbox attempt when a stale pane saves its draft", () => {
    const admitted = reconnectItem("shared", 1);
    const stalePane = createState({ chatQueue: [admitted] });
    const admittedAdmission = captureChatOutboxAdmission(
      stalePane,
      stalePane.sessionKey,
      admitted.agentId,
    );
    expect(admitStoredChatComposerQueueItem(stalePane, admittedAdmission, admitted)).toBe(true);
    const attempted = { ...admitted, sendAttempts: 1 };
    expect(
      updateStoredChatComposerQueueItem(stalePane, stalePane.sessionKey, admitted, attempted),
    ).toBe(true);

    stalePane.chatMessage = "stale pane draft";
    expect(persistChatComposerState(stalePane)).toBe(true);

    expect(loadChatComposerSnapshot(stalePane, stalePane.sessionKey)).toEqual({
      draft: "stale pane draft",
      queue: [
        {
          ...attempted,
          sessionKey: "agent:lily:main",
          agentId: "lily",
        },
      ],
    });
  });

  it("admits distinct same-scope items without whole-queue overwrite", () => {
    const first = reconnectItem("first-pane", 1);
    const second = reconnectItem("second-pane", 2);

    expect(
      admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", first.agentId),
        first,
      ),
    ).toBe(true);
    expect(
      admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", second.agentId),
        second,
      ),
    ).toBe(true);

    expect(
      loadChatComposerSnapshot(createState(), "agent:lily:main")?.queue.map((item) => item.id),
    ).toEqual(["first-pane", "second-pane"]);
  });

  it("rejects conflicting admission of an existing item id", () => {
    const item = reconnectItem("same-id", 1);
    expect(
      admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", item.agentId),
        item,
      ),
    ).toBe(true);

    expect(
      admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", item.agentId),
        {
          ...item,
          text: "different payload",
        },
      ),
    ).toBe(false);
  });

  it.each(["send-attempt", "payload-reference"])(
    "uses item versions to reject stale updates and deletes after a %s change",
    (change) => {
      const state = createState({
        chatMessage: "keep this draft",
        client: { recoveryScope: "versioned-owner", recoveryScopeReady: true },
      });
      persistChatComposerState(state);
      const reference = {
        key: "original-payload",
        recoveryScope: "versioned-owner",
        tabId: "versioned-tab",
      };
      const original: ChatQueueItem = {
        ...reconnectItem("versioned", 1),
        attachments: [{ id: "versioned-file", mimeType: "image/png", sizeBytes: 3 }],
        attachmentPayload: reference,
      };
      const successor =
        change === "send-attempt"
          ? { ...original, sendAttempts: 1 }
          : { ...original, attachmentPayload: { ...reference, key: "replacement-payload" } };
      const originalAdmission = captureChatOutboxAdmission(
        state,
        state.sessionKey,
        original.agentId,
      );
      expect(admitStoredChatComposerQueueItem(state, originalAdmission, original)).toBe(true);
      expect(updateStoredChatComposerQueueItem(state, state.sessionKey, original, successor)).toBe(
        true,
      );

      expect(
        updateStoredChatComposerQueueItem(state, state.sessionKey, original, {
          ...original,
          sendAttempts: 2,
        }),
      ).toBe(false);
      expect(
        removeStoredChatComposerQueueItem(state, state.sessionKey, original.id, original),
      ).toBe(false);
      expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue[0]).toMatchObject(successor);
      expect(
        removeStoredChatComposerQueueItem(state, state.sessionKey, successor.id, successor),
      ).toBe(true);
      expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
        draft: "keep this draft",
        queue: [],
      });
    },
  );

  it("keeps unresolved bare main and raw global independent until their owners resolve", () => {
    const offlineMain = createState({ agentsList: null, hello: null, sessionKey: "main" });
    const offlineGlobal = createState({ agentsList: null, hello: null, sessionKey: "global" });
    const mainItem = reconnectItem("unresolved-main", 1);
    const globalItem = reconnectItem("unresolved-global", 2);
    const mainAdmission = captureChatOutboxAdmission(offlineMain, "main", mainItem.agentId);
    expect(admitStoredChatComposerQueueItem(offlineMain, mainAdmission, mainItem)).toBe(true);
    const globalAdmission = captureChatOutboxAdmission(offlineGlobal, "global", globalItem.agentId);
    expect(admitStoredChatComposerQueueItem(offlineGlobal, globalAdmission, globalItem)).toBe(true);
    expect(listStoredChatOutboxes(offlineMain)).toEqual([
      {
        sessionKey: "main",
        queue: [{ ...mainItem, sessionKey: "main" }],
      },
      {
        sessionKey: "global",
        queue: [{ ...globalItem, sessionKey: "global" }],
      },
    ]);

    const resolved = createState({
      agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
      assistantAgentId: "alpha",
      sessionKey: "global",
    });
    expect(listStoredChatOutboxes(resolved)).toEqual([
      {
        sessionKey: "global",
        agentId: "work",
        queue: [{ ...mainItem, sessionKey: "global", agentId: "work" }],
      },
      {
        sessionKey: "global",
        agentId: "alpha",
        queue: [{ ...globalItem, sessionKey: "global", agentId: "alpha" }],
      },
    ]);

    const attemptedMain = {
      ...mainItem,
      agentId: "work",
      sendAttempts: 1,
      sessionKey: "global",
    };
    const attemptedGlobal = {
      ...globalItem,
      agentId: "alpha",
      sendAttempts: 1,
      sessionKey: "global",
    };
    expect(
      updateStoredChatComposerQueueItem(
        resolved,
        "global",
        { ...mainItem, agentId: "work", sessionKey: "global" },
        attemptedMain,
      ),
    ).toBe(true);
    expect(
      updateStoredChatComposerQueueItem(
        resolved,
        "global",
        { ...globalItem, agentId: "alpha", sessionKey: "global" },
        attemptedGlobal,
      ),
    ).toBe(true);
    expect(removeStoredChatComposerQueueItem(resolved, "global", mainItem.id, attemptedMain)).toBe(
      true,
    );
    expect(listStoredChatOutboxes(resolved)).toEqual([
      {
        sessionKey: "global",
        agentId: "alpha",
        queue: [attemptedGlobal],
      },
    ]);
    expect(
      removeStoredChatComposerQueueItem(resolved, "global", globalItem.id, attemptedGlobal),
    ).toBe(true);
    expect(listStoredChatOutboxes(resolved)).toEqual([]);
  });

  it("migrates an unknown bare main alias to the default agent", () => {
    const offline = createState({
      agentsList: null,
      assistantAgentId: "work",
      chatMessage: "offline workspace draft",
      hello: null,
      sessionKey: "workspace",
    });
    const item = reconnectItem("offline-workspace", 1);
    expect(persistChatComposerState(offline)).toBe(true);
    const admission = captureChatOutboxAdmission(offline, offline.sessionKey, item.agentId);
    expect(admitStoredChatComposerQueueItem(offline, admission, item)).toBe(true);

    const reconnected = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      assistantAgentId: "alpha",
      sessionKey: "global",
    });
    const defaultWork = { ...reconnected, assistantAgentId: "work" };
    expect(listStoredChatOutboxes(reconnected)).toEqual([
      {
        agentId: "work",
        queue: [{ ...item, agentId: "work", sessionKey: "global" }],
        sessionKey: "global",
      },
    ]);
    expect(loadChatComposerSnapshot(defaultWork, "global")).toEqual({
      draft: "offline workspace draft",
      queue: [{ ...item, agentId: "work", sessionKey: "global" }],
    });
    expect(loadChatComposerSnapshot(reconnected, "global")).toBeNull();
  });

  it("retains shipped bare main aliases for explicit destination confirmation", () => {
    const sourceKey = legacyStorageKeyForGateway("ws://gateway.test/control");
    const item = reconnectItem("legacy-main", 1);
    sessionStorage.setItem(
      sourceKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "main\u0000agent:previous": { queue: [item], updatedAt: 1 },
        },
      }),
    );
    const host = createState({ agentsList: { defaultId: "work", mainKey: "main" } });
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(readChatOutboxRecovery(host).entries[0]?.session.queue).toEqual([item]);
  });

  it("keeps an unknown non-main opaque route agentless", () => {
    const state = createState({
      agentsList: null,
      assistantAgentId: "work",
      hello: null,
      sessionKey: "matrix:group:RoomCase",
    });
    const item = reconnectItem("opaque-room", 1);
    const admission = captureChatOutboxAdmission(state, state.sessionKey, item.agentId);
    expect(admitStoredChatComposerQueueItem(state, admission, item)).toBe(true);

    expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue).toEqual([
      { ...item, sessionKey: state.sessionKey },
    ]);
    expect(listStoredChatOutboxes(state)).toEqual([
      {
        queue: [{ ...item, sessionKey: state.sessionKey }],
        sessionKey: state.sessionKey,
      },
    ]);
  });

  it("migrates and mutates shipped selected-agent opaque rows", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    const sessionKey = "matrix:group:RoomCase";
    const first = reconnectItem("legacy-work", 1);
    const second = reconnectItem("legacy-alpha", 2);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          [`${sessionKey}\u0000agent:work`]: {
            draft: "older draft",
            queue: [first],
            updatedAt: 1,
          },
          [`${sessionKey}\u0000agent:alpha`]: {
            draft: "newer draft",
            queue: [second],
            updatedAt: 2,
          },
        },
      }),
    );
    const state = createState({ assistantAgentId: "alpha", sessionKey });

    expect(listStoredChatOutboxes(state)).toEqual([
      {
        queue: [{ ...first, sessionKey }],
        sessionKey,
      },
    ]);
    expect(loadChatComposerSnapshot(state, sessionKey)).toEqual({
      draft: "older draft",
      queue: [{ ...first, sessionKey }],
    });

    const attempted = { ...first, sendAttempts: 1, sessionKey };
    expect(
      updateStoredChatComposerQueueItem(state, sessionKey, { ...first, sessionKey }, attempted),
    ).toBe(true);
    expect(removeStoredChatComposerQueueItem(state, sessionKey, first.id, attempted)).toBe(true);
    expect(loadChatComposerSnapshot(state, sessionKey)).toEqual({
      draft: "older draft",
      queue: [],
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session).toMatchObject({
      draft: "newer draft",
      queue: [second],
    });
    const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
      sessions?: Record<string, unknown>;
    };
    expect(Object.keys(stored.sessions ?? {})).toEqual([`${sessionKey}\u0000agent:main`]);
  });

  it("does not retarget an explicit agent when a custom main alias becomes known", () => {
    const offline = createState({
      agentsList: null,
      assistantAgentId: "work",
      hello: null,
      sessionKey: "agent:main:workspace",
    });
    const item = reconnectItem("explicit-main-workspace", 1);
    const admission = captureChatOutboxAdmission(offline, offline.sessionKey, item.agentId);
    expect(admitStoredChatComposerQueueItem(offline, admission, item)).toBe(true);

    const selectedWork = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      assistantAgentId: "work",
      sessionKey: "global",
    });
    expect(loadChatComposerSnapshot(selectedWork, "global")).toBeNull();
    const selectedMain = { ...selectedWork, assistantAgentId: "main" };
    expect(loadChatComposerSnapshot(selectedMain, "global")?.queue).toEqual([
      { ...item, agentId: "main", sessionKey: "global" },
    ]);
  });

  it("retains an unknown custom-main clear until defaults can migrate it", () => {
    const resolved = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      assistantAgentId: "work",
      chatMessage: "stale custom-main draft",
      sessionKey: "global",
    });
    const queued = reconnectItem("custom-main-queue", 1);
    expect(persistChatComposerState(resolved)).toBe(true);
    const queuedAdmission = captureChatOutboxAdmission(
      resolved,
      resolved.sessionKey,
      queued.agentId,
    );
    expect(admitStoredChatComposerQueueItem(resolved, queuedAdmission, queued)).toBe(true);

    const offline = createState({
      agentsList: null,
      assistantAgentId: null,
      hello: null,
      sessionKey: "workspace",
    });
    expect(persistChatComposerState(offline)).toBe(true);
    for (let index = 0; index < 21; index += 1) {
      const sessionKey = `agent:custom-draft-${index}:thread`;
      expect(
        persistChatComposerState(
          createState({ chatMessage: `newer custom ordinary draft ${index}`, sessionKey }),
        ),
      ).toBe(true);
    }
    for (let index = 0; index < 19; index += 1) {
      const sessionKey = `agent:custom-capacity-${index}:thread`;
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey),
          reconnectItem(`custom-clear-capacity-${index}`, index + 2),
        ),
      ).toBe(true);
    }
    for (let index = 0; index < 25; index += 1) {
      expect(
        persistChatComposerState(createState({ sessionKey: `agent:newer-clear-${index}:thread` })),
      ).toBe(true);
    }

    const gatewayUrl = offline.settings?.gatewayUrl;
    const storageKey = storageKeyForGateway(gatewayUrl);
    const stored = sessionStorage.getItem(storageKey);
    expect(stored).not.toBeNull();
    const freshStorage = createStorageMock();
    freshStorage.setItem(storageKey, stored!);
    vi.stubGlobal("sessionStorage", freshStorage);

    expect(loadChatComposerSnapshot(resolved, "global")).toEqual({
      draft: "",
      queue: [{ ...queued, agentId: "work", sessionKey: "global" }],
    });
    expect(listStoredChatOutboxes(resolved)).toHaveLength(20);
  });

  it("restores an agent-qualified custom main alias before defaults load", () => {
    const connected = createState({
      agentsList: { defaultId: "work", mainKey: "workspace" },
      assistantAgentId: "work",
      chatMessage: "qualified custom-main draft",
      sessionKey: "agent:work:workspace",
    });
    const queued = reconnectItem("qualified-custom-main", 1);
    expect(persistChatComposerState(connected)).toBe(true);
    const queuedAdmission = captureChatOutboxAdmission(
      connected,
      connected.sessionKey,
      queued.agentId,
    );
    expect(admitStoredChatComposerQueueItem(connected, queuedAdmission, queued)).toBe(true);

    const gatewayUrl = connected.settings?.gatewayUrl;
    const storageKey = storageKeyForGateway(gatewayUrl);
    const stored = sessionStorage.getItem(storageKey);
    expect(stored).not.toBeNull();
    const freshStorage = createStorageMock();
    freshStorage.setItem(storageKey, stored!);
    vi.stubGlobal("sessionStorage", freshStorage);

    const offline = createState({
      agentsList: null,
      assistantAgentId: null,
      hello: null,
      sessionKey: "agent:work:workspace",
    });
    expect(loadChatComposerDraftRevision(offline, offline.sessionKey)).toBeGreaterThan(0);
    expect(resolveUiConversationIdentity(offline, offline.sessionKey)).toEqual({
      agentId: "work",
      sessionKey: "agent:work:workspace",
    });
    expect(loadChatComposerSnapshot(offline, offline.sessionKey)).toEqual({
      draft: "qualified custom-main draft",
      queue: [{ ...queued, agentId: "work", sessionKey: offline.sessionKey }],
    });

    const unrelatedRoute = "agent:work:project";
    expect(resolveUiConversationIdentity(offline, unrelatedRoute)).toEqual({
      agentId: "work",
      sessionKey: unrelatedRoute,
    });
    expect(loadChatComposerSnapshot(offline, unrelatedRoute)).toBeNull();
  });

  it("does not let bounded clear fences crowd out a live draft", () => {
    for (let index = 0; index < 20; index += 1) {
      const sessionKey = `agent:clear-only-${index}:thread`;
      expect(persistChatComposerState(createState({ sessionKey }))).toBe(true);
    }

    const live = createState({
      chatMessage: "keep this live input",
      sessionKey: "agent:live-after-clears:thread",
    });
    expect(persistChatComposerState(live)).toBe(true);
    expect(loadChatComposerSnapshot(live, live.sessionKey)?.draft).toBe("keep this live input");
  });

  it("migrates unresolved global input only to the selected agent", () => {
    const alpha = createState({ assistantAgentId: "alpha", sessionKey: "global" });
    const alphaItem = reconnectItem("alpha-existing", 1);
    const alphaAdmission = captureChatOutboxAdmission(alpha, "global", alphaItem.agentId);
    expect(admitStoredChatComposerQueueItem(alpha, alphaAdmission, alphaItem)).toBe(true);

    const unresolved = createState({ agentsList: null, hello: null, sessionKey: "global" });
    const unresolvedItem = reconnectItem("selected-work", 2);
    const unresolvedAdmission = captureChatOutboxAdmission(
      unresolved,
      "global",
      unresolvedItem.agentId,
    );
    expect(admitStoredChatComposerQueueItem(unresolved, unresolvedAdmission, unresolvedItem)).toBe(
      true,
    );

    const selectedWork = createState({
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main" },
      sessionKey: "global",
    });
    expect(listStoredChatOutboxes(selectedWork)).toEqual([
      {
        sessionKey: "global",
        agentId: "alpha",
        queue: [{ ...alphaItem, sessionKey: "global", agentId: "alpha" }],
      },
      {
        sessionKey: "global",
        agentId: "work",
        queue: [{ ...unresolvedItem, sessionKey: "global", agentId: "work" }],
      },
    ]);
  });

  it("retains every queued input across distinct shipped main and global buckets", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = legacyStorageKeyForGateway(gatewayUrl);
    const first = Array.from({ length: 50 }, (_, index) =>
      reconnectItem(`canonical-${index}`, index),
    );
    const second = Array.from({ length: 50 }, (_, index) =>
      reconnectItem(`legacy-${index}`, 50 + index),
    );
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "global\u0000agent:work": { queue: first, updatedAt: 2 },
          "agent:work:main\u0000agent:work": { queue: second, updatedAt: 1 },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "global" });
    const restored = loadChatComposerSnapshot(state, "global")?.queue ?? [];

    expect(restored).toHaveLength(50);
    expect(
      listStoredChatOutboxes(state)
        .flatMap((box) => box.queue)
        .map((item) => item.id),
    ).toEqual([...first, ...second].map((item) => item.id));
    expect(loadChatComposerSnapshot(state, "agent:work:main")?.queue).toHaveLength(50);
  });

  it("retains an older alias draft when a newer canonical row only updates the queue", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    const item = reconnectItem("newer-queue", 2);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "global\u0000agent:work": { queue: [item], updatedAt: 2 },
          "agent:work:main\u0000agent:work": { draft: "keep this draft", updatedAt: 1 },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(loadChatComposerSnapshot(state, "global")).toEqual({
      draft: "",
      queue: [{ ...item, sessionKey: "global", agentId: "work" }],
    });
    expect(loadChatComposerSnapshot(state, "agent:work:main")?.draft).toBe("keep this draft");
    expect(sessionStorage.getItem(storageKey)).toContain("agent:work:main");
    expect(sessionStorage.getItem(legacyStorageKey)).toBeNull();
  });

  it("restores and mutates a shipped qualified-main alias before Gateway defaults load", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const item = reconnectItem("legacy-offline-reload", 1);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:work:main\u0000agent:work": {
            queue: [{ ...item, sessionKey: "agent:work:main", agentId: "work" }],
            updatedAt: 1,
          },
        },
      }),
    );

    const offline = createState({ sessionKey: "agent:work:main" });
    const restored = { ...item, agentId: "work", sessionKey: "agent:work:main" };
    expect(loadChatComposerSnapshot(offline, "agent:work:main")?.queue).toEqual([restored]);
    expect(sessionStorage.getItem(storageKeyForGateway(gatewayUrl))).toContain("agent:work:main");

    const attempted = { ...restored, sendAttempts: 1 };
    expect(updateStoredChatComposerQueueItem(offline, "agent:work:main", restored, attempted)).toBe(
      true,
    );
    expect(loadChatComposerSnapshot(offline, "agent:work:main")?.queue).toEqual([attempted]);
    expect(removeStoredChatComposerQueueItem(offline, "agent:work:main", item.id, attempted)).toBe(
      true,
    );
    expect(loadChatComposerSnapshot(offline, "agent:work:main")).toBeNull();
  });

  it("does not guess between agent-scoped main outboxes before defaults load", () => {
    const workItem = reconnectItem("work-offline", 1);
    const otherItem = reconnectItem("other-offline", 2);
    expect(
      admitStoredChatComposerQueueItem(
        createState({ assistantAgentId: "work", sessionKey: "global" }),
        captureChatOutboxAdmission(
          createState({ assistantAgentId: "work", sessionKey: "global" }),
          "global",
          workItem.agentId,
        ),
        workItem,
      ),
    ).toBe(true);
    expect(
      admitStoredChatComposerQueueItem(
        createState({ assistantAgentId: "other", sessionKey: "global" }),
        captureChatOutboxAdmission(
          createState({ assistantAgentId: "other", sessionKey: "global" }),
          "global",
          otherItem.agentId,
        ),
        otherItem,
      ),
    ).toBe(true);

    expect(loadChatComposerSnapshot(createState({ sessionKey: "main" }), "main")).toBeNull();
  });

  it("counts a cleared agent draft when deciding whether an offline main owner is unique", () => {
    const staleAlpha = createState({
      assistantAgentId: "alpha",
      chatMessage: "stale alpha draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(staleAlpha)).toBe(true);
    const clearedWork = createState({
      assistantAgentId: "work",
      chatMessage: "work draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(clearedWork)).toBe(true);
    expect(persistChatComposerState({ ...clearedWork, chatMessage: "" })).toBe(true);

    expect(loadChatComposerSnapshot(createState({ sessionKey: "main" }), "main")).toBeNull();
  });

  it("keeps readable migrated composer state when the migration write fails", () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const unresolved = createState({
      chatMessage: "unresolved draft",
      sessionKey: "main",
    });
    const item = reconnectItem("unresolved-with-quota", 1);
    expect(persistChatComposerState(unresolved)).toBe(true);
    const admission = captureChatOutboxAdmission(unresolved, "main", item.agentId);
    expect(admitStoredChatComposerQueueItem(unresolved, admission, item)).toBe(true);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    const resolved = createState({
      agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
      assistantAgentId: "work",
      sessionKey: "global",
    });
    expect(loadChatComposerSnapshot(resolved, "global")).toEqual({
      draft: "unresolved draft",
      queue: [{ ...item, agentId: "work", sessionKey: "global" }],
    });
  });

  it("shares configured bare and agent main aliases with global", () => {
    const state = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      sessionKey: "workspace",
    });
    const bare = reconnectItem("bare-configured", 1);
    const qualified = reconnectItem("qualified-configured", 2);
    const bareAdmission = captureChatOutboxAdmission(state, "workspace", bare.agentId);
    expect(admitStoredChatComposerQueueItem(state, bareAdmission, bare)).toBe(true);
    const qualifiedAdmission = captureChatOutboxAdmission(
      state,
      "agent:work:workspace",
      qualified.agentId,
    );
    expect(admitStoredChatComposerQueueItem(state, qualifiedAdmission, qualified)).toBe(true);

    expect(loadChatComposerSnapshot(state, "global")?.queue.map((item) => item.id)).toEqual([
      "bare-configured",
      "qualified-configured",
    ]);
  });

  it("migrates shipped alias rows and consumes legacy tombstones", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:work:main\u0000agent:work": {
            draft: "legacy draft",
            queue: [
              reconnectItem("removed", 1),
              { ...reconnectItem("kept", 2), sessionKey: "agent:work:main", agentId: "work" },
            ],
            removedQueueItemIds: ["removed"],
            updatedAt: 1,
          },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "agent:work:main" });
    expect(loadChatComposerSnapshot(state, "agent:work:main")).toEqual({
      draft: "legacy draft",
      queue: [
        {
          ...reconnectItem("kept", 2),
          sessionKey: "agent:work:main",
          agentId: "work",
        },
      ],
    });
    state.chatMessage = "updated draft";
    persistChatComposerState(state);
    expect(sessionStorage.getItem(storageKey)).not.toContain("removedQueueItemIds");
    expect(sessionStorage.getItem(legacyStorageKey)).toBeNull();
  });

  it("lists inactive outboxes for explicit reconnect routing", () => {
    const state = createState();
    const older = reconnectItem("inactive-a", 1);
    const newer = reconnectItem("inactive-b", 2);
    const olderAdmission = captureChatOutboxAdmission(state, "agent:alpha:thread:1", older.agentId);
    expect(admitStoredChatComposerQueueItem(state, olderAdmission, older)).toBe(true);
    const newerAdmission = captureChatOutboxAdmission(state, "agent:beta:thread:2", newer.agentId);
    expect(admitStoredChatComposerQueueItem(state, newerAdmission, newer)).toBe(true);

    expect(listStoredChatOutboxes(state)).toEqual([
      {
        sessionKey: "agent:alpha:thread:1",
        agentId: "alpha",
        queue: [
          {
            ...older,
            sessionKey: "agent:alpha:thread:1",
            agentId: "alpha",
          },
        ],
      },
      {
        sessionKey: "agent:beta:thread:2",
        agentId: "beta",
        queue: [
          {
            ...newer,
            sessionKey: "agent:beta:thread:2",
            agentId: "beta",
          },
        ],
      },
    ]);
  });

  it("normalizes interrupted and in-flight states before durable replay", () => {
    const state = createState();
    const sending: ChatQueueItem = {
      ...reconnectItem("sending", 1),
      sendState: "sending",
    };
    const waitingModel: ChatQueueItem = {
      ...reconnectItem("waiting-model", 2),
      sendState: "waiting-model",
      sendError: "previous attempt failed",
    };
    const executingCommand: ChatQueueItem = {
      ...reconnectItem("executing-command", 3),
      sendState: "executing-command",
    };
    const sendingAdmission = captureChatOutboxAdmission(state, state.sessionKey, sending.agentId);
    expect(admitStoredChatComposerQueueItem(state, sendingAdmission, sending)).toBe(true);
    const waitingModelAdmission = captureChatOutboxAdmission(
      state,
      state.sessionKey,
      waitingModel.agentId,
    );
    expect(admitStoredChatComposerQueueItem(state, waitingModelAdmission, waitingModel)).toBe(true);
    const executingCommandAdmission = captureChatOutboxAdmission(
      state,
      state.sessionKey,
      executingCommand.agentId,
    );
    expect(
      admitStoredChatComposerQueueItem(state, executingCommandAdmission, executingCommand),
    ).toBe(true);

    expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue).toEqual([
      { ...sending, sendState: "waiting-reconnect", sessionKey: state.sessionKey, agentId: "lily" },
      {
        ...waitingModel,
        sendState: "failed",
        sendError: "Chat settings update was interrupted. Review and retry when ready.",
        sessionKey: state.sessionKey,
        agentId: "lily",
      },
      {
        ...executingCommand,
        sendState: "unconfirmed",
        sessionKey: state.sessionKey,
        agentId: "lily",
      },
    ]);
  });

  it("scopes composer state and outboxes by gateway", () => {
    const state = createState({ chatMessage: "gateway-local draft" });
    persistChatComposerState(state);
    admitStoredChatComposerQueueItem(
      state,
      captureChatOutboxAdmission(state, state.sessionKey),
      reconnectItem("gateway-local", 1),
    );
    const otherGateway = createState({
      settings: { gatewayUrl: "ws://other-gateway.test/control" },
    });

    expect(loadChatComposerSnapshot(otherGateway, otherGateway.sessionKey)).toBeNull();
    expect(listStoredChatOutboxes(otherGateway)).toEqual([]);
  });

  it("isolates long same-prefix gateways in owner-tagged v4 buckets", () => {
    const sharedPrefix = `wss://gateway.test/${"a".repeat(260)}`;
    const firstGatewayUrl = `${sharedPrefix}?route=first`;
    const secondGatewayUrl = `${sharedPrefix}?route=second`;
    expect(legacyStorageKeyForGateway(firstGatewayUrl)).toBe(
      legacyStorageKeyForGateway(secondGatewayUrl),
    );
    expect(storageKeyForGateway(firstGatewayUrl)).not.toBe(storageKeyForGateway(secondGatewayUrl));

    const first = createState({
      chatMessage: "first gateway draft",
      settings: { gatewayUrl: firstGatewayUrl },
    });
    const second = createState({
      chatMessage: "second gateway draft",
      settings: { gatewayUrl: secondGatewayUrl },
    });
    const firstItem = reconnectItem("first-long-gateway", 1);
    const secondItem = reconnectItem("second-long-gateway", 2);
    expect(persistChatComposerState(first)).toBe(true);
    const firstAdmission = captureChatOutboxAdmission(first, first.sessionKey, firstItem.agentId);
    expect(admitStoredChatComposerQueueItem(first, firstAdmission, firstItem)).toBe(true);
    expect(persistChatComposerState(second)).toBe(true);
    const secondAdmission = captureChatOutboxAdmission(
      second,
      second.sessionKey,
      secondItem.agentId,
    );
    expect(admitStoredChatComposerQueueItem(second, secondAdmission, secondItem)).toBe(true);

    expect(loadChatComposerSnapshot(first, first.sessionKey)).toEqual({
      draft: "first gateway draft",
      queue: [{ ...firstItem, agentId: "lily", sessionKey: first.sessionKey }],
    });
    expect(loadChatComposerSnapshot(second, second.sessionKey)).toEqual({
      draft: "second gateway draft",
      queue: [{ ...secondItem, agentId: "lily", sessionKey: second.sessionKey }],
    });
    for (const gatewayUrl of [firstGatewayUrl, secondGatewayUrl]) {
      const stored = JSON.parse(sessionStorage.getItem(storageKeyForGateway(gatewayUrl)) ?? "{}");
      expect(stored).toMatchObject({ gatewayOwner: gatewayUrl, version: 4 });
    }
  });

  it("does not replay an exact-240 legacy key to a longer same-prefix gateway", () => {
    const prefix = "wss://gateway.test/";
    const exactGatewayUrl = `${prefix}${"a".repeat(240 - encodeURIComponent(prefix).length)}`;
    const longerGatewayUrl = `${exactGatewayUrl}b`;
    expect(encodeURIComponent(exactGatewayUrl)).toHaveLength(240);
    expect(legacyStorageKeyForGateway(exactGatewayUrl)).toBe(
      legacyStorageKeyForGateway(longerGatewayUrl),
    );
    const item = reconnectItem("ambiguous-legacy-owner", 1);
    sessionStorage.setItem(
      legacyStorageKeyForGateway(exactGatewayUrl),
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:lily:main\u0000agent:lily": { queue: [item], updatedAt: 1 },
        },
      }),
    );

    for (const gatewayUrl of [exactGatewayUrl, longerGatewayUrl]) {
      const state = createState({ settings: { gatewayUrl } });
      expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
      expect(listStoredChatOutboxes(state)).toEqual([]);
      expect(sessionStorage.getItem(storageKeyForGateway(gatewayUrl))).toBeNull();
    }
  });

  it("migrates an unambiguous shipped v1 bucket into owner-tagged v4", () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    const item = reconnectItem("legacy-short-gateway", 1);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:lily:main\u0000agent:lily": {
            draft: "shipped gateway draft",
            queue: [item],
            updatedAt: 1,
          },
        },
      }),
    );
    const state = createState({ settings: { gatewayUrl } });

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "shipped gateway draft",
      queue: [{ ...item, agentId: "lily", sessionKey: state.sessionKey }],
    });
    expect(sessionStorage.getItem(legacyStorageKey)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "{}")).toMatchObject({
      gatewayOwner: gatewayUrl,
      version: 4,
      recovery: {},
    });
  });

  it("evicts draft-only sessions before rejecting an outbox session overflow", () => {
    for (let index = 0; index < 19; index += 1) {
      const sessionKey = `agent:lily:queued:${index}`;
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey),
          reconnectItem(`queued-${index}`, index),
        ),
      ).toBe(true);
    }
    const draftSessionKey = "agent:lily:draft-only";
    expect(
      persistChatComposerState(
        createState({ chatMessage: "evict this draft first", sessionKey: draftSessionKey }),
      ),
    ).toBe(true);

    const twentiethSessionKey = "agent:lily:queued:19";
    expect(
      admitStoredChatComposerQueueItem(
        createState({ sessionKey: twentiethSessionKey }),
        captureChatOutboxAdmission(
          createState({ sessionKey: twentiethSessionKey }),
          twentiethSessionKey,
        ),
        reconnectItem("queued-19", 19),
      ),
    ).toBe(true);
    expect(loadChatComposerSnapshot(createState(), draftSessionKey)).toBeNull();
    expect(listStoredChatOutboxes(createState())).toHaveLength(20);

    const rejectedDraft = createState({ sessionKey: "agent:lily:rejected-draft" });
    const rejectedPersistence = new ChatComposerPersistence(() => rejectedDraft);
    rejectedPersistence.start();
    rejectedDraft.chatMessage = "keep retrying this draft";
    rejectedPersistence.schedule();
    expect(rejectedPersistence.persistForRouteSwitchResult()).toMatchObject({
      status: "storage-failed",
      expectedDraftRevision: 0,
    });
    expect(loadChatComposerSnapshot(rejectedDraft, rejectedDraft.sessionKey)).toBeNull();

    const overflowSessionKey = "agent:lily:queued:20";
    expect(
      admitStoredChatComposerQueueItem(
        createState({ sessionKey: overflowSessionKey }),
        captureChatOutboxAdmission(
          createState({ sessionKey: overflowSessionKey }),
          overflowSessionKey,
        ),
        reconnectItem("queued-20", 20),
      ),
    ).toBe(false);
    const outboxes = listStoredChatOutboxes(createState());
    expect(outboxes).toHaveLength(20);
    expect(outboxes.some((outbox) => outbox.sessionKey === overflowSessionKey)).toBe(false);
    expect(outboxes.some((outbox) => outbox.sessionKey === "agent:lily:queued:0")).toBe(true);
  });

  it("retains an unresolved global clear fence at the full outbox cap", () => {
    const resolved = createState({
      assistantAgentId: "work",
      chatMessage: "stale resolved draft",
      sessionKey: "global",
    });
    const queued = reconnectItem("resolved-work-queue", 1);
    expect(persistChatComposerState(resolved)).toBe(true);
    const queuedAdmission = captureChatOutboxAdmission(
      resolved,
      resolved.sessionKey,
      queued.agentId,
    );
    expect(admitStoredChatComposerQueueItem(resolved, queuedAdmission, queued)).toBe(true);

    const offline = createState({ sessionKey: "main", chatMessage: "stale resolved draft" });
    expect(persistChatComposerState(offline)).toBe(true);
    expect(restoreChatComposerState(offline)).toBe(true);
    expect(offline.chatMessage).toBe("stale resolved draft");
    const persistence = new ChatComposerPersistence(() => offline);
    persistence.start();
    offline.chatMessage = "";
    persistence.schedule();
    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

    for (let index = 0; index < 21; index += 1) {
      const sessionKey = `agent:draft-${index}:thread`;
      expect(
        persistChatComposerState(
          createState({ chatMessage: `newer ordinary draft ${index}`, sessionKey }),
        ),
      ).toBe(true);
    }

    for (let index = 0; index < 19; index += 1) {
      const sessionKey = `agent:capacity-${index}:thread`;
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey),
          reconnectItem(`clear-fence-capacity-${index}`, index + 2),
        ),
      ).toBe(true);
    }
    expect(listStoredChatOutboxes(offline)).toHaveLength(20);

    const gatewayUrl = offline.settings?.gatewayUrl;
    const storageKey = storageKeyForGateway(gatewayUrl);
    const stored = sessionStorage.getItem(storageKey);
    expect(stored).not.toBeNull();
    const freshStorage = createStorageMock();
    freshStorage.setItem(storageKey, stored!);
    vi.stubGlobal("sessionStorage", freshStorage);

    expect(loadChatComposerSnapshot(createState({ sessionKey: "main" }), "main")).toBeNull();
    const reconnected = createState({
      agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
      assistantAgentId: "work",
      sessionKey: "global",
    });
    expect(loadChatComposerSnapshot(reconnected, "global")).toEqual({
      draft: "",
      queue: [{ ...queued, agentId: "work", sessionKey: "global" }],
    });
    expect(listStoredChatOutboxes(reconnected)).toHaveLength(20);
  });

  it("retains an unchanged live draft after outbox capacity evicts its stored row", () => {
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "keep this live draft";
    persistence.schedule();
    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

    for (let index = 0; index < 20; index += 1) {
      const sessionKey = `agent:lily:capacity:${index}`;
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey),
          reconnectItem(`capacity-${index}`, index),
        ),
      ).toBe(true);
    }

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
    expect(persistence.persistForRouteSwitchResult()).toMatchObject({
      status: "storage-failed",
    });
    expect(state.chatMessage).toBe("keep this live draft");
  });

  it("restores an evicted live draft into a same-scope queue-only row", () => {
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "merge this live draft";
    persistence.schedule();
    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

    for (let index = 0; index < 20; index += 1) {
      const sessionKey = `agent:lily:queue-only:${index}`;
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey),
          reconnectItem(`queue-only-${index}`, index),
        ),
      ).toBe(true);
    }
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();

    const releasedSessionKey = "agent:lily:queue-only:0";
    const released = reconnectItem("queue-only-0", 0);
    expect(
      removeStoredChatComposerQueueItem(
        createState({ sessionKey: releasedSessionKey }),
        releasedSessionKey,
        released.id,
        released,
      ),
    ).toBe(true);
    const sameScope = reconnectItem("same-scope-queue", 21);
    const sameScopeAdmission = captureChatOutboxAdmission(
      state,
      state.sessionKey,
      sameScope.agentId,
    );
    expect(admitStoredChatComposerQueueItem(state, sameScopeAdmission, sameScope)).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "",
      queue: [{ ...sameScope, sessionKey: state.sessionKey, agentId: "lily" }],
    });

    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "merge this live draft",
      queue: [{ ...sameScope, sessionKey: state.sessionKey, agentId: "lily" }],
    });
  });

  it("lets only the newest failed split-pane draft retry after capacity recovers", () => {
    const baseline = createState({ chatMessage: "saved draft" });
    expect(persistChatComposerState(baseline)).toBe(true);
    const baselineRevision = loadChatComposerDraftRevision(baseline, baseline.sessionKey);
    const olderPane = createState({ chatMessage: baseline.chatMessage });
    const olderPersistence = new ChatComposerPersistence(() => olderPane);
    olderPersistence.start();

    const outboxes = Array.from({ length: 20 }, (_, index) => {
      const sessionKey = `agent:lily:failed-fence:${index}`;
      const item = reconnectItem(`failed-fence-${index}`, index);
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey, item.agentId),
          item,
        ),
      ).toBe(true);
      return { item, sessionKey };
    });
    expect(loadChatComposerSnapshot(baseline, baseline.sessionKey)).toBeNull();

    olderPane.chatMessage = "older failed draft";
    olderPersistence.schedule();
    const olderResult = olderPersistence.persistForRouteSwitchResult();

    // A pane mounted after the failed attempt must issue after it without
    // treating that uncommitted attempt as the persisted CAS baseline.
    const newerPane = createState({ chatMessage: baseline.chatMessage });
    const newerPersistence = new ChatComposerPersistence(() => newerPane);
    newerPersistence.start();
    newerPane.chatMessage = "newer late-pane draft";
    newerPersistence.schedule();
    const newerResult = newerPersistence.persistForRouteSwitchResult();
    expect(olderResult).toMatchObject({
      status: "storage-failed",
      expectedDraftRevision: baselineRevision,
    });
    expect(newerResult).toMatchObject({
      status: "storage-failed",
      expectedDraftRevision: baselineRevision,
    });
    if (olderResult.status !== "storage-failed" || newerResult.status !== "storage-failed") {
      throw new Error("Expected retryable storage failures");
    }
    expect(olderResult.draftRevision).toBeLessThan(newerResult.draftRevision);

    const released = outboxes[0];
    expect(released).toBeDefined();
    expect(
      removeStoredChatComposerQueueItem(
        createState({ sessionKey: released!.sessionKey }),
        released!.sessionKey,
        released!.item.id,
        released!.item,
      ),
    ).toBe(true);
    expect(
      persistChatComposerState(olderPane, olderPane.sessionKey, {
        draft: olderPane.chatMessage,
        expectedDraftRevision: olderResult.expectedDraftRevision,
        draftRevision: olderResult.draftRevision,
      }),
    ).toBe(false);
    expect(
      persistChatComposerState(newerPane, newerPane.sessionKey, {
        draft: newerPane.chatMessage,
        expectedDraftRevision: newerResult.expectedDraftRevision,
        draftRevision: newerResult.draftRevision,
      }),
    ).toBe(true);
    expect(loadChatComposerSnapshot(newerPane, newerPane.sessionKey)).toEqual({
      draft: "newer late-pane draft",
      queue: [],
    });
    expect(loadChatComposerDraftRevision(newerPane, newerPane.sessionKey)).toBe(
      newerResult.draftRevision,
    );
  });

  it("does not let an untouched evicted pane fence out a newer failed edit", () => {
    const baseline = createState({ chatMessage: "saved draft" });
    expect(persistChatComposerState(baseline)).toBe(true);
    const baselineRevision = loadChatComposerDraftRevision(baseline, baseline.sessionKey);
    const stalePane = createState({ chatMessage: baseline.chatMessage });
    const stalePersistence = new ChatComposerPersistence(() => stalePane);
    stalePersistence.start();
    const newerPane = createState({ chatMessage: baseline.chatMessage });
    const newerPersistence = new ChatComposerPersistence(() => newerPane);
    newerPersistence.start();

    const outboxes = Array.from({ length: 20 }, (_, index) => {
      const sessionKey = `agent:lily:stale-fence:${index}`;
      const item = reconnectItem(`stale-fence-${index}`, index);
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey, item.agentId),
          item,
        ),
      ).toBe(true);
      return { item, sessionKey };
    });
    expect(loadChatComposerSnapshot(baseline, baseline.sessionKey)).toBeNull();

    newerPane.chatMessage = "newer failed draft";
    newerPersistence.schedule();
    const newerResult = newerPersistence.persistForRouteSwitchResult();
    expect(newerResult).toMatchObject({
      status: "storage-failed",
      expectedDraftRevision: baselineRevision,
    });
    if (newerResult.status !== "storage-failed") {
      throw new Error("Expected a retryable storage failure");
    }

    expect(stalePersistence.persistForRouteSwitchResult()).toEqual({ status: "conflict" });
    expect(loadChatComposerDraftRevision(stalePane, stalePane.sessionKey)).toBe(
      newerResult.draftRevision,
    );

    const released = outboxes[0];
    expect(released).toBeDefined();
    expect(
      removeStoredChatComposerQueueItem(
        createState({ sessionKey: released!.sessionKey }),
        released!.sessionKey,
        released!.item.id,
        released!.item,
      ),
    ).toBe(true);
    expect(
      persistChatComposerState(newerPane, newerPane.sessionKey, {
        draft: newerPane.chatMessage,
        expectedDraftRevision: newerResult.expectedDraftRevision,
        draftRevision: newerResult.draftRevision,
      }),
    ).toBe(true);
    expect(loadChatComposerSnapshot(newerPane, newerPane.sessionKey)).toEqual({
      draft: "newer failed draft",
      queue: [],
    });
  });

  it("persists a revert after an intermediate draft attempt fails", () => {
    const state = createState({ chatMessage: "saved draft" });
    expect(persistChatComposerState(state)).toBe(true);
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();

    const outboxes = Array.from({ length: 20 }, (_, index) => {
      const sessionKey = `agent:lily:failed-revert:${index}`;
      const item = reconnectItem(`failed-revert-${index}`, index);
      expect(
        admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey, item.agentId),
          item,
        ),
      ).toBe(true);
      return { item, sessionKey };
    });
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();

    state.chatMessage = "intermediate edit";
    persistence.schedule();
    const failed = persistence.persistForRouteSwitchResult();
    expect(failed).toMatchObject({ status: "storage-failed" });
    if (failed.status !== "storage-failed") {
      throw new Error("Expected a retryable storage failure");
    }

    state.chatMessage = "saved draft";
    persistence.schedule();
    persistence.schedule();
    const released = outboxes[0];
    expect(released).toBeDefined();
    expect(
      removeStoredChatComposerQueueItem(
        createState({ sessionKey: released!.sessionKey }),
        released!.sessionKey,
        released!.item.id,
        released!.item,
      ),
    ).toBe(true);

    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "saved draft",
      queue: [],
    });
    expect(loadChatComposerDraftRevision(state, state.sessionKey)).toBeGreaterThan(
      failed.draftRevision,
    );
  });

  it("keeps readable outboxes available when later storage writes fail", () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const state = createState();
    const item = reconnectItem("readable-after-quota", 1);
    const admission = captureChatOutboxAdmission(state, state.sessionKey, item.agentId);
    expect(admitStoredChatComposerQueueItem(state, admission, item)).toBe(true);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    expect(listStoredChatOutboxes(state)).toEqual([
      {
        sessionKey: "agent:lily:main",
        agentId: "lily",
        queue: [{ ...item, sessionKey: "agent:lily:main", agentId: "lily" }],
      },
    ]);
  });

  it("retries a failed draft write when stopping", () => {
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    let writes = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "retry this write";

    persistence.persistNow();
    persistence.stop();

    expect(writes).toBe(2);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("retry this write");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
