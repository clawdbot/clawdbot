// @vitest-environment node
import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  loadChatHistory,
  rewindChatHistory,
  syncSelectedSessionMessageSubscription,
  switchChatHistoryBranch,
  type ChatHistoryResult,
  type ChatState,
} from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { getChatSessionProjection, setChatSessionProjection } from "./history-merge.ts";
import {
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { handleAgentEvent, type ToolStreamEntry } from "./tool-stream.ts";

type TestState = ChatState &
  Parameters<typeof handleAgentEvent>[0] & {
    requestUpdate: () => void;
  };
type TestSessions = NonNullable<ChatState["sessions"]> &
  Parameters<typeof handleAgentEvent>[0]["sessions"];

function createState(result: ChatHistoryResult): TestState {
  const host = makeChatHost({
    requestHandlers: { "chat.history": result },
    sessionKey: "main",
  });
  const sessions: TestSessions = { refreshReplacement: vi.fn(async () => undefined) };
  return {
    ...host,
    chatToolMessages: host.chatToolMessages ?? [],
    chatStreamSegments: host.chatStreamSegments ?? [],
    connectionEpoch: 1,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatStreamStartedAt: null,
    sessions,
    toolStreamById: host.toolStreamById ?? new Map<string, ToolStreamEntry>(),
    toolStreamOrder: host.toolStreamOrder ?? [],
    toolStreamSyncTimer: host.toolStreamSyncTimer ?? null,
    requestUpdate: vi.fn(),
  };
}

function activeHistory(runId: string): ChatHistoryResult {
  return {
    messages: [],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    },
    inFlightRun: {
      runId,
      text: "intentionally ignored on web",
    },
  } satisfies ChatHistoryResult;
}

