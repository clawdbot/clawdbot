// @vitest-environment node
import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
import {
  ControlModelCommandError,
  type ControlModel,
  type ControlModelConversationSnapshot,
} from "@openclaw/gateway-client/model";
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  loadChatHistory,
  loadOlderChatHistoryPage,
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
import { handleAgentEvent, type PlanStatus, type ToolStreamEntry } from "./tool-stream.ts";

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
  const sessions: TestSessions = { setModelOverride: vi.fn() };
  return {
    ...host,
    chatToolMessages: host.chatToolMessages ?? [],
    chatStreamSegments: host.chatStreamSegments ?? [],
    connectionEpoch: 1,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatStreamStartedAt: null,
    planStatus: {
      runId: "stale-run",
      steps: [{ step: "Reset me", status: "in_progress" }],
    },
    sessions,
    toolStreamById: host.toolStreamById ?? new Map<string, ToolStreamEntry>(),
    toolStreamOrder: host.toolStreamOrder ?? [],
    toolStreamSyncTimer: host.toolStreamSyncTimer ?? null,
    requestUpdate: vi.fn(),
  };
}

function activeHistory(
  runId: string,
  plan?: NonNullable<ChatHistoryResult["inFlightRun"]>["plan"],
): ChatHistoryResult {
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
      ...(plan !== undefined ? { plan } : {}),
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
      setModelOverride: vi.fn(),
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
      setModelOverride: vi.fn((_key: string, _value: string | null | undefined) => undefined),
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
      setModelOverride: vi.fn((_key: string, _value: string | null | undefined) => undefined),
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
      setModelOverride: vi.fn((_key: string, _value: string | null | undefined) => undefined),
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
      setModelOverride: vi.fn(),
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
      setModelOverride: vi.fn(),
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
      setModelOverride: vi.fn(),
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
    state.sessions = { listBranches: vi.fn().mockResolvedValue([]), setModelOverride: vi.fn() };

    await loadChatHistory(state);

    expect(state.sessions.listBranches).toHaveBeenCalledWith(state.sessionKey, expect.any(Object));
    expect(state.chatBranchesConnectionEpoch).toBe(state.connectionEpoch);
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
      setModelOverride: vi.fn(),
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
});

