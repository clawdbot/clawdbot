// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  loadChatHistory,
  rewindChatHistory,
  switchChatHistoryBranch,
  type ChatHistoryResult,
  type ChatState,
} from "./chat-history.ts";
import {
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { handleAgentEvent, type PlanStatus, type ToolStreamEntry } from "./tool-stream.ts";

type TestState = ChatState &
  Parameters<typeof handleAgentEvent>[0] & {
    requestUpdate: () => void;
  };

function createState(result: ChatHistoryResult): TestState {
  const client = {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as GatewayBrowserClient;
  return {
    client,
    connected: true,
    connectionEpoch: 1,
    sessionKey: "main",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    planStatus: {
      runId: "stale-run",
      steps: [{ step: "Reset me", status: "in_progress" }],
    },
    lastError: null,
    hello: null,
    sessions: {
      setModelOverride: vi.fn(),
    },
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
    state.sessions = {
      rewind: vi.fn().mockResolvedValue({ editorText: "edit this" }),
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
    expect(result).toEqual({ editorText: "edit this" });
    expect(state.chatMessage).toBe("edit this");
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