describe("syncSelectedSessionMessageSubscription", () => {
  it("starts the new subscription before the previous unsubscribe settles", async () => {
    let resolveUnsubscribe: () => void = () => undefined;
    const unsubscribeMessages = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnsubscribe = resolve;
        }),
    );
    const subscribeMessages = vi.fn(async (key: string) => ({ key, agentId: null }));
    const state = createState({ messages: [] }) as TestState & {
      chatSessionMessageSubscriptionRequestedKey: string;
      chatSessionMessageSubscription: { key: string; agentId: null } | null;
      sessions: {
        subscribeMessages: typeof subscribeMessages;
        unsubscribeMessages: typeof unsubscribeMessages;
      };
    };
    state.sessionKey = "agent:main:next";
    state.chatSessionMessageSubscriptionRequestedKey = "agent:main:previous";
    state.chatSessionMessageSubscription = { key: "agent:main:previous", agentId: null };
    state.sessions = {
      refreshReplacement: vi.fn(async () => undefined),
      subscribeMessages,
      unsubscribeMessages,
    };

    const sync = syncSelectedSessionMessageSubscription(state as never);
    await Promise.resolve();

    expect(unsubscribeMessages).toHaveBeenCalledOnce();
    expect(subscribeMessages).toHaveBeenCalledWith("agent:main:next", { agentId: undefined });
    expect(state.chatSessionMessageSubscription).toEqual({
      key: "agent:main:previous",
      agentId: null,
    });

    resolveUnsubscribe();
    await sync;
    expect(state.chatSessionMessageSubscription).toEqual({
      key: "agent:main:next",
      agentId: null,
    });
  });

  it("retains the previous subscription when its release fails", async () => {
    const previous = { key: "agent:main:previous", agentId: null };
    const subscribed = { key: "agent:main:next", agentId: null };
    const unsubscribeMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error("release failed"))
      .mockResolvedValueOnce(undefined);
    const subscribeMessages = vi.fn(async () => subscribed);
    const state = createState({ messages: [] }) as TestState & {
      chatSessionMessageSubscriptionRequestedKey: string;
      chatSessionMessageSubscription: typeof previous | null;
      sessionsError: string | null;
    };
    state.sessionKey = subscribed.key;
    state.chatSessionMessageSubscriptionRequestedKey = previous.key;
    state.chatSessionMessageSubscription = previous;
    state.sessionsError = null;
    state.sessions = {
      refreshReplacement: vi.fn(async () => undefined),
      subscribeMessages,
      unsubscribeMessages,
    };

    await syncSelectedSessionMessageSubscription(state as never);

    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe(previous.key);
    expect(state.chatSessionMessageSubscription).toBe(previous);
    expect(state.sessionsError).toContain("release failed");
    expect(unsubscribeMessages).toHaveBeenNthCalledWith(1, previous);
    expect(unsubscribeMessages).toHaveBeenNthCalledWith(2, subscribed);
  });

  it("retains the new subscription when both release attempts fail", async () => {
    const previous = { key: "agent:main:previous", agentId: null };
    const subscribed = { key: "agent:main:next", agentId: null };
    const unsubscribeMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error("previous release failed"))
      .mockRejectedValueOnce(new Error("replacement release failed"))
      .mockResolvedValueOnce(undefined);
    const subscribeMessages = vi.fn(async () => subscribed);
    const state = createState({ messages: [] }) as TestState & {
      chatSessionMessageSubscriptionRequestedKey: string;
      chatSessionMessageSubscription: typeof previous | null;
      sessionsError: string | null;
    };
    state.sessionKey = subscribed.key;
    state.chatSessionMessageSubscriptionRequestedKey = previous.key;
    state.chatSessionMessageSubscription = previous;
    state.sessionsError = null;
    state.sessions = {
      refreshReplacement: vi.fn(async () => undefined),
      subscribeMessages,
      unsubscribeMessages,
    };

    await syncSelectedSessionMessageSubscription(state as never);

    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe(subscribed.key);
    expect(state.chatSessionMessageSubscription).toBe(subscribed);
    expect(state.sessionsError).toContain("previous release failed");
    expect(state.sessionsError).toContain("replacement release failed");

    await syncSelectedSessionMessageSubscription(state as never);
    expect(unsubscribeMessages).toHaveBeenNthCalledWith(3, previous);
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe(subscribed.key);
    expect(state.chatSessionMessageSubscription).toBe(subscribed);
  });

  it("retries a stale generation's rejected subscription release", async () => {
    const stale = { key: "agent:main:stale", agentId: null };
    const selected = { key: "agent:main:selected", agentId: null };
    let resolveStale: (subscription: typeof stale) => void = () => undefined;
    const staleSubscription = new Promise<typeof stale>((resolve) => {
      resolveStale = resolve;
    });
    const unsubscribeMessages = vi
      .fn()
      .mockRejectedValueOnce(new Error("stale release temporarily failed"))
      .mockResolvedValueOnce(undefined);
    const subscribeMessages = vi.fn(async (key: string) =>
      key === stale.key ? await staleSubscription : selected,
    );
    const state = createState({ messages: [] }) as TestState & {
      chatSessionMessageSubscriptionRequestedKey: string | null;
      chatSessionMessageSubscription: typeof stale | null;
    };
    state.sessionKey = stale.key;
    state.chatSessionMessageSubscriptionRequestedKey = null;
    state.chatSessionMessageSubscription = null;
    state.sessions = {
      refreshReplacement: vi.fn(async () => undefined),
      subscribeMessages,
      unsubscribeMessages,
    };

    const staleSync = syncSelectedSessionMessageSubscription(state as never);
    await Promise.resolve();
    state.sessionKey = selected.key;
    await syncSelectedSessionMessageSubscription(state as never);

    resolveStale(stale);
    await staleSync;

    expect(state.chatSessionMessageSubscription).toBe(selected);
    expect(unsubscribeMessages).toHaveBeenNthCalledWith(1, stale);

    await syncSelectedSessionMessageSubscription(state as never);

    expect(unsubscribeMessages).toHaveBeenNthCalledWith(2, stale);
    expect(state.chatSessionMessageSubscription).toBe(selected);
    expect(subscribeMessages).toHaveBeenCalledTimes(2);
  });
});