describe("canonical history snapshot projection", () => {
  it("falls back to Gateway history when the Control Model chunk fails to load", async () => {
    const state = createState({ messages: [message("user", "gateway fallback")] });
    state.loadControlModel = async () => {
      throw new Error("chunk failed");
    };

    await loadChatHistory(state);

    // oxlint-disable-next-line unbound-method -- Vitest inspects the mock without invoking it.
    expect(state.client?.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: "main" }),
    );
    expect(state.chatMessages).toEqual([
      expect.objectContaining({
        content: [expect.objectContaining({ text: "gateway fallback" })],
      }),
    ]);
  });

  it("falls back when an older Gateway does not implement chat.startup", async () => {
    const state = createState({ messages: [] });
    const snapshot = {
      sessionKey: "main",
      history: { status: "ready" },
      metadata: null,
      messages: [],
      activeRun: null,
    } as unknown as ControlModelConversationSnapshot;
    const refreshHistory = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlModelCommandError({
          category: "invalid-input",
          code: "INVALID_REQUEST",
          message: "unknown method: chat.startup",
          command: "chat.startup",
        }),
      )
      .mockResolvedValueOnce(undefined);
    const conversation = {
      getSnapshot: () => snapshot,
      refreshHistory,
      loadMoreHistory: vi.fn(),
    };
    state.controlModel = {
      conversation: vi.fn(() => conversation),
      releaseConversation: vi.fn(async () => undefined),
    } as unknown as ControlModel;

    await loadChatHistory(state, { startup: true });

    expect(refreshHistory).toHaveBeenNthCalledWith(1, undefined, "chat.startup");
    expect(refreshHistory).toHaveBeenNthCalledWith(2, undefined, "chat.history");
  });

  it("refreshes every explicit Control Model history load and coalesces concurrent callers", async () => {
    const state = createState({ messages: [] });
    const snapshot = {
      sessionKey: "main",
      status: "ready",
      revision: 1,
      historyRevision: 1,
      connection: { status: "connected", epoch: 1 },
      history: {
        status: "idle",
        hasMore: false,
        nextOffset: null,
        totalMessages: 1,
        completeSnapshot: false,
        window: "newest",
        truncatedBefore: false,
        truncatedAfter: false,
        revision: 0,
        error: null,
      },
      metadata: null,
      messages: [],
      runs: [],
      activeRun: null,
      tools: [],
      artifacts: [],
      approvals: [],
      questions: [],
      partialReasons: [],
      stale: false,
      hasTransportGap: false,
      commandAvailability: {
        send: true,
        abort: false,
        resolveApproval: false,
        answerQuestion: false,
        cancelQuestion: false,
        materializeView: false,
      },
      bounds: {
        messagesTruncated: false,
        runsTruncated: false,
        toolsTruncated: false,
        approvalsTruncated: false,
        questionsTruncated: false,
        artifactsTruncated: false,
      },
    } as unknown as ControlModelConversationSnapshot;
    let releaseSecondRefresh: () => void = () => undefined;
    const secondRefresh = new Promise<void>((resolve) => {
      releaseSecondRefresh = resolve;
    });
    const refreshHistory = vi.fn(async (_options?: unknown, method?: unknown) => {
      const call = refreshHistory.mock.calls.length;
      if (call === 2) {
        await secondRefresh;
      }
      Object.assign(snapshot, {
        revision: call + 1,
        historyRevision: call,
        history: {
          ...snapshot.history,
          status: "ready",
          completeSnapshot: true,
          revision: call,
        },
        metadata: {
          sessionId: "session-one",
          sessionInfo: { key: "main", kind: "direct" },
        },
        messages: [
          {
            key: `message-${call}`,
            role: "user",
            sequence: call,
            runId: null,
            pending: false,
            live: false,
            provisional: false,
            artifactIds: [],
            raw: {
              role: "user",
              content: call === 1 ? "first authoritative" : "second authoritative",
              __openclaw: { id: `message-${call}`, seq: call },
            },
          },
        ],
      });
      expect(method).toBe(call === 1 ? "chat.startup" : "chat.history");
    });
    const conversation = {
      getSnapshot: () => snapshot,
      refreshHistory,
      loadMoreHistory: vi.fn(),
    };
    const model = {
      conversation: vi.fn(() => conversation),
      releaseConversation: vi.fn(async () => undefined),
    } as unknown as ControlModel;
    state.controlModel = model;

    await loadChatHistory(state, { startup: true });
    expect(state.chatMessages).toEqual([
      expect.objectContaining({ content: "first authoritative" }),
    ]);

    const explicit = loadChatHistory(state);
    const concurrent = loadChatHistory(state);
    expect(refreshHistory).toHaveBeenCalledTimes(2);
    releaseSecondRefresh();
    await Promise.all([explicit, concurrent]);

    expect(model.conversation).toHaveBeenCalledOnce();
    expect(refreshHistory).toHaveBeenCalledTimes(2);
    // oxlint-disable-next-line unbound-method -- Vitest inspects the mock without invoking it.
    expect(state.client?.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
    expect(state.chatMessages).toEqual([
      expect.objectContaining({ content: "second authoritative" }),
    ]);
    expect(state.currentSessionId).toBe("session-one");
  });

  it("filters hidden transcript rows from older Control Model history", async () => {
    const hidden = message("assistant", "NO_REPLY", { id: "hidden-reply", seq: 1 });
    const visible = message("assistant", "older visible", { id: "visible-reply", seq: 2 });
    const state = createState({ messages: [] });
    const snapshot = {
      metadata: null,
      activeRun: null,
      messages: [{ raw: hidden }, { raw: visible }],
      history: {
        window: "older",
        nextOffset: null,
        hasMore: false,
        totalMessages: 2,
        completeSnapshot: true,
      },
    } as unknown as ControlModelConversationSnapshot;
    const conversation = {
      getSnapshot: () => snapshot,
      refreshHistory: vi.fn(),
      loadMoreHistory: vi.fn(async () => undefined),
    };
    state.controlModel = {
      conversation: vi.fn(() => conversation),
      releaseConversation: vi.fn(async () => undefined),
    } as unknown as ControlModel;

    await expect(loadOlderChatHistoryPage(state, 1)).resolves.toMatchObject({
      messages: [visible],
    });
  });

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

describe("chat history plan replay", () => {
  const retainedPlan = {
    runId: "run-retained",
    steps: [{ step: "Retained", status: "in_progress" }],
  } satisfies PlanStatus;
  const livePlan = {
    runId: "run-live",
    steps: [{ step: "New live plan", status: "in_progress" }],
  } satisfies PlanStatus;
  const cases: Array<{
    name: string;
    history: ChatHistoryResult;
    expected: PlanStatus | null;
    staleAfterLivePlan?: boolean;
  }> = [
    {
      name: "replace",
      history: activeHistory("run-retained", {
        explanation: "  Reconnected work  ",
        steps: [
          { step: "First active", status: "in_progress" },
          { step: "Second active", status: "in_progress" },
          "Legacy step",
        ],
      }),
      expected: {
        runId: "run-retained",
        explanation: "Reconnected work",
        steps: [
          { step: "First active", status: "in_progress" },
          { step: "Second active", status: "pending" },
          { step: "Legacy step", status: "pending" },
        ],
      },
    },
    {
      name: "legacy-preserve",
      history: activeHistory("run-retained"),
      expected: retainedPlan,
    },
    {
      name: "superseded",
      history: activeHistory("run-next", {
        steps: [{ step: "Next run", status: "in_progress" }],
      }),
      expected: {
        runId: "run-next",
        steps: [{ step: "Next run", status: "in_progress" }],
      },
    },
    {
      name: "active-preserve",
      history: {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          activeRunIds: ["run-retained"],
        },
      },
      expected: retainedPlan,
    },
    {
      name: "terminal-clear",
      history: {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: false,
          activeRunIds: [],
        },
      },
      expected: null,
    },
    {
      name: "no-evidence-preserve",
      history: { messages: [] },
      expected: retainedPlan,
    },
    {
      name: "stale-response-does-not-clobber-newer-live-plan",
      history: {
        messages: [],
        sessionInfo: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: false,
          activeRunIds: [],
        },
      },
      expected: livePlan,
      staleAfterLivePlan: true,
    },
    {
      name: "explicit-empty-clears",
      history: activeHistory("run-retained", { steps: [] }),
      expected: null,
    },
  ];

  it.each(cases)("$name", async (testCase) => {
    let resolveHistory!: (result: ChatHistoryResult) => void;
    const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const state = createState(testCase.history);
    state.planStatus = retainedPlan;
    if (testCase.staleAfterLivePlan) {
      const request = vi.fn().mockReturnValue(historyPromise);
      state.client = { request } as unknown as GatewayBrowserClient;
      const loadPromise = loadChatHistory(state);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      state.chatRunId = "run-live";
      handleAgentEvent(state, {
        runId: "run-live",
        seq: 2,
        stream: "plan",
        ts: 2,
        sessionKey: "main",
        data: {
          phase: "update",
          steps: [{ step: "New live plan", status: "in_progress" }],
        },
      });
      resolveHistory(testCase.history);
      await loadPromise;
    } else {
      await loadChatHistory(state);
    }

    expect(state.planStatus).toEqual(testCase.expected);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered chat history test suite. */