describe("rewindChatHistory", () => {
  it("clears the cached snapshot, refetches, and returns the composer text", async () => {
    const state = createState({
      messages: [{ role: "assistant", content: "kept prefix" }],
    }) as TestState & {
      chatMessagesBySession: ChatMessageCache;
      handleChatDraftChange: ReturnType<typeof vi.fn>;
      sessions: { rewind: ReturnType<typeof vi.fn> };
    };
    state.sessionKey = "agent:main:rewind";
    state.chatMessages = [{ role: "assistant", content: "stale tail" }];
    state.chatMessagesBySession = new Map();
    state.handleChatDraftChange = vi.fn((next: string) => {
      state.chatMessage = next;
    });
    state.chatAttachments = [{ id: "old", mimeType: "image/jpeg", dataUrl: "data:old" }];
    state.sessions = {
      rewind: vi.fn().mockResolvedValue({
        editorText: "edit this",
        editorAttachments: [
          { mimeType: "image/png", data: "aW1hZ2U=" },
          { mimeType: "application/pdf", data: "aW1hZ2U=" },
          { mimeType: "image/png", data: "not base64!!" },
          { mimeType: "image/png", data: "A" },
        ],
      }),
      refreshReplacement: vi.fn(async () => undefined),
    };
    cacheChatSessionSnapshot(
      state.chatMessagesBySession,
      state,
      { sessionKey: state.sessionKey },
      {
        messages: state.chatMessages,
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "old-session",
      },
    );

    const result = await rewindChatHistory(state as never, "user-entry");

    expect(state.sessions.rewind).toHaveBeenCalledWith(
      state.sessionKey,
      "user-entry",
      expect.any(Object),
    );
    expect(result).toEqual({
      editorText: "edit this",
      editorAttachments: [
        { mimeType: "image/png", data: "aW1hZ2U=" },
        { mimeType: "application/pdf", data: "aW1hZ2U=" },
        { mimeType: "image/png", data: "not base64!!" },
        { mimeType: "image/png", data: "A" },
      ],
    });
    expect(state.chatMessage).toBe("edit this");
    expect(state.chatAttachments).toEqual([
      {
        id: expect.stringMatching(/^att-/),
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
    ]);
    expect(state.chatAttachments[0]?.id).not.toBe("old");
    expect(state.chatMessages).toEqual([{ role: "assistant", content: "kept prefix" }]);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession, state, {
        sessionKey: state.sessionKey,
      }),
    ).toEqual([{ role: "assistant", content: "kept prefix" }]);
  });

  it("invalidates the source cache without overwriting a newly selected draft", async () => {
    const sourceSessionKey = "agent:main:rewind-source";
    const state = createState({
      messages: [{ role: "assistant", content: "source prefix" }],
    }) as TestState & {
      chatMessagesBySession: ChatMessageCache;
      handleChatDraftChange: ReturnType<typeof vi.fn>;
      sessions: { rewind: ReturnType<typeof vi.fn> };
    };
    state.sessionKey = sourceSessionKey;
    state.chatMessagesBySession = new Map();
    state.handleChatDraftChange = vi.fn();
    state.sessions = {
      rewind: vi.fn().mockImplementation(async () => {
        state.sessionKey = "agent:main:new-selection";
        return { editorText: "source draft" };
      }),
      refreshReplacement: vi.fn(async () => undefined),
    };
    cacheChatSessionSnapshot(
      state.chatMessagesBySession,
      state,
      { sessionKey: sourceSessionKey },
      {
        messages: [{ role: "assistant", content: "stale source tail" }],
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "old-source-session",
      },
    );

    const result = await rewindChatHistory(state as never, "user-entry");

    expect(
      readChatMessagesFromCache(state.chatMessagesBySession, state, {
        sessionKey: sourceSessionKey,
      }),
    ).toEqual([]);
    expect(result).toBeNull();
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
  });

  it("reconciles committed rewind history without overwriting a replacement draft", async () => {
    let resolveRewind!: (result: { editorText?: string }) => void;
    const rewind = new Promise<{ editorText?: string }>((resolve) => {
      resolveRewind = resolve;
    });
    const canonical = { role: "assistant", content: "canonical history after rewind" };
    const state = createState({ messages: [canonical] }) as TestState & {
      handleChatDraftChange: ReturnType<typeof vi.fn>;
      sessions: { rewind: ReturnType<typeof vi.fn> };
    };
    state.chatMessages = [{ role: "assistant", content: "stale replacement history" }];
    state.handleChatDraftChange = vi.fn((next: string) => {
      state.chatMessage = next;
    });
    state.sessions = {
      rewind: vi.fn(() => rewind),
      refreshReplacement: vi.fn(async () => undefined),
    };

    const pending = rewindChatHistory(state as never, "user-entry");
    state.connected = false;
    state.connectionEpoch += 1;
    state.connected = true;
    state.connectionEpoch += 1;
    state.chatMessage = "new connection draft";
    state.chatAttachments = [
      { id: "new", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,bmV3" },
    ];
    resolveRewind({ editorText: "stale rewind draft" });

    const result = await pending;
    expect(state.chatMessage).toBe("new connection draft");
    expect(state.chatAttachments).toEqual([
      { id: "new", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,bmV3" },
    ]);
    expect(state.chatMessages).toEqual([canonical]);
    expect(state.handleChatDraftChange).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe("switchChatHistoryBranch", () => {
  it("clears the cached snapshot and refetches history plus branches", async () => {
    const state = createState({
      messages: [{ role: "assistant", content: "restored branch" }],
    }) as TestState & {
      chatMessagesBySession: ChatMessageCache;
      sessions: {
        listBranches: ReturnType<typeof vi.fn>;
        switchBranch: ReturnType<typeof vi.fn>;
      };
    };
    state.sessionKey = "agent:main:branches";
    state.chatMessages = [{ role: "assistant", content: "stale branch" }];
    state.chatMessagesBySession = new Map();
    state.sessions = {
      listBranches: vi.fn().mockResolvedValue([
        {
          leafEntryId: "branch-b",
          headline: "restored branch",
          messageCount: 2,
          active: true,
        },
      ]),
      switchBranch: vi.fn().mockResolvedValue({}),
      refreshReplacement: vi.fn(async () => undefined),
    };
    cacheChatSessionSnapshot(
      state.chatMessagesBySession,
      state,
      { sessionKey: state.sessionKey },
      {
        messages: state.chatMessages,
        pagination: { hasMore: false, completeSnapshot: true },
        sessionId: "old-session",
      },
    );

    await expect(switchChatHistoryBranch(state as never, "branch-b")).resolves.toBe(true);

    expect(state.sessions.switchBranch).toHaveBeenCalledWith(
      state.sessionKey,
      "branch-b",
      expect.any(Object),
    );
    expect(state.sessions.listBranches).toHaveBeenCalledWith(state.sessionKey, expect.any(Object));
    expect(state.chatMessages).toEqual([{ role: "assistant", content: "restored branch" }]);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession, state, {
        sessionKey: state.sessionKey,
      }),
    ).toEqual([{ role: "assistant", content: "restored branch" }]);
  });

  it("refreshes branch metadata after the Gateway connection changes", async () => {
    const state = createState({ messages: [] }) as TestState & {
      sessions: { listBranches: ReturnType<typeof vi.fn> };
    };
    state.chatBranchesSessionKey = state.sessionKey;
    state.chatBranchesConnectionEpoch = state.connectionEpoch - 1;
    state.sessions = {
      listBranches: vi.fn().mockResolvedValue([]),
      refreshReplacement: vi.fn(async () => undefined),
    };

    await loadChatHistory(state);

    expect(state.sessions.listBranches).toHaveBeenCalledWith(state.sessionKey, expect.any(Object));
    expect(state.chatBranchesConnectionEpoch).toBe(state.connectionEpoch);
  });

  it("retries the branch list on the next history load after a transient failure", async () => {
    const state = createState({ messages: [] }) as TestState & {
      sessions: { listBranches: ReturnType<typeof vi.fn> };
    };
    state.sessions = {
      listBranches: vi
        .fn()
        .mockRejectedValueOnce(new Error("gateway hiccup"))
        .mockResolvedValue([
          { leafEntryId: "tip", headline: "tip", messageCount: 1, active: true },
        ]),
      refreshReplacement: vi.fn(async () => undefined),
    };

    await loadChatHistory(state);
    // The transient failure must not latch success state; the next load retries.
    expect(state.chatBranchesSessionKey ?? null).toBeNull();

    await loadChatHistory(state);
    expect(state.sessions.listBranches).toHaveBeenCalledTimes(2);
    expect(state.chatBranchesSessionKey).toBe(state.sessionKey);
    expect(state.chatBranches).toHaveLength(1);
  });

  it("treats the legacy main alias and canonical key as the same branch owner", async () => {
    const state = createState({ messages: [] }) as TestState & {
      sessions: { listBranches: ReturnType<typeof vi.fn> };
    };
    state.sessionKey = "main";
    state.chatBranchesSessionKey = "agent:main:main";
    state.chatBranchesConnectionEpoch = state.connectionEpoch;
    state.sessions = {
      listBranches: vi.fn().mockResolvedValue([]),
      refreshReplacement: vi.fn(async () => undefined),
    };

    await loadChatHistory(state);

    // Equivalent spellings must not force a redundant branch reload.
    expect(state.sessions.listBranches).not.toHaveBeenCalled();
  });

  it("starts a fresh snapshot and rejects in-flight history after a same-key branch switch", async () => {
    let resolvePreviousHistory!: (result: ChatHistoryResult) => void;
    const previousHistory = new Promise<ChatHistoryResult>((resolve) => {
      resolvePreviousHistory = resolve;
    });
    const previous = { role: "assistant", content: "private old branch" };
    const selected = { role: "assistant", content: "selected branch" };
    const state = createState({ messages: [selected] }) as TestState & {
      sessions: {
        listBranches: ReturnType<typeof vi.fn>;
        switchBranch: ReturnType<typeof vi.fn>;
      };
    };
    state.sessionKey = "agent:main:branches";
    state.chatMessages = [previous];
    const request = vi
      .fn()
      .mockReturnValueOnce(previousHistory)
      .mockResolvedValueOnce({ messages: [selected] });
    state.client = { request } as unknown as GatewayBrowserClient;
    state.sessions = {
      listBranches: vi.fn().mockResolvedValue([]),
      switchBranch: vi.fn().mockResolvedValue({}),
      refreshReplacement: vi.fn(async () => undefined),
    };

    const staleHistory = loadChatHistory(state);
    expect(request).toHaveBeenCalledOnce();

    await expect(switchChatHistoryBranch(state as never, "selected-leaf")).resolves.toBe(true);

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatMessages).toEqual([selected]);

    resolvePreviousHistory({ messages: [previous] });
    await staleHistory;

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatMessages).toEqual([selected]);
  });

  it("reconciles a committed branch switch after a same-client reconnect", async () => {
    let resolveSwitch!: () => void;
    const switched = new Promise<object>((resolve) => {
      resolveSwitch = () => resolve({});
    });
    const selected = { role: "assistant", content: "selected branch after reconnect" };
    const state = createState({ messages: [selected] }) as TestState & {
      sessions: {
        listBranches: ReturnType<typeof vi.fn>;
        switchBranch: ReturnType<typeof vi.fn>;
      };
    };
    state.chatMessages = [{ role: "assistant", content: "stale branch after reconnect" }];
    state.sessions = {
      listBranches: vi.fn().mockResolvedValue([]),
      switchBranch: vi.fn(() => switched),
      refreshReplacement: vi.fn(async () => undefined),
    };

    const pending = switchChatHistoryBranch(state as never, "stale-leaf");
    state.connected = false;
    state.connectionEpoch += 1;
    state.connected = true;
    state.connectionEpoch += 1;
    resolveSwitch();

    await expect(pending).resolves.toBe(false);
    expect(state.chatMessages).toEqual([selected]);
    expect(state.sessions.listBranches).toHaveBeenCalledWith(state.sessionKey, expect.any(Object));
  });
});

describe("canonical history snapshot projection", () => {
  function message(role: "assistant" | "user", text: string, metadata?: Record<string, unknown>) {
    return {
      role,
      content: [{ type: "text", text }],
      ...(metadata ? { __openclaw: metadata } : {}),
    };
  }

  it("keeps a same-scope pending send when authoritative history is still stale", async () => {
    const persisted = message("user", "first prompt", { id: "first-user", seq: 1 });
    const pending = message("user", "second prompt", {
      idempotencyKey: "second-run:user",
    });
    const state = createState({ messages: [persisted] });
    state.chatMessages = [persisted, pending];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([persisted, pending]);
  });

  it("adopts the persisted form of a pending send exactly once", async () => {
    const first = message("user", "first prompt", { id: "first-user", seq: 1 });
    const pending = message("user", "continue", { idempotencyKey: "second-run:user" });
    const persisted = message("user", "continue", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    const state = createState({ messages: [first, persisted] });
    state.chatMessages = [first, pending];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([first, persisted]);
  });

  it("does not collapse same-text pending and persisted sends from different runs", async () => {
    const first = message("user", "continue", {
      id: "first-user",
      idempotencyKey: "first-run:user",
      seq: 1,
    });
    const second = message("user", "continue", {
      id: "second-user",
      idempotencyKey: "second-run:user",
      seq: 2,
    });
    const pending = message("user", "continue", { idempotencyKey: "third-run:user" });
    const state = createState({ messages: [first, second] });
    state.chatMessages = [first, pending];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([first, second, pending]);
  });

  it("keeps a proven live prompt ahead of its stale-history reply", async () => {
    const prompt = message("user", "shared prompt", { id: "live-user", seq: 1 });
    const reply = message("assistant", "shared reply", { id: "persisted-reply", seq: 2 });
    const state = createState({ messages: [reply] });
    const scope = { sessionKey: state.sessionKey };
    const projection = reduceSessionProjection(getChatSessionProjection(state, [], scope), {
      type: "messagePersisted",
      message: prompt,
      scope,
    });
    setChatSessionProjection(state, projection);
    state.chatMessages = [...projection.messages];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([prompt, reply]);
  });

  it("preserves live rows when an unselected leaf is reported without branch metadata", async () => {
    const prompt = message("user", "delayed shared prompt", {
      id: "finalized-run-user",
      idempotencyKey: "shared-session-finalized-run:user",
      seq: 1,
    });
    const reply = message("assistant", "already finished reply", {
      id: "finalized-run-assistant",
      seq: 2,
    });
    const state = createState({ messages: [reply], sessionId: "control-ui-e2e-session" });
    state.currentSessionId = "control-ui-e2e-session";
    state.chatDisplayedLeafEntryId = undefined;
    const scope = {
      sessionKey: state.sessionKey,
      sessionId: state.currentSessionId,
      activeLeafEntryId: null,
    };
    const projection = reduceSessionProjection(getChatSessionProjection(state, [reply], scope), {
      type: "messagePersisted",
      message: prompt,
      scope,
    });
    setChatSessionProjection(state, projection);
    state.chatMessages = [...projection.messages];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([prompt, reply]);
  });

  it("coalesces stale history while distinct live peer messages update the transcript", async () => {
    let resolveHistory!: (history: ChatHistoryResult) => void;
    const history = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const first = message("user", "shared prompt", {
      id: "canonical-web-same-text",
      idempotencyKey: "web-same-text-run:user",
      seq: 1,
    });
    const second = message("user", "shared prompt", {
      id: "canonical-tui-same-text",
      idempotencyKey: "tui-same-text-run:user",
      seq: 2,
    });
    const state = createState({ messages: [] });
    const request = vi.fn().mockReturnValue(history);
    state.client = { request } as unknown as GatewayBrowserClient;
    const scope = { sessionKey: state.sessionKey };

    const firstProjection = reduceSessionProjection(
      getChatSessionProjection(state, state.chatMessages, scope),
      { type: "messagePersisted", message: first, scope },
    );
    setChatSessionProjection(state, firstProjection);
    state.chatMessages = [...firstProjection.messages];
    const firstLoad = loadChatHistory(state);

    const secondProjection = reduceSessionProjection(
      getChatSessionProjection(state, state.chatMessages, scope),
      { type: "messagePersisted", message: second, scope },
    );
    setChatSessionProjection(state, secondProjection);
    state.chatMessages = [...secondProjection.messages];
    const secondLoad = loadChatHistory(state);

    expect(request).toHaveBeenCalledOnce();
    expect(state.chatMessages).toEqual([first, second]);

    resolveHistory({ messages: [] });
    await Promise.all([firstLoad, secondLoad]);

    expect(request).toHaveBeenCalledOnce();
    expect(state.chatMessages).toEqual([first, second]);
  });

  it("preserves pending input appended while the authoritative request is in flight", async () => {
    let resolveHistory!: (history: ChatHistoryResult) => void;
    const history = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const first = message("user", "first prompt", { id: "first-user", seq: 1 });
    const pending = message("user", "concurrent prompt", {
      idempotencyKey: "concurrent-run:user",
    });
    const state = createState({ messages: [first] });
    state.chatMessages = [first];
    state.client = {
      request: vi.fn().mockReturnValue(history),
    } as unknown as GatewayBrowserClient;

    const load = loadChatHistory(state);
    state.chatMessages = [...state.chatMessages, pending];
    resolveHistory({ messages: [first] });
    await load;

    expect(state.chatMessages).toEqual([first, pending]);
  });

  it("does not preserve old pending sends after the active branch changes", async () => {
    const previous = message("user", "old branch history", { id: "old-user", seq: 4 });
    const next = message("user", "next branch", { id: "next-user", seq: 5 });
    const pending = message("user", "old branch pending", {
      idempotencyKey: "old-branch-run:user",
    });
    const state = createState({
      messages: [next],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 6,
      sessionInfo: {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        sessionId: "shared-session",
        activeLeafEntryId: "next-leaf",
      },
    });
    state.currentSessionId = "shared-session";
    state.chatDisplayedLeafEntryId = "old-leaf";
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 5 };
    state.chatMessages = [previous, pending];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([next]);
    expect(state.chatDisplayedLeafEntryId).toBe("next-leaf");
  });

  it.each([
    { name: "unbranched to selected", previousLeaf: null, nextLeaf: "next-leaf" },
    { name: "selected to unbranched", previousLeaf: "previous-leaf", nextLeaf: null },
  ])("never leaks $name transcript rows across an explicit branch change", async (branch) => {
    const previous = message("user", "private previous branch", {
      id: "private-previous-user",
      seq: 4,
    });
    const pending = message("user", "private pending prompt", {
      idempotencyKey: "private-branch-run:user",
    });
    const live = message("assistant", "private live reply", {
      id: "private-live-reply",
      seq: 5,
    });
    const next = message("user", "selected branch history", {
      id: "selected-branch-user",
      seq: 5,
    });
    const state = createState({
      messages: [next],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 6,
      sessionInfo: {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        sessionId: "shared-session",
        activeLeafEntryId: branch.nextLeaf,
      },
    });
    state.currentSessionId = "shared-session";
    state.chatDisplayedLeafEntryId = branch.previousLeaf;
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 5 };
    const scope = {
      sessionKey: state.sessionKey,
      sessionId: "shared-session",
      activeLeafEntryId: branch.previousLeaf,
    };
    const projection = reduceSessionProjection(
      getChatSessionProjection(state, [previous, pending], scope),
      { type: "messagePersisted", message: live, scope },
    );
    setChatSessionProjection(state, projection);
    state.chatMessages = [...projection.messages];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([next]);
    expect(state.chatDisplayedLeafEntryId).toBe(branch.nextLeaf);
  });

  it("does not restore a hidden live assistant from an older visible snapshot", async () => {
    const hidden = message("assistant", "NO_REPLY", { id: "hidden-reply", seq: 1 });
    const state = createState({ messages: [] });
    const scope = { sessionKey: state.sessionKey };
    const projection = reduceSessionProjection(getChatSessionProjection(state, [], scope), {
      type: "messagePersisted",
      message: hidden,
      scope,
    });
    setChatSessionProjection(state, projection);
    state.chatMessages = [...projection.messages];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([]);
  });

  it("clears live projection ownership after history access is denied", async () => {
    const live = message("user", "private prompt", { id: "private-user", seq: 1 });
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "PERMISSION_DENIED",
          message: "not allowed",
          details: { code: "AUTH_UNAUTHORIZED" },
        }),
      )
      .mockResolvedValueOnce({ messages: [] });
    const state = createState({ messages: [] });
    state.client = { request } as unknown as GatewayBrowserClient;
    const scope = { sessionKey: state.sessionKey };
    const projection = reduceSessionProjection(getChatSessionProjection(state, [], scope), {
      type: "messagePersisted",
      message: live,
      scope,
    });
    setChatSessionProjection(state, projection);
    state.chatMessages = [...projection.messages];

    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([]);

    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([]);
  });
});

describe("active-run commentary reconciliation", () => {
  it("keeps keyed commentary live across history reloads when persistence is disabled", async () => {
    const state = createState(activeHistory("run-live"));
    state.chatRunId = "run-live";
    state.settings = { chatPersistCommentary: false };
    state.chatStreamSegments = [{ text: "Checking the workspace", ts: 2, itemId: "preamble-live" }];

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-live");
    expect(state.chatStreamSegments).toEqual([
      { text: "Checking the workspace", ts: 2, itemId: "preamble-live" },
    ]);
  });

  it("materializes live commentary when history replaces active tool activity", async () => {
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      content: "tool output",
      timestamp: 3,
    };
    const state = createState({
      ...activeHistory("run-live"),
      messages: [{ role: "user", content: "do it", timestamp: 1 }, toolResult],
    });
    state.chatRunId = "run-live";
    state.settings = { chatPersistCommentary: false };
    state.chatStreamSegments = [{ text: "Checking the workspace", ts: 2, itemId: "preamble-live" }];
    state.toolStreamOrder = ["call-1"];
    state.toolStreamById.set("call-1", {
      toolCallId: "call-1",
      runId: "run-live",
      name: "read",
      startedAt: 2,
      receivedAt: 2,
      message: toolResult,
    });
    state.chatToolMessages = [toolResult];

    await loadChatHistory(state);

    expect(
      state.chatMessages.some(
        (message) =>
          (message as { openclawStreamFallback?: { itemId?: unknown } }).openclawStreamFallback
            ?.itemId === "preamble-live",
      ),
    ).toBe(true);
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("keeps a foreground tool when history persists a sibling run with the same call id", async () => {
    const toolCallId = "call-shared";
    const foregroundIdentity = buildToolStreamIdentity("run-foreground", toolCallId);
    const backgroundIdentity = buildToolStreamIdentity("run-background", toolCallId);
    const backgroundResult = {
      role: "toolResult",
      runId: "run-background",
      toolCallId,
      content: "background complete",
      timestamp: 4,
    };
    const state = createState({
      ...activeHistory("run-foreground"),
      messages: [{ role: "user", content: "do it", timestamp: 1 }, backgroundResult],
    });
    state.chatRunId = "run-foreground";
    state.chatStream = "foreground still running";
    state.chatStreamStartedAt = 5;
    const foregroundMessage = {
      role: "assistant",
      runId: "run-foreground",
      toolCallId,
      content: [{ type: "toolcall", name: "read", arguments: { path: "foreground.txt" } }],
    };
    const backgroundMessage = {
      role: "assistant",
      runId: "run-background",
      toolCallId,
      content: [{ type: "toolcall", name: "exec", arguments: { command: "background" } }],
    };
    state.toolStreamOrder = [foregroundIdentity, backgroundIdentity];
    state.toolStreamById.set(foregroundIdentity, {
      toolCallId,
      runId: "run-foreground",
      name: "read",
      startedAt: 2,
      receivedAt: 2,
      message: foregroundMessage,
    });
    state.toolStreamById.set(backgroundIdentity, {
      toolCallId,
      runId: "run-background",
      name: "exec",
      startedAt: 3,
      receivedAt: 3,
      resultReceived: true,
      message: backgroundMessage,
    });
    state.chatToolMessages = [foregroundMessage, backgroundMessage];
    state.chatStreamSegments = [
      { text: "before foreground", ts: 2, runId: "run-foreground", toolCallId },
      { text: "before background", ts: 3, runId: "run-background", toolCallId },
    ];

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-foreground");
    expect(state.chatStream).toBe("foreground still running");
    expect(state.toolStreamOrder).toEqual([foregroundIdentity]);
    expect(state.toolStreamById.has(foregroundIdentity)).toBe(true);
    expect(state.toolStreamById.has(backgroundIdentity)).toBe(false);
    expect(state.chatToolMessages).toEqual([foregroundMessage]);
    expect(state.chatStreamSegments).toEqual([
      { text: "before foreground", ts: 2, runId: "run-foreground", toolCallId },
    ]);
  });
});
