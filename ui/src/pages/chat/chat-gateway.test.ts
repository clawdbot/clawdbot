// @vitest-environment node
// Control UI tests cover chat behavior.
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { loadChatHistory, type ChatState } from "./chat-history.ts";
import { readChatMessagesFromCache } from "./session-message-cache.ts";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunStartup: null,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    client: null,
    connected: true,
    connectionEpoch: 0,
    hello: null,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function expectTextChatMessage(message: unknown, role: string, text: string): void {
  const record = requireRecord(message);
  expect(record.role).toBe(role);
  expect(record.content).toEqual([{ type: "text", text }]);
}

function createTextChatMessage(
  role: "assistant" | "user",
  text: string,
  metadata?: Record<string, unknown>,
  timestamp?: number,
) {
  return {
    role,
    content: [{ type: "text" as const, text }],
    ...(metadata ? { __openclaw: metadata } : {}),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

function createActiveStreamingState() {
  return createState({
    sessionKey: "main",
    chatRunId: "run-user",
    chatStream: "Working...",
    chatStreamStartedAt: 123,
  });
}

function trackChatMessagesAssignments(state: ChatState) {
  let chatMessages = state.chatMessages;
  const assignments: Array<{
    chatRunId: string | null;
    chatStream: string | null;
    messages: unknown[];
  }> = [];
  Object.defineProperty(state, "chatMessages", {
    configurable: true,
    get: () => chatMessages,
    set: (messages: unknown[]) => {
      assignments.push({
        chatRunId: state.chatRunId,
        chatStream: state.chatStream,
        messages,
      });
      chatMessages = messages;
    },
  });
  return assignments;
}

function createOtherRunSilentFinalPayload(text: string): ChatEventPayload {
  return {
    runId: "run-announce",
    sessionKey: "main",
    state: "final",
    message: createTextChatMessage("assistant", text),
  };
}

function createOtherRunNoReplyFinalPayload(): ChatEventPayload {
  return createOtherRunSilentFinalPayload("NO_REPLY");
}

describe("handleChatGatewayEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatGatewayEvent(state, undefined)).toBe(null);
  });

  it("drops sessionless run-idless terminal events instead of materializing them", () => {
    // Companion/internal runs can surface unkeyed terminal events; with no
    // active run, undefined === undefined must not pass the run-id fallback.
    const state = createState({ sessionKey: "main" });
    const before = state.chatMessages.length;
    handleChatGatewayEvent(state, {
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "leaked companion answer" }] },
    } as ChatEventPayload);
    expect(state.chatMessages.length).toBe(before);
    expect(JSON.stringify(state.chatMessages)).not.toContain("leaked companion answer");
  });

  it("adopts startup status only for the queued local run before its ACK", () => {
    const state = createState({
      chatQueue: [
        {
          id: "queued-1",
          text: "hello",
          createdAt: 1,
          sendRunId: "run-1",
          sendState: "sending",
        },
      ],
      sessionKey: "main",
    });

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-other",
        sessionKey: "main",
        state: "status",
        phase: "preparing_workspace",
      }),
    ).toBeNull();
    expect(state.chatRunId).toBeNull();
    expect(state.chatRunStartup).toBeNull();

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "status",
        phase: "preparing_workspace",
      }),
    ).toBe("status");
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "preparing_workspace",
    });
  });

  it("shows startup status until the first chat delta and ignores late status", () => {
    const state = createState({
      chatRunId: "run-1",
      chatStream: "",
      sessionKey: "main",
    });
    const status: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "status",
      phase: "preparing_context",
    };

    expect(handleChatGatewayEvent(state, status)).toBe("status");
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "preparing_context",
    });

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-other",
        sessionKey: "main",
        state: "delta",
        deltaText: "Other reply",
      }),
    ).toBeNull();
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "preparing_context",
    });

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "delta",
        deltaText: "Hello",
      }),
    ).toBe("delta");
    expect(state.chatRunStartup).toEqual({ state: "activity", runId: "run-1" });

    expect(handleChatGatewayEvent(state, status)).toBe("status");
    expect(state.chatRunStartup).toEqual({ state: "activity", runId: "run-1" });
  });

  it("returns null when sessionKey does not match and no active run is in flight", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatGatewayEvent(state, payload)).toBe(null);
  });

  it("caches final messages for a switched-away session", () => {
    const visibleMessage = createTextChatMessage("assistant", "main visible");
    const state = createState({
      sessionKey: "main",
      chatMessages: [visibleMessage],
      chatMessagesBySession: new Map(),
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
      message: createTextChatMessage("assistant", "other final"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: "other",
      }),
    ).toEqual([payload.message]);
  });

  it.each([
    {
      name: "canonical default-session finals under the main alias",
      activeSessionKey: "agent:main:other",
      payloadSessionKey: "agent:main:main",
      withConfiguredDefaults: false,
    },
    {
      name: "configured default-session finals under runtime aliases",
      activeSessionKey: "agent:ops:other",
      payloadSessionKey: "agent:ops:home",
      withConfiguredDefaults: true,
    },
    {
      name: "canonical non-main finals under the plain session key",
      activeSessionKey: "main",
      payloadSessionKey: "agent:main:project",
      withConfiguredDefaults: false,
    },
  ])("caches $name", ({ activeSessionKey, payloadSessionKey, withConfiguredDefaults }) => {
    const state = createState({ sessionKey: activeSessionKey, chatMessagesBySession: new Map() });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: payloadSessionKey,
      state: "final",
      message: createTextChatMessage("assistant", "cached final"),
    };

    if (withConfiguredDefaults) {
      (state as Record<string, unknown>).hello = {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "ops",
            mainKey: "home",
          },
        },
      };
    }

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: payloadSessionKey,
      }),
    ).toEqual([payload.message]);
    expect(state.chatMessagesBySession?.size).toBe(1);
  });

  it("caches inactive global finals under the payload agent only", () => {
    const visibleMessage = createTextChatMessage("assistant", "work visible");
    const state = createState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessages: [visibleMessage],
      chatMessagesBySession: new Map(),
    });
    const payload: ChatEventPayload = {
      runId: "run-main-global",
      sessionKey: "global",
      agentId: "main",
      state: "final",
      message: createTextChatMessage("assistant", "main final"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: "global",
        agentId: "main",
      }),
    ).toEqual([payload.message]);
    expect(state.chatMessagesBySession?.has("agent:work:main")).toBe(false);
  });

  it("does not arm stale active-row suppression for an unowned selected-session final", () => {
    const state = createState({ sessionKey: "main" }) as ChatState & {
      lastLocalTerminalReconcile?: unknown;
    };
    const payload: ChatEventPayload = {
      runId: "observed-run",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "Observed reply"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.lastLocalTerminalReconcile).toBeUndefined();
  });

  it("ignores selected-agent global events for another agent", () => {
    const state = createState({
      sessionKey: "global",
      assistantAgentId: "work",
    });
    const payload: ChatEventPayload = {
      runId: "run-main-global",
      sessionKey: "global",
      agentId: "main",
      state: "final",
    };

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBeNull();
  });

  it("ignores canonical global events for another selected agent main alias", () => {
    const state = createState({
      sessionKey: "agent:work:main",
    });
    const payload: ChatEventPayload = {
      runId: "run-main-global",
      sessionKey: "global",
      agentId: "main",
      state: "final",
    };

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBeNull();
  });

  it("treats unscoped global events as default-agent events only", () => {
    const state = createState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });
    const payload: ChatEventPayload = {
      runId: "run-default-global",
      sessionKey: "global",
      state: "final",
    };

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBeNull();
  });

  it("adopts canonical global deltas for the selected agent main alias", () => {
    const state = createState({
      sessionKey: "agent:work:main",
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
    });
    const payload: ChatEventPayload = {
      runId: "run-work-global",
      sessionKey: "global",
      agentId: "work",
      state: "delta",
      message: createTextChatMessage("assistant", "Work reply"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatRunId).toBe("run-work-global");
    expect(state.chatStream).toBe("Work reply");
    expect(state.chatStreamStartedAt).toEqual(expect.any(Number));
  });

  it("accepts delta events for the active run when gateway emits a canonical session key", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: null,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "agent:main:main",
      state: "delta",
      message: createTextChatMessage("assistant", "Live reply"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Live reply");
    expect(state.chatRunId).toBe("run-1");
  });

  it.each([
    {
      name: "appends gateway deltaText when the cumulative snapshot matches the current prefix",
      previous: "Live",
      delta: " reply",
      snapshot: "Live reply",
      expected: "Live reply",
    },
    {
      name: "uses the cumulative snapshot when the first observed delta joins mid-stream",
      previous: null,
      delta: " reply",
      snapshot: "Live reply",
      expected: "Live reply",
    },
    {
      name: "appends gateway deltaText when no full message snapshot is present",
      previous: "Live",
      delta: " reply",
      expected: "Live reply",
    },
    {
      name: "uses the cumulative snapshot when a missed delta would make append stale",
      previous: "Hello",
      delta: "!",
      snapshot: "Hello world!",
      expected: "Hello world!",
    },
    {
      name: "uses the cumulative snapshot when a same-length missed replacement changes the prefix",
      previous: "AB",
      delta: "E",
      snapshot: "CDE",
      expected: "CDE",
    },
    {
      name: "replaces the stream when gateway deltaText marks a replacement",
      previous: "Alpha beta",
      delta: "Alpha",
      snapshot: "ignored snapshot",
      replace: true,
      expected: "Alpha",
    },
  ])("$name", ({ previous, delta, snapshot, replace, expected }) => {
    const state = createState({ sessionKey: "main", chatRunId: "run-1", chatStream: previous });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: delta,
      ...(snapshot === undefined ? {} : { message: createTextChatMessage("assistant", snapshot) }),
      ...(replace ? { replace: true } : {}),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe(expected);
  });

  it("adopts the run id for selected-session live deltas observed from another channel", () => {
    const state = createState({
      sessionKey: "agent:main:feishu:direct:peer-1",
      chatRunId: null,
      chatRunError: { summary: "Previous run failed" },
      chatStream: null,
      chatStreamStartedAt: null,
    });
    const payload: ChatEventPayload = {
      runId: "run-feishu-1",
      sessionKey: "agent:main:feishu:direct:peer-1",
      state: "delta",
      message: createTextChatMessage("assistant", "Observed reply"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatRunId).toBe("run-feishu-1");
    expect(state.chatRunError).toBeNull();
    expect(state.chatStream).toBe("Observed reply");
    expect(state.chatStreamStartedAt).toEqual(expect.any(Number));
  });

  it("adopts the run id when the selected main alias receives canonical live deltas", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
    });
    const payload: ChatEventPayload = {
      runId: "run-canonical-main",
      sessionKey: "agent:main:main",
      state: "delta",
      message: createTextChatMessage("assistant", "Canonical reply"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatRunId).toBe("run-canonical-main");
    expect(state.chatStream).toBe("Canonical reply");
    expect(state.chatStreamStartedAt).toEqual(expect.any(Number));
  });

  it("accepts final events for the active run when gateway emits a canonical session key", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Live reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "agent:main:main",
      state: "final",
      message: createTextChatMessage("assistant", "Live reply"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("does not duplicate streamed text when final payload has no role", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Live reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        text: "Live reply",
      },
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("persists keyed commentary with the final answer by default", () => {
    const user = { role: "user", content: [{ type: "text", text: "Ask" }], timestamp: 1 };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [user],
      chatStream: null,
      chatStreamStartedAt: null,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
    state.chatStreamSegments = [{ text: "Looking into it.", ts: 2, itemId: "preamble-1" }];
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "Final answer.", undefined, 5),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(3);
    expectTextChatMessage(state.chatMessages[0], "user", "Ask");
    expectTextChatMessage(state.chatMessages[1], "assistant", "Looking into it.");
    expectTextChatMessage(state.chatMessages[2], "assistant", "Final answer.");
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("does not replay persisted keyed commentary after retiring a same-run steer", () => {
    const originalUser = createTextChatMessage("user", "Ask", undefined, 1);
    const persistedCommentary = {
      role: "assistant",
      content: [{ type: "text", text: "Looking into it." }],
      timestamp: 2,
      openclawStreamFallback: {
        itemId: "preamble-1",
        replacementText: "Looking into it.",
        source: "segment",
      },
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [originalUser, persistedCommentary],
      chatQueue: [
        {
          id: "steer-1",
          text: "Focus on the deployment too",
          createdAt: 3,
          kind: "steered",
          pendingRunId: "run-1",
          sendRunId: "steer-send-1",
          sessionKey: "main",
        },
      ],
      chatStream: null,
      chatStreamStartedAt: null,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
    state.chatStreamSegments = [{ text: "Looking into it.", ts: 2, itemId: "preamble-1" }];

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: createTextChatMessage("assistant", "Final answer.", undefined, 5),
      }),
    ).toBe("final");

    expect(state.chatQueue).toEqual([]);
    expect(state.chatMessages).toHaveLength(4);
    expectTextChatMessage(state.chatMessages[0], "user", "Ask");
    expectTextChatMessage(state.chatMessages[1], "assistant", "Looking into it.");
    expectTextChatMessage(state.chatMessages[2], "user", "Focus on the deployment too");
    expectTextChatMessage(state.chatMessages[3], "assistant", "Final answer.");
  });

  it("uses an already-persisted steer to recover the active stream boundary", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [
        { role: "user", content: [{ type: "text", text: "Ask" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking into it." }],
          timestamp: 2,
          openclawStreamFallback: {
            itemId: "preamble-1",
            replacementText: "Looking into it.",
            source: "segment",
          },
        },
        createTextChatMessage(
          "user",
          "Focus on deployment",
          { idempotencyKey: "steer-send-1:user" },
          3,
        ),
      ],
      chatQueue: [
        {
          id: "steer-1",
          text: "Focus on deployment",
          createdAt: 3,
          kind: "steered",
          pendingRunId: "run-1",
          sendRunId: "steer-send-1",
          sessionKey: "main",
        },
      ],
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
    state.chatStreamSegments = [{ text: "Looking into it.", ts: 2, itemId: "preamble-1" }];

    handleChatGatewayEvent(state, {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "Final answer.", undefined, 5),
    });

    expect(state.chatQueue).toEqual([]);
    expect(state.chatMessages).toHaveLength(4);
    expectTextChatMessage(state.chatMessages[0], "user", "Ask");
    expectTextChatMessage(state.chatMessages[1], "assistant", "Looking into it.");
    expectTextChatMessage(state.chatMessages[2], "user", "Focus on deployment");
    expectTextChatMessage(state.chatMessages[3], "assistant", "Final answer.");
  });

  it("clears keyed commentary when chatPersistCommentary is false", () => {
    const user = { role: "user", content: [{ type: "text", text: "Ask" }], timestamp: 1 };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [user],
      chatStream: null,
      chatStreamStartedAt: null,
      settings: { chatPersistCommentary: false },
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
    state.chatStreamSegments = [{ text: "Looking into it.", ts: 2, itemId: "preamble-1" }];
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "Final answer.", undefined, 5),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(2);
    expectTextChatMessage(state.chatMessages[0], "user", "Ask");
    expectTextChatMessage(state.chatMessages[1], "assistant", "Final answer.");
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("reconciles cached run and indicator state on terminal events", () => {
    vi.useFakeTimers();
    try {
      const state = createState({
        sessionKey: "main",
        chatRunId: "run-1",
        chatStream: "Live reply",
        chatStreamStartedAt: 100,
      }) as ChatState & {
        chatRunStatus?: unknown;
        compactionStatus?: unknown;
        compactionClearTimer?: ReturnType<typeof setTimeout> | null;
        fallbackStatus?: unknown;
        fallbackClearTimer?: ReturnType<typeof setTimeout> | null;
        sessionsResult?: {
          ts: number;
          path: string;
          count: number;
          defaults: Record<string, unknown>;
          sessions: Array<Record<string, unknown>>;
        };
      };
      state.compactionStatus = {
        phase: "active",
        runId: "run-1",
        startedAt: 100,
        completedAt: null,
      };
      state.compactionClearTimer = setTimeout(() => undefined, 1_000);
      state.fallbackStatus = {
        selected: "openai/gpt-5.5",
        active: "anthropic/claude-sonnet-4-6",
        attempts: [],
        occurredAt: 100,
      };
      state.fallbackClearTimer = setTimeout(() => undefined, 1_000);
      state.sessionsResult = {
        ts: 0,
        path: "",
        count: 1,
        defaults: {},
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            status: "running",
            startedAt: 100,
          },
        ],
      };
      const payload: ChatEventPayload = {
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: createTextChatMessage("assistant", "Live reply"),
      };

      expect(handleChatGatewayEvent(state, payload)).toBe("final");

      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
      expect(state.chatStreamStartedAt).toBeNull();
      expect(state.compactionStatus).toBeNull();
      expect(state.compactionClearTimer).toBeNull();
      expect(state.fallbackStatus).toBeNull();
      expect(state.fallbackClearTimer).toBeNull();
      expect(state.chatRunStatus).toMatchObject({
        phase: "done",
        runId: "run-1",
        sessionKey: "main",
      });
      expect(state.sessionsResult.sessions[0]).toMatchObject({
        hasActiveRun: false,
        status: "done",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish Done while a yielded turn has registered continuation work", () => {
    vi.useFakeTimers();
    try {
      const state = createState({
        sessionKey: "main",
        chatRunId: "run-1",
        chatStream: "Restarting now",
        chatStreamStartedAt: 100,
      }) as ChatState & {
        chatRunStatus?: unknown;
        sessionsResult?: {
          ts: number;
          path: string;
          count: number;
          defaults: Record<string, unknown>;
          sessions: Array<Record<string, unknown>>;
        };
      };
      state.sessionsResult = {
        ts: 0,
        path: "",
        count: 1,
        defaults: {},
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            status: "running",
            startedAt: 100,
          },
        ],
      };

      expect(
        handleChatGatewayEvent(state, {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          stopReason: "end_turn",
          yielded: true,
          message: createTextChatMessage(
            "assistant",
            "The gateway will restart; I will resume verification afterward.",
          ),
        }),
      ).toBe("final");

      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
      expect(state.chatRunStatus).toBeNull();
      expect(state.sessionsResult.sessions[0]).toMatchObject({
        hasActiveRun: false,
        activeRunIds: [],
        status: "running",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not infer pending continuation from end_turn without yielded metadata", () => {
    vi.useFakeTimers();
    try {
      const state = createState({
        sessionKey: "main",
        chatRunId: "run-1",
        chatStream: "Final response",
      }) as ChatState & {
        chatRunStatus?: { phase?: string } | null;
      };

      expect(
        handleChatGatewayEvent(state, {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          stopReason: "end_turn",
          message: createTextChatMessage("assistant", "Final response"),
        }),
      ).toBe("final");

      expect(state.chatRunStatus?.phase).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not suppress completion for stale yielded metadata on another stop reason", () => {
    vi.useFakeTimers();
    try {
      const state = createState({
        sessionKey: "main",
        chatRunId: "run-1",
        chatStream: "Final response",
      }) as ChatState & {
        chatRunStatus?: { phase?: string } | null;
      };

      expect(
        handleChatGatewayEvent(state, {
          runId: "run-1",
          sessionKey: "main",
          state: "final",
          stopReason: "completed",
          yielded: true,
          message: createTextChatMessage("assistant", "Final response"),
        }),
      ).toBe("final");

      expect(state.chatRunStatus?.phase).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still drops events when neither session key nor active run id matches", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Working...",
    });
    const payload: ChatEventPayload = {
      runId: "run-2",
      sessionKey: "agent:main:main",
      state: "delta",
      message: createTextChatMessage("assistant", "Wrong run"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("returns null for delta from another run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    };
    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Hello");
  });

  it("ignores NO_REPLY delta updates", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Hello");
  });

  it("appends final payload from another run without clearing active stream", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "Sub-agent findings"),
    };
    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(payload.message);
  });

  it("drops NO_REPLY final payload from another run without clearing active stream", () => {
    const state = createActiveStreamingState();
    const payload = createOtherRunNoReplyFinalPayload();

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("drops HEARTBEAT_OK final payload from another run without clearing active stream", () => {
    const state = createActiveStreamingState();
    const payload = createOtherRunSilentFinalPayload("HEARTBEAT_OK");

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toStrictEqual([]);
  });

  it.each(["no_reply", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "keeps plain-text %s final payload from another run without clearing active stream",
    (text) => {
      const state = createActiveStreamingState();
      const payload = createOtherRunSilentFinalPayload(text);

      expect(handleChatGatewayEvent(state, payload)).toBe(null);
      expect(state.chatRunId).toBe("run-user");
      expect(state.chatStream).toBe("Working...");
      expect(state.chatStreamStartedAt).toBe(123);
      expect(state.chatMessages).toEqual([payload.message]);
    },
  );

  it("ignores HEARTBEAT_OK delta updates", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Previous visible text",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Previous visible text");
  });

  it("replaces the stream when a delta snapshot gets shorter", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Alpha beta",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      message: createTextChatMessage("assistant", "Alpha"),
    };
    expect(handleChatGatewayEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Alpha");
  });

  it("returns final for another run when payload has no message", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("keeps active stream for unowned final payloads", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = {
      sessionKey: "main",
      state: "final",
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("keeps active stream while appending unowned assistant finals", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = {
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "Injected note"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toEqual([payload.message]);
  });

  it.each(["aborted", "error"] as const)(
    "keeps active stream for unowned %s payloads",
    (terminalState) => {
      const state = createActiveStreamingState();
      const payload: ChatEventPayload = {
        sessionKey: "main",
        state: terminalState,
      };

      expect(handleChatGatewayEvent(state, payload)).toBe(null);
      expect(state.chatRunId).toBe("run-user");
      expect(state.chatStream).toBe("Working...");
      expect(state.chatStreamStartedAt).toBe(123);
      expect(state.chatMessages).toStrictEqual([]);
    },
  );

  it("persists streamed text when final event carries no message", () => {
    const existingMessage = createTextChatMessage("user", "Hi", undefined, 1);
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Here is my reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    const assignments = trackChatMessagesAssignments(state);

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(assignments).toMatchObject([{ chatRunId: "run-1", chatStream: "Here is my reply" }]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expectTextChatMessage(state.chatMessages[1], "assistant", "Here is my reply");
  });

  it("does not persist empty or whitespace-only stream on final", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "   ",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("does not persist null stream on final with no message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: null,
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("prefers final payload message over streamed text", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Streamed partial",
      chatStreamStartedAt: 100,
    });
    const finalMsg = createTextChatMessage("assistant", "Complete reply", undefined, 101);
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: finalMsg,
    };
    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([finalMsg]);
    expect(state.chatStream).toBe(null);
  });

  it("keeps repeated assistant final text from a later turn", () => {
    const firstUser = createTextChatMessage("user", "first", undefined, 1);
    const firstAssistant = createTextChatMessage("assistant", "OK", undefined, 2);
    const secondUser = createTextChatMessage("user", "second", undefined, 3);
    const secondAssistant = createTextChatMessage("assistant", "OK", undefined, 4);
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-2",
      chatMessages: [firstUser, firstAssistant, secondUser],
    });
    const payload: ChatEventPayload = {
      runId: "run-2",
      sessionKey: "main",
      state: "final",
      message: secondAssistant,
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([firstUser, firstAssistant, secondUser, secondAssistant]);
  });

  it("keeps repeated assistant final text within the same turn", () => {
    const user = createTextChatMessage("user", "repeat", undefined, 1);
    const firstAssistant = createTextChatMessage("assistant", "OK", undefined, 2);
    const secondAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "OK" },
        { type: "canvas", url: "/__openclaw__/canvas/documents/repeat/index.html" },
      ],
      timestamp: 3,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [user, firstAssistant],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: secondAssistant,
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([user, firstAssistant, secondAssistant]);
  });

  it("appends final payload message from own run before clearing stream state", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Reply",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "Reply", undefined, 101),
    };
    const assignments = trackChatMessagesAssignments(state);

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(assignments).toMatchObject([{ chatRunId: "run-1", chatStream: "Reply" }]);
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("keeps pre-final stream segments when final payload is renderable", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: null,
      chatStreamStartedAt: null,
    }) as ChatState & { chatStreamSegments: Array<{ text: string; ts: number }> };
    state.chatStreamSegments = [{ text: "before tool", ts: 1 }];
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "source reply final", undefined, 101),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(2);
    expectTextChatMessage(state.chatMessages[0], "assistant", "before tool");
    expect(state.chatMessages[1]).toEqual(payload.message);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamSegments).toEqual([]);
  });

  it.each([
    {
      name: "processes aborted from own run and keeps partial assistant message",
      stream: "Partial reply",
      message: createTextChatMessage("assistant", "Partial reply", undefined, 2),
      expectedText: "Partial reply",
      preservePayload: true,
      trackAssignments: true,
    },
    {
      name: "falls back to streamed partial when aborted payload message is invalid",
      stream: "Partial reply",
      message: "not-an-assistant-message",
      expectedText: "Partial reply",
    },
    {
      name: "falls back to streamed partial when aborted payload has non-assistant role",
      stream: "Partial reply",
      message: createTextChatMessage("user", "unexpected"),
      expectedText: "Partial reply",
    },
    {
      name: "processes aborted from own run without message and empty stream",
      stream: "",
    },
  ])("$name", ({ stream, message, expectedText, preservePayload, trackAssignments }) => {
    const existing = createTextChatMessage("user", "Hi", undefined, 1);
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: stream,
      chatStreamStartedAt: 100,
      chatMessages: [existing],
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      ...(message === undefined ? {} : { message }),
    } as unknown as ChatEventPayload;
    const assignments = trackAssignments ? trackChatMessagesAssignments(state) : undefined;

    expect(handleChatGatewayEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatMessages[0]).toEqual(existing);
    expect(state.chatMessages).toHaveLength(expectedText ? 2 : 1);
    if (expectedText) {
      expectTextChatMessage(state.chatMessages[1], "assistant", expectedText);
    }
    if (preservePayload) {
      expect(state.chatMessages[1]).toEqual(message);
    }
    if (assignments) {
      expect(assignments.at(-1)).toMatchObject({
        chatRunId: "run-1",
        chatStream: stream,
      });
    }
  });
  type TerminalErrorFixture = {
    stream?: string | null;
    previous?: ReturnType<typeof createTextChatMessage>[];
    segments?: Array<{ text: string; ts: number; toolCallId?: string }>;
    message?: Record<string, unknown>;
    error: string;
    expected: Array<readonly ["assistant" | "user", string]>;
    verify?: (state: ChatState) => void;
  };

  it.each([
    {
      name: "keeps error events outside the assistant transcript",
      create(): TerminalErrorFixture {
        const error = 'No API key found for provider "openai".';
        return {
          previous: [createTextChatMessage("user", "Ping", undefined, 1)],
          message: createTextChatMessage("assistant", `Error: ${error}`, undefined, 10),
          error,
          expected: [["user", "Ping"]],
        };
      },
    },
    {
      name: "keeps streamed assistant text visible when an error ends the run",
      create(): TerminalErrorFixture {
        return {
          previous: [createTextChatMessage("user", "Ping", undefined, 1)],
          stream: "Partial answer before gateway error.",
          error: "gateway disconnected",
          expected: [
            ["user", "Ping"],
            ["assistant", "Partial answer before gateway error."],
          ],
        };
      },
    },
    {
      name: "keeps streamed text without appending the error payload message",
      create(): TerminalErrorFixture {
        return {
          stream: "Partial answer before gateway error.",
          message: {
            ...createTextChatMessage("assistant", "Error: gateway disconnected", undefined, 101),
            metadata: { source: "gateway" },
          },
          error: "gateway disconnected",
          expected: [["assistant", "Partial answer before gateway error."]],
        };
      },
    },
    {
      name: "uses the gateway error when the payload message repeats the streamed text",
      create(): TerminalErrorFixture {
        const text = "Partial answer before gateway error.";
        return {
          stream: text,
          message: createTextChatMessage("assistant", text, undefined, 101),
          error: "gateway disconnected",
          expected: [["assistant", text]],
        };
      },
    },
    {
      name: "preserves terminal assistant content that extends the streamed text",
      create(): TerminalErrorFixture {
        const text = "Partial answer before gateway error. Final detail.";
        return {
          stream: "Partial answer before gateway error.",
          message: createTextChatMessage("assistant", text, undefined, 101),
          error: "gateway disconnected",
          expected: [["assistant", text]],
        };
      },
    },
    {
      name: "preserves streamed text before a differing terminal assistant message",
      create(): TerminalErrorFixture {
        const terminal = createTextChatMessage(
          "assistant",
          "Configure provider auth, then try again.",
          undefined,
          101,
        );
        return {
          stream: "Partial answer before gateway error.",
          message: terminal,
          error: "gateway disconnected",
          expected: [
            ["assistant", "Partial answer before gateway error."],
            ["assistant", "Configure provider auth, then try again."],
          ],
          verify: (state) => expect(state.chatMessages[1]).toEqual(terminal),
        };
      },
    },
    {
      name: "preserves terminal extensions after a tool splits the stream",
      create(): TerminalErrorFixture {
        const text = "First thought. After tool. Final detail.";
        return {
          stream: "After tool.",
          segments: [{ text: "First thought.", ts: 90, toolCallId: "call-1" }],
          message: createTextChatMessage("assistant", text, undefined, 101),
          error: "gateway disconnected",
          expected: [["assistant", text]],
        };
      },
    },
    {
      name: "preserves a split stream when the terminal message only overlaps its prefix",
      create(): TerminalErrorFixture {
        const terminal = createTextChatMessage(
          "assistant",
          "First thought. Configure provider auth.",
          undefined,
          101,
        );
        return {
          stream: "After tool.",
          segments: [{ text: "First thought.", ts: 90, toolCallId: "call-1" }],
          message: terminal,
          error: "gateway disconnected",
          expected: [
            ["assistant", "First thought."],
            ["assistant", "After tool."],
            ["assistant", "First thought. Configure provider auth."],
          ],
          verify: (state) => expect(state.chatMessages[2]).toEqual(terminal),
        };
      },
    },
    {
      name: "preserves terminal extensions when split stream punctuation is adjacent",
      create(): TerminalErrorFixture {
        return {
          stream: ", world",
          segments: [{ text: "Hello", ts: 90, toolCallId: "call-1" }],
          message: createTextChatMessage("assistant", "Hello, world!", undefined, 101),
          error: "gateway disconnected",
          expected: [["assistant", "Hello, world!"]],
        };
      },
    },
    {
      name: "keeps stream segments visible when an error ends after a tool event",
      create(): TerminalErrorFixture {
        return {
          previous: [createTextChatMessage("user", "Ping", undefined, 1)],
          stream: null,
          segments: [{ text: "Visible text before tool.", ts: 100 }],
          error: "gateway disconnected",
          expected: [
            ["user", "Ping"],
            ["assistant", "Visible text before tool."],
          ],
        };
      },
    },
    {
      name: "does not let a substring-matching error projection replace streamed text",
      create(): TerminalErrorFixture {
        return {
          stream: "OK",
          message: createTextChatMessage(
            "assistant",
            "Error: provider said NOT OK yet",
            undefined,
            101,
          ),
          error: "provider said NOT OK yet",
          expected: [["assistant", "OK"]],
        };
      },
    },
    {
      name: "keeps the post-tool stream tail without appending the error projection",
      create(): TerminalErrorFixture {
        return {
          stream: "First thought. After tool.",
          segments: [{ text: "First thought.", ts: 90 }],
          message: createTextChatMessage(
            "assistant",
            "Error: gateway disconnected",
            undefined,
            101,
          ),
          error: "gateway disconnected",
          expected: [
            ["assistant", "First thought."],
            ["assistant", "After tool."],
          ],
        };
      },
    },
    {
      name: "does not append legacy assistant-shaped error projections",
      create(): TerminalErrorFixture {
        return {
          message: createTextChatMessage("assistant", "Error: raw gateway error", undefined, 10),
          error: "raw gateway error",
          expected: [],
          verify: (state) => expect(state.lastError).toBeNull(),
        };
      },
    },
  ])("$name", (fixture) => {
    const { stream, previous, segments, message, error, expected, verify } = fixture.create();
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      ...(previous ? { chatMessages: previous } : {}),
      ...(stream === undefined
        ? {}
        : { chatStream: stream, chatStreamStartedAt: stream ? 100 : null }),
    }) as ChatState & { chatStreamSegments?: TerminalErrorFixture["segments"] };
    if (segments) {
      state.chatStreamSegments = segments;
    }
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: error,
      ...(message ? { message } : {}),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("error");
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatMessages).toHaveLength(expected.length);
    for (const [index, [role, text]] of expected.entries()) {
      expectTextChatMessage(state.chatMessages[index], role, text);
    }
    expect(state.chatRunError).toEqual({ summary: `Error: ${error}` });
    verify?.(state);
  });
  it.each([
    "Error: the configuration uses an unsupported field.",
    "⚠️ This operation may require additional review.",
  ])("preserves message-only terminal output beginning with %s", (text) => {
    const state = createState({ sessionKey: "main", chatRunId: "run-1" });
    const message = createTextChatMessage("assistant", text, undefined, 10);

    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      message,
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([message]);
    expect(state.lastError).toBeNull();
    expect(state.chatRunError).toEqual({ summary: "chat error" });
  });

  it("preserves a legacy terminal message that completes streamed assistant content", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial answer",
      chatStreamStartedAt: 9,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      message: createTextChatMessage("assistant", "Partial answer. Final detail.", undefined, 10),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toHaveLength(1);
    expectTextChatMessage(state.chatMessages[0], "assistant", "Partial answer. Final detail.");
    expect(state.chatRunError).toEqual({ summary: "chat error" });
  });

  it("preserves a differing terminal message instead of classifying it as an error projection", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
    });
    const message = createTextChatMessage(
      "assistant",
      "⚠️ Configure provider auth, then try again.",
      undefined,
      10,
    );
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "raw gateway error",
      message,
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([message]);
    expect(state.lastError).toBeNull();
    expect(state.chatRunError).toEqual({ summary: "Error: raw gateway error" });
  });

  it("uses server guidance when an error follows a source-reply final", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
    });

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: createTextChatMessage("assistant", "Source reply delivered.", undefined, 9),
      }),
    ).toBe("final");
    expect(state.chatRunId).toBeNull();

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: "error",
        errorMessage: "raw provider failure",
        message: createTextChatMessage(
          "assistant",
          "Configure provider auth, then try again.",
          undefined,
          10,
        ),
      }),
    ).toBe("error");
    expect(state.chatMessages).toHaveLength(1);
    expectTextChatMessage(state.chatMessages[0], "assistant", "Source reply delivered.");
    expect(state.chatRunError).toEqual({ summary: "Error: raw provider failure" });
  });

  it("does not append an orphan error bubble when no run was active", () => {
    const existingMessage = createTextChatMessage(
      "assistant",
      "Error: request failed before start",
      undefined,
      1,
    );
    const state = createState({
      sessionKey: "main",
      chatRunId: null,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-failed-before-start",
      sessionKey: "main",
      state: "error",
      errorMessage: "request failed before start",
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([existingMessage]);
    expect(state.chatRunId).toBe(null);
    expect(state.lastError).toBeNull();
    expect(state.chatRunError).toEqual({ summary: "Error: request failed before start" });
  });

  it("uses the generic alert fallback for a blank orphan error", () => {
    const state = createState({ sessionKey: "main", chatRunId: null });

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-failed-before-start",
        sessionKey: "main",
        state: "error",
        errorMessage: "   ",
      }),
    ).toBe("error");
    expect(state.chatMessages).toEqual([]);
    expect(state.lastError).toBeNull();
    expect(state.chatRunError).toEqual({ summary: "chat error" });
  });

  it("drops NO_REPLY final payload from another run", () => {
    const state = createActiveStreamingState();
    const payload = createOtherRunNoReplyFinalPayload();

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toStrictEqual([]);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
  });

  it("drops NO_REPLY final payload from own run", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("assistant", "NO_REPLY"),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toStrictEqual([]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
  });

  it.each(["no_reply", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "keeps plain-text %s final payload from own run",
    (text) => {
      const state = createState({
        sessionKey: "main",
        chatRunId: "run-1",
        chatStream: text,
        chatStreamStartedAt: 100,
      });
      const payload: ChatEventPayload = {
        runId: "run-1",
        sessionKey: "main",
        state: "final",
        message: createTextChatMessage("assistant", text),
      };

      expect(handleChatGatewayEvent(state, payload)).toBe("final");
      expect(state.chatMessages).toEqual([payload.message]);
      expect(state.chatRunId).toBe(null);
      expect(state.chatStream).toBe(null);
    },
  );

  it("does not persist NO_REPLY stream text on final without message", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("does not persist NO_REPLY stream text on abort", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatGatewayEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("keeps user messages containing NO_REPLY text", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-user",
      chatStream: "Working...",
      chatStreamStartedAt: 123,
    });
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
      message: createTextChatMessage("user", "NO_REPLY"),
    };

    // User messages with NO_REPLY text should NOT be filtered — only assistant messages.
    // normalizeFinalAssistantMessage returns null for user role, so this falls through.
    expect(handleChatGatewayEvent(state, payload)).toBe("final");
  });

  it("keeps assistant message when text field has real reply but content is NO_REPLY", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        text: "real reply",
        content: "NO_REPLY",
      },
    };

    // entry.text takes precedence — "real reply" is NOT silent, so the message is kept.
    expect(handleChatGatewayEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(1);
  });
});
describe("loadChatHistory filtering", () => {
  it("filters legacy silent assistant messages from history", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
      { role: "assistant", content: [{ type: "text", text: "no_reply" }] },
      { role: "assistant", content: [{ type: "text", text: "ANNOUNCE_SKIP" }] },
      { role: "assistant", content: [{ type: "text", text: "REPLY_SKIP" }] },
      { role: "assistant", content: [{ type: "text", text: "Real answer" }] },
      { role: "assistant", text: "  NO_REPLY  " },
    ];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages, thinkingLevel: "low", verboseLevel: "full" }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(5);
    expect(state.chatMessages[0]).toEqual(messages[0]);
    expect(state.chatMessages[1]).toEqual(messages[2]);
    expect(state.chatMessages[2]).toEqual(messages[3]);
    expect(state.chatMessages[3]).toEqual(messages[4]);
    expect(state.chatMessages[4]).toEqual(messages[5]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatVerboseLevel).toBe("full");
    expect(state.chatLoading).toBe(false);
  });

  it("keeps assistant message when text field has real content but content is NO_REPLY", async () => {
    const messages = [{ role: "assistant", text: "real reply", content: "NO_REPLY" }];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    // text takes precedence — "real reply" is NOT silent, so message is kept.
    expect(state.chatMessages).toHaveLength(1);
  });

  it("filters the synthetic transcript-repair tool result from history", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "unknown",
        isError: true,
        content: [
          {
            type: "text",
            text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "shell",
        content: [{ type: "text", text: "real tool output" }],
      },
    ];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([messages[0], messages[2]]);
  });

  it("keeps image-only user messages that carry transcript media facts", async () => {
    const messages = [
      {
        role: "user",
        content: "",
        __openclaw: { media: [{ path: "/tmp/openclaw/user-upload.png" }] },
      },
      {
        role: "user",
        content: "",
        __openclaw: {
          media: [{ path: "/tmp/openclaw/first.png" }, { path: "/tmp/openclaw/second.jpg" }],
        },
      },
      { role: "user", content: "" },
    ];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([messages[0], messages[1]]);
  });

  it("keeps a user message even if it matches the synthetic repair text", async () => {
    const messages = [
      createTextChatMessage(
        "user",
        "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      ),
    ];
    const mockClient = {
      request: vi.fn().mockResolvedValue({ messages }),
    };
    const state = createState({
      client: mockClient as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual(messages);
  });

  it("applies current session metadata from chat history", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      sessionId: "legacy-session",
      thinkingLevel: "low",
      verboseLevel: "full",
      sessionInfo: {
        activeLeafEntryId: "leaf-rendered",
        key: "main",
        sessionId: "session-main",
        effectiveQueueMode: "interrupt",
        queueMode: "interrupt",
        thinkingLevel: "medium",
        modelProvider: "openai",
        model: "gpt-5",
        updatedAt: 123,
      },
    });
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
    });

    const result = await loadChatHistory(state);

    expect(result?.sessionInfo?.sessionId).toBe("session-main");
    expect(state.currentSessionId).toBe("session-main");
    expect(state.chatDisplayedLeafEntryId).toBe("leaf-rendered");
    expect(state.chatThinkingLevel).toBe("medium");
    expect(state.chatVerboseLevel).toBe("full");
    expect(state.chatQueueModeOverride).toBe("interrupt");
    expect(state.chatEffectiveQueueMode).toBe("interrupt");
  });

  it("preserves the displayed leaf when history metadata is not authoritative for it", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      sessionInfo: {
        key: "main",
        sessionId: "session-main",
        updatedAt: 123,
      },
    });
    const state = createState({
      chatDisplayedLeafEntryId: "leaf-from-tail",
      client: { request } as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(state.chatDisplayedLeafEntryId).toBe("leaf-from-tail");
  });

  it("omits literal global agentId until selected/default agent is known", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [] });
    const state = createState({
      sessionKey: "global",
      client: { request } as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
  });

  it("uses hello default agent for literal global history before agents list loads", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [] });
    const state = createState({
      sessionKey: "global",
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        snapshot: { sessionDefaults: { defaultAgentId: "ops" } },
      },
      client: { request } as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: "global", agentId: "ops" }),
    );
  });

  it("caches global history under the selected agent only", async () => {
    const messages = [{ role: "assistant", content: [{ type: "text", text: "work history" }] }];
    const request = vi.fn().mockResolvedValue({ messages });
    const state = createState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessagesBySession: new Map(),
      client: { request } as unknown as ChatState["client"],
      connected: true,
    });

    await loadChatHistory(state);

    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual(messages);
    expect(state.chatMessagesBySession?.has("agent:main:main")).toBe(false);
  });

  it("loads startup history with agents in one request", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }],
      agentsList: {
        agents: [{ id: "ops", name: "Ops" }],
        defaultId: "ops",
        mainKey: "main",
        scope: "agent",
      },
    });
    const state = createState({
      agentsError: "previous agents.list failure",
      client: { request } as unknown as ChatState["client"],
      connected: true,
      sessionKey: "global",
    });

    await loadChatHistory(state, { startup: true });

    expect(request).toHaveBeenCalledWith("chat.startup", {
      sessionKey: "global",
      limit: 100,
    });
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "ready" }] },
    ]);
    expect(state.agentsError).toBeNull();
    expect(state.agentsList?.defaultId).toBe("ops");
    expect(state.agentsSelectedId).toBe("ops");
  });

  it("falls back to chat.history when startup history is not advertised", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [] });
    const state = createState({
      client: { request } as unknown as ChatState["client"],
      connected: true,
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        features: { methods: ["chat.history"], events: [] },
      },
    });

    await loadChatHistory(state, { startup: true });

    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      limit: 100,
    });
  });
});

describe("chat send Gateway requests", () => {
  it("clears reconnect resume when history returns a different backing session", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "session-after-reconnect",
      messages: [],
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      reconnectResumeSessionId: "session-before-reconnect",
    });

    await loadChatHistory(state);

    expect(state.currentSessionId).toBe("session-after-reconnect");
    expect(state.reconnectResumeSessionId).toBeNull();
  });
});

describe("loadChatHistory retry handling", () => {
  it("falls back to chat.history when chat.startup is unknown", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: chat.startup",
        }),
      )
      .mockResolvedValueOnce({
        messages: [{ role: "assistant", content: [{ type: "text", text: "fallback" }] }],
      });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state, { startup: true });

    expect(request).toHaveBeenNthCalledWith(1, "chat.startup", {
      sessionKey: "main",
      limit: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "chat.history", {
      sessionKey: "main",
      limit: 100,
    });
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "fallback" }] },
    ]);
  });

  it("retries retryable startup unavailability before showing history", async () => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn()
        .mockRejectedValueOnce(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "chat.history unavailable during gateway startup",
            details: { method: "chat.history" },
            retryable: true,
            retryAfterMs: 250,
          }),
        )
        .mockResolvedValueOnce({
          messages: [{ role: "assistant", content: [{ type: "text", text: "awake" }] }],
          thinkingLevel: "low",
        });
      const state = createState({
        connected: true,
        client: { request } as unknown as ChatState["client"],
      });

      const load = loadChatHistory(state);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(state.chatLoading).toBe(true);
      expect(state.lastError).toBeNull();

      await vi.advanceTimersByTimeAsync(250);
      await load;

      expect(request).toHaveBeenCalledTimes(2);
      expect(state.chatMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "awake" }] },
      ]);
      expect(state.chatThinkingLevel).toBe("low");
      expect(state.chatLoading).toBe(false);
      expect(state.lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters assistant NO_REPLY messages and keeps user NO_REPLY messages", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
        { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
        { role: "user", content: [{ type: "text", text: "NO_REPLY" }] },
      ],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      limit: 100,
    });
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
      { role: "user", content: [{ type: "text", text: "NO_REPLY" }] },
    ]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
    expect(state.lastError).toBeNull();
  });

  it("filters heartbeat acknowledgements and internal-only user messages", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
        createTextChatMessage(
          "user",
          [
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "subagent completion payload",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        ),
        { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
      ],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible answer" }] },
    ]);
  });

  type HistoryReconciliationFixture = {
    history: unknown[];
    visible: unknown[];
    expected: unknown[];
    state?: Partial<ChatState>;
    response?: Record<string, unknown>;
    verify?: (state: ChatState) => void;
  };

  it.each([
    {
      name: "keeps local optimistic tail messages when history reload returns a stale snapshot",
      create(): HistoryReconciliationFixture {
        const persisted = createTextChatMessage("user", "first", { seq: 1 });
        const user = createTextChatMessage("user", "latest ask", undefined, 10);
        const assistant = createTextChatMessage("assistant", "latest answer", undefined, 11);
        return {
          history: [persisted],
          visible: [persisted, user, assistant],
          expected: [persisted, user, assistant],
          response: { thinkingLevel: "low" },
          verify: (state) => expect(state.chatStream).toBeNull(),
        };
      },
    },
    {
      name: "keeps a newly sent repeated user message when history reload is still stale",
      create(): HistoryReconciliationFixture {
        const first = createTextChatMessage(
          "user",
          "continue",
          { id: "first-user-message", idempotencyKey: "first-run:user", seq: 1 },
          10,
        );
        const pending = createTextChatMessage(
          "user",
          "continue",
          { idempotencyKey: "second-run:user" },
          20,
        );
        return { history: [first], visible: [first, pending], expected: [first, pending] };
      },
    },
    {
      name: "preserves a distinct pending turn after an earlier repeated-history anchor",
      create(): HistoryReconciliationFixture {
        const first = createTextChatMessage("user", "continue", { seq: 1 });
        const second = createTextChatMessage("user", "continue", { seq: 2 });
        const pending = createTextChatMessage("user", "a distinct pending turn", {
          idempotencyKey: "third-run:user",
        });
        return {
          history: [first, second],
          visible: [first, pending],
          expected: [first, second, pending],
        };
      },
    },
    {
      name: "does not revive an unmatched pending turn beyond unrelated history",
      create(): HistoryReconciliationFixture {
        const shared = createTextChatMessage("user", "shared earlier turn", {
          id: "shared-user",
          seq: 1,
        });
        const later = createTextChatMessage("user", "different authoritative turn", {
          id: "later-user",
          seq: 2,
        });
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return { history: [shared, later], visible: [shared, pending], expected: [shared, later] };
      },
    },
    {
      name: "does not adopt an imported message through a colliding native transcript id",
      create(): HistoryReconciliationFixture {
        const native = createTextChatMessage("user", "native transcript", {
          id: "source-local-id",
        });
        const imported = createTextChatMessage("user", "imported transcript", {
          id: "source-local-id",
          externalId: "source-local-id",
          importedFrom: "claude-cli",
          cliSessionId: "imported-session",
        });
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return {
          history: [native, imported],
          visible: [native, pending],
          expected: [native, imported],
        };
      },
    },
    {
      name: "does not guess an imported source identity when its session is missing",
      create(): HistoryReconciliationFixture {
        const imported = () =>
          createTextChatMessage("user", "repeated imported turn", {
            id: "source-local-id",
            externalId: "source-local-id",
            importedFrom: "claude-cli",
          });
        const first = imported();
        const second = imported();
        const previous = imported();
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return {
          history: [first, second],
          visible: [previous, pending],
          expected: [first, second],
        };
      },
    },
    {
      name: "does not anchor a missing canonical id to another same-sequence projection",
      create(): HistoryReconciliationFixture {
        const unrelated = createTextChatMessage("user", "different sequence projection", {
          seq: 7,
        });
        const previous = createTextChatMessage("user", "original sequence projection", {
          id: "missing-canonical-id",
          seq: 7,
        });
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return { history: [unrelated], visible: [previous, pending], expected: [unrelated] };
      },
    },
    {
      name: "does not adopt import provenance lacking an external id as a native row",
      create(): HistoryReconciliationFixture {
        const native = createTextChatMessage("user", "native transcript", {
          id: "source-local-id",
        });
        const imported = createTextChatMessage("user", "imported transcript", {
          id: "source-local-id",
          importedFrom: "claude-cli",
          cliSessionId: "imported-session",
        });
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return {
          history: [native, imported],
          visible: [native, pending],
          expected: [native, imported],
        };
      },
    },
    {
      name: "does not use matching display text to adopt an incomplete imported source",
      create(): HistoryReconciliationFixture {
        const previous = createTextChatMessage("user", "repeated imported turn", {
          externalId: "first-import",
          importedFrom: "claude-cli",
        });
        const other = createTextChatMessage("user", "repeated imported turn", {
          externalId: "different-import",
          importedFrom: "claude-cli",
        });
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return { history: [other], visible: [previous, pending], expected: [other] };
      },
    },
    {
      name: "does not drop a canonical id for a same-text sequence projection",
      create(): HistoryReconciliationFixture {
        const unrelated = createTextChatMessage("user", "repeated projection", { seq: 7 });
        const previous = createTextChatMessage("user", "repeated projection", {
          id: "missing-canonical-id",
          seq: 7,
        });
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return { history: [unrelated], visible: [previous, pending], expected: [unrelated] };
      },
    },
    {
      name: "does not revive an identity-free tail after a distinct repeated history turn",
      create(): HistoryReconciliationFixture {
        const first = createTextChatMessage("user", "continue", { id: "first-user", seq: 1 });
        const second = createTextChatMessage("user", "continue", { id: "second-user", seq: 2 });
        const pending = createTextChatMessage("user", "identity-free pending turn");
        return { history: [first, second], visible: [first, pending], expected: [first, second] };
      },
    },
    {
      name: "does not reconcile native legacy history with an imported display match",
      create(): HistoryReconciliationFixture {
        const native = createTextChatMessage("user", "same visible turn", {
          senderId: "native-user",
        });
        const imported = createTextChatMessage("user", "same visible turn", {
          externalId: "external-user",
          importedFrom: "claude-cli",
          cliSessionId: "external-session",
        });
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return { history: [imported], visible: [native, pending], expected: [imported] };
      },
    },
    {
      name: "does not replay an optimistic send already persisted before the history anchor",
      create(): HistoryReconciliationFixture {
        const user = createTextChatMessage("user", "already persisted prompt", {
          id: "persisted-user",
          seq: 1,
          idempotencyKey: "persisted-run:user",
        });
        const assistant = createTextChatMessage("assistant", "already persisted answer", {
          id: "persisted-assistant",
          seq: 2,
        });
        const pending = createTextChatMessage("user", "already persisted prompt", {
          idempotencyKey: "persisted-run:user",
        });
        return {
          history: [user, assistant],
          visible: [user, assistant, pending],
          expected: [user, assistant],
        };
      },
    },
    {
      name: "does not cross unrelated signature-free history markers",
      create(): HistoryReconciliationFixture {
        const first = {
          content: [{ type: "status", value: "first marker" }],
          __openclaw: { id: "first-marker", seq: 1 },
        };
        const later = {
          content: [{ type: "status", value: "different marker" }],
          __openclaw: { id: "later-marker", seq: 2 },
        };
        const pending = createTextChatMessage("user", "unmatched pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return { history: [first, later], visible: [first, pending], expected: [first, later] };
      },
    },
    {
      name: "does not duplicate repeated history without an echoed send identity",
      create(): HistoryReconciliationFixture {
        const first = createTextChatMessage("user", "continue", { id: "first-user", seq: 1 });
        const repeated = createTextChatMessage("user", "continue", {
          id: "persisted-repeated-user",
          seq: 2,
        });
        const pending = createTextChatMessage("user", "continue", {
          idempotencyKey: "repeated-run:user",
        });
        return {
          history: [first, repeated],
          visible: [first, pending],
          expected: [first, repeated],
        };
      },
    },
    {
      name: "does not revive an assistant after its user was persisted before the anchor",
      create(): HistoryReconciliationFixture {
        const user = createTextChatMessage("user", "already persisted prompt", {
          id: "persisted-user",
          seq: 1,
          idempotencyKey: "persisted-run:user",
        });
        const assistant = createTextChatMessage("assistant", "already persisted answer", {
          id: "persisted-assistant",
          seq: 2,
        });
        const pendingUser = createTextChatMessage("user", "already persisted prompt", {
          idempotencyKey: "persisted-run:user",
        });
        const pendingAssistant = createTextChatMessage("assistant", "stale streamed assistant");
        return {
          history: [user, assistant],
          visible: [user, assistant, pendingUser, pendingAssistant],
          expected: [user, assistant],
        };
      },
    },
    {
      name: "preserves a distinct repeated send when the earlier anchor has different text",
      create(): HistoryReconciliationFixture {
        const setup = createTextChatMessage("user", "setup", {
          id: "setup-user",
          seq: 1,
          idempotencyKey: "setup-run:user",
        });
        const second = createTextChatMessage("user", "continue", {
          id: "second-user",
          seq: 2,
          idempotencyKey: "second-run:user",
        });
        const third = createTextChatMessage("user", "continue", {
          idempotencyKey: "third-run:user",
        });
        return {
          history: [setup, second],
          visible: [setup, third],
          expected: [setup, second, third],
        };
      },
    },
    {
      name: "keeps a new repeated prompt after a different same-text turn reaches history",
      create(): HistoryReconciliationFixture {
        const first = createTextChatMessage("user", "continue", {
          id: "first-user",
          idempotencyKey: "first-run:user",
          seq: 1,
        });
        const second = createTextChatMessage("user", "continue", {
          id: "second-user",
          idempotencyKey: "second-run:user",
          seq: 2,
        });
        const pending = createTextChatMessage("user", "continue", {
          idempotencyKey: "third-run:user",
        });
        const stream = {
          chatRunId: "third-run",
          chatStream: "Still working on the third turn.",
          chatStreamStartedAt: 100,
        };
        return {
          history: [first, second],
          visible: [first, pending],
          expected: [first, second, pending],
          state: stream,
          verify: (state) => expect(state).toMatchObject(stream),
        };
      },
    },
    {
      name: "reconciles repeated imported messages using the complete external source identity",
      create(): HistoryReconciliationFixture {
        const imported = (cliSessionId: string) =>
          createTextChatMessage("user", "continue", {
            id: "shared-external-id",
            externalId: "shared-external-id",
            importedFrom: "claude-cli",
            cliSessionId,
          });
        const first = imported("first-session");
        const second = imported("second-session");
        const pending = createTextChatMessage("user", "continue");
        return { history: [first, second], visible: [first, pending], expected: [first, second] };
      },
    },
    {
      name: "does not invent an anchor for ambiguous identity-free repeated history",
      create(): HistoryReconciliationFixture {
        const legacy = () => createTextChatMessage("user", "continue", { senderId: "alice" });
        const first = legacy();
        const second = legacy();
        const previous = legacy();
        const pending = createTextChatMessage("user", "unproven pending turn", {
          idempotencyKey: "pending-run:user",
        });
        return {
          history: [first, second],
          visible: [previous, pending],
          expected: [first, second],
        };
      },
    },
    {
      name: "does not attach a current optimistic turn to an unrelated older snapshot",
      create(): HistoryReconciliationFixture {
        const older = createTextChatMessage("user", "older snapshot", { id: "older-user", seq: 1 });
        const current = createTextChatMessage("user", "current snapshot", {
          id: "current-user",
          seq: 2,
        });
        const pending = createTextChatMessage("user", "pending on the current snapshot", {
          idempotencyKey: "pending-run:user",
        });
        return { history: [older], visible: [current, pending], expected: [older] };
      },
    },
    {
      name: "never restores a hidden optimistic assistant during history reconciliation",
      create(): HistoryReconciliationFixture {
        const user = createTextChatMessage("user", "visible prompt", {
          id: "visible-user",
          seq: 1,
        });
        const hidden = createTextChatMessage("assistant", "NO_REPLY");
        return { history: [user], visible: [user, hidden], expected: [user] };
      },
    },
    {
      name: "keeps active streamed assistant text when history reload returns a stale snapshot",
      create(): HistoryReconciliationFixture {
        const persisted = createTextChatMessage("user", "first", { seq: 1 });
        const pending = createTextChatMessage("user", "latest ask", undefined, 10);
        const stream = {
          chatRunId: "run-1",
          chatStream: "First visible stream text.",
          chatStreamStartedAt: 100,
        };
        return {
          history: [persisted],
          visible: [persisted, pending],
          expected: [persisted, pending],
          state: stream,
          response: { thinkingLevel: "low" },
          verify: (state) => expect(state).toMatchObject(stream),
        };
      },
    },
  ])("$name", async (fixture) => {
    const { history, visible, expected, state: overrides, response, verify } = fixture.create();
    const request = vi.fn().mockResolvedValue({ messages: history, ...response });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: visible,
      ...overrides,
    });

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith("chat.history", { sessionKey: "main", limit: 100 });
    expect(state.chatMessages).toEqual(expected);
    verify?.(state);
  });
  type HistoryToolSegment = { text: string; ts: number; toolCallId?: string };
  type RecoveredToolFixture = {
    tools: Record<string, unknown>[];
    persistedCount: number;
    segments: HistoryToolSegment[];
    stream: string;
    expectedRows: Array<number | { text: string; timestamp: number }>;
    expectedStream: string;
    remainingTools?: number[];
    remainingSegments?: HistoryToolSegment[];
  };

  const historyTool = (id: string, text: string, timestamp: number, seq: number) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "shell",
    content: [{ type: "text", text }],
    timestamp,
    __openclaw: { seq },
  });

  it.each([
    {
      name: "clears live tool cards when history catches up before assistant text",
      create(): RecoveredToolFixture {
        return {
          tools: [historyTool("call_1", "tool output", 2, 2)],
          persistedCount: 1,
          segments: [{ text: "before tool", ts: 1 }],
          stream: "Still answering.",
          expectedRows: [{ text: "before tool", timestamp: 1 }, 0],
          expectedStream: "Still answering.",
        };
      },
    },
    {
      name: "inserts multiple recovered stream segments before their matching persisted tools",
      create(): RecoveredToolFixture {
        return {
          tools: [
            historyTool("call_1", "first output", 2, 2),
            historyTool("call_2", "second output", 4, 3),
          ],
          persistedCount: 2,
          segments: [
            { text: "before first tool", ts: 1 },
            { text: "before first tool\nbefore second tool", ts: 3 },
          ],
          stream: "Still answering.",
          expectedRows: [
            { text: "before first tool", timestamp: 1 },
            0,
            { text: "before second tool", timestamp: 3 },
            1,
          ],
          expectedStream: "Still answering.",
        };
      },
    },
    {
      name: "prunes only the live tool cards that history has caught up with",
      create(): RecoveredToolFixture {
        return {
          tools: [
            historyTool("call_1", "first output", 2, 2),
            {
              role: "assistant",
              toolCallId: "call_2",
              runId: "run-1",
              content: [
                { type: "toolcall", name: "shell", arguments: {} },
                { type: "toolresult", name: "shell", text: "second output" },
              ],
              timestamp: 4,
            },
          ],
          persistedCount: 1,
          segments: [
            { text: "before first tool", ts: 1, toolCallId: "call_1" },
            { text: "before first tool\nbefore second tool", ts: 3, toolCallId: "call_2" },
          ],
          stream: "before first tool\nbefore second tool\nStill answering.",
          expectedRows: [{ text: "before first tool", timestamp: 1 }, 0],
          expectedStream: "Still answering.",
          remainingTools: [1],
          remainingSegments: [{ text: "before second tool", ts: 3, toolCallId: "call_2" }],
        };
      },
    },
    {
      name: "uses segment tool ids when a tool starts before any stream text",
      create(): RecoveredToolFixture {
        return {
          tools: [
            historyTool("call_1", "first output", 2, 2),
            historyTool("call_2", "second output", 4, 3),
          ],
          persistedCount: 2,
          segments: [{ text: "before second tool", ts: 3, toolCallId: "call_2" }],
          stream: "Still answering.",
          expectedRows: [0, { text: "before second tool", timestamp: 3 }, 1],
          expectedStream: "Still answering.",
        };
      },
    },
    {
      name: "trims accumulated current stream after materializing caught-up tool segments",
      create(): RecoveredToolFixture {
        return {
          tools: [historyTool("call_1", "tool output", 2, 2)],
          persistedCount: 1,
          segments: [{ text: "before tool", ts: 1, toolCallId: "call_1" }],
          stream: "before tool\nafter tool",
          expectedRows: [{ text: "before tool", timestamp: 1 }, 0],
          expectedStream: "after tool",
        };
      },
    },
  ])("$name", async (fixture) => {
    const {
      tools,
      persistedCount,
      segments,
      stream,
      expectedRows,
      expectedStream,
      remainingTools = [],
      remainingSegments = [],
    } = fixture.create();
    const persistedUser = createTextChatMessage("user", "latest ask", { seq: 1 });
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, ...tools.slice(0, persistedCount)],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: "run-1",
      chatStream: stream,
      chatStreamStartedAt: 100,
    }) as ChatState & {
      chatStreamSegments: HistoryToolSegment[];
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = segments;
    state.chatToolMessages = tools;
    state.toolStreamById = new Map(
      tools.map((tool) => [String(tool.toolCallId), { message: tool }]),
    );
    state.toolStreamOrder = tools.map((tool) => String(tool.toolCallId));
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(expectedRows.length + 1);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    for (const [index, row] of expectedRows.entries()) {
      if (typeof row === "number") {
        expect(state.chatMessages[index + 1]).toEqual(tools[row]);
      } else {
        expectTextChatMessage(state.chatMessages[index + 1], "assistant", row.text);
        expect(requireRecord(state.chatMessages[index + 1]).timestamp).toBe(row.timestamp);
      }
    }
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe(expectedStream);
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual(remainingTools.map((index) => tools[index]));
    expect(state.chatStreamSegments).toEqual(remainingSegments);
    expect(state.toolStreamById.size).toBe(remainingTools.length);
    expect(state.toolStreamOrder).toEqual(
      remainingTools.map((index) => String(tools[index]?.toolCallId)),
    );
    for (const index of remainingTools) {
      expect(state.toolStreamById.has(String(tools[index]?.toolCallId))).toBe(true);
    }
  });
  it("keeps live tool cards when only older history has a persisted tool result", async () => {
    const olderUser = createTextChatMessage("user", "older ask", { seq: 1 });
    const olderToolResult = {
      role: "toolResult",
      toolCallId: "call_old",
      toolName: "shell",
      content: [{ type: "text", text: "old tool output" }],
      __openclaw: { seq: 2 },
    };
    const latestUser = createTextChatMessage("user", "latest ask", { seq: 3 });
    const liveToolMessage = {
      role: "assistant",
      toolCallId: "call_current",
      runId: "run-1",
      content: [{ type: "toolcall", name: "shell", arguments: {} }],
    };
    const request = vi.fn().mockResolvedValue({
      messages: [olderUser, olderToolResult, latestUser],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [olderUser, olderToolResult, latestUser],
      chatRunId: "run-1",
      chatStream: "Still answering.",
      chatStreamStartedAt: 100,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [{ text: "before current tool", ts: 1 }];
    state.chatToolMessages = [liveToolMessage];
    state.toolStreamById = new Map([["call_current", { message: liveToolMessage }]]);
    state.toolStreamOrder = ["call_current"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([olderUser, olderToolResult, latestUser]);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe("Still answering.");
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual([liveToolMessage]);
    expect(state.chatStreamSegments).toEqual([{ text: "before current tool", ts: 1 }]);
    expect(state.toolStreamById.size).toBe(1);
    expect(state.toolStreamOrder).toEqual(["call_current"]);
  });

  it("clears live tool cards when history catches up with content-block tool ids", async () => {
    const persistedUser = createTextChatMessage("user", "latest ask", { seq: 1 });
    const persistedToolCall = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "shell",
          arguments: {},
        },
      ],
      timestamp: 2,
      __openclaw: { seq: 2 },
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, persistedToolCall],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: "run-1",
      chatStream: "Still answering.",
      chatStreamStartedAt: 100,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [{ text: "before tool", ts: 1 }];
    state.chatToolMessages = [
      {
        role: "assistant",
        toolCallId: "call_1",
        runId: "run-1",
        content: [{ type: "toolcall", name: "shell", arguments: {} }],
      },
    ];
    state.toolStreamById = new Map([["call_1", { message: state.chatToolMessages[0] }]]);
    state.toolStreamOrder = ["call_1"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(state.chatMessages[1], "assistant", "before tool");
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(1);
    expect(state.chatMessages[2]).toEqual(persistedToolCall);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe("Still answering.");
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("keeps segment-only streamed text when history catches up with tools", async () => {
    const persistedUser = createTextChatMessage("user", "latest ask", { seq: 1 });
    const persistedToolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "shell",
      content: [{ type: "text", text: "tool output" }],
      timestamp: 2,
      __openclaw: { seq: 2 },
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, persistedToolResult],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: "run-1",
      chatStream: null,
      chatStreamStartedAt: 100,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [{ text: "before tool", ts: 1 }];
    state.chatToolMessages = [persistedToolResult];
    state.toolStreamById = new Map([["call_1", { message: persistedToolResult }]]);
    state.toolStreamOrder = ["call_1"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(state.chatMessages[1], "assistant", "before tool");
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(1);
    expect(state.chatMessages[2]).toEqual(persistedToolResult);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("materializes orphaned streamed assistant text when history reload is stale", async () => {
    const persistedUser = createTextChatMessage("user", "first", { seq: 1 });
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: null,
      chatStream: "Partial answer before history catch-up.",
      chatStreamStartedAt: 100,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(
      state.chatMessages[1],
      "assistant",
      "Partial answer before history catch-up.",
    );
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });

  it("timestamps materialized streamed text after the persisted user prompt", async () => {
    const persistedUser = createTextChatMessage("user", "first", { seq: 1 }, 200);
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: null,
      chatStream: "Partial answer before history catch-up.",
      chatStreamStartedAt: 100,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(
      state.chatMessages[1],
      "assistant",
      "Partial answer before history catch-up.",
    );
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(201);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });

  it("materializes orphaned segment-only assistant text before clearing caught-up tools", async () => {
    const persistedUser = createTextChatMessage("user", "latest ask", { seq: 1 });
    const persistedToolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "shell",
      content: [{ type: "text", text: "tool output" }],
      __openclaw: { seq: 2 },
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, persistedToolResult],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [{ text: "before tool", ts: 1 }];
    state.chatToolMessages = [persistedToolResult];
    state.toolStreamById = new Map([["call_1", { message: persistedToolResult }]]);
    state.toolStreamOrder = ["call_1"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(state.chatMessages[1], "assistant", "before tool");
    expect(state.chatMessages[2]).toEqual(persistedToolResult);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("clears streamed assistant text when history already contains the replacement", async () => {
    const persistedUser = createTextChatMessage("user", "latest ask", { seq: 1 });
    const historyAssistant = createTextChatMessage(
      "assistant",
      "First visible stream text. More final text.",
      { seq: 2 },
    );
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, historyAssistant],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: "run-1",
      chatStream: "First visible stream text.",
      chatStreamStartedAt: 100,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([persistedUser, historyAssistant]);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });

  it("keeps live tool cards when history only replaces streamed text", async () => {
    const persistedUser = createTextChatMessage("user", "latest ask", { seq: 1 });
    const historyAssistant = createTextChatMessage(
      "assistant",
      "First visible stream text. More final text.",
      { seq: 2 },
    );
    const liveToolMessage = {
      role: "assistant",
      toolCallId: "call_current",
      runId: "run-1",
      content: [{ type: "toolcall", name: "shell", arguments: {} }],
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, historyAssistant],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: "run-1",
      chatStream: "First visible stream text.",
      chatStreamStartedAt: 100,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [{ text: "First visible stream text.", ts: 90 }];
    state.chatToolMessages = [liveToolMessage];
    state.toolStreamById = new Map([["call_current", { message: liveToolMessage }]]);
    state.toolStreamOrder = ["call_current"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([persistedUser, historyAssistant]);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatToolMessages).toEqual([liveToolMessage]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(1);
    expect(state.toolStreamOrder).toEqual(["call_current"]);
  });

  it("keeps local optimistic messages when history reload returns empty", async () => {
    const optimisticUser = createTextChatMessage("user", "first ask", undefined, 10);
    const optimisticAssistant = createTextChatMessage("assistant", "first answer", undefined, 11);
    const request = vi.fn().mockResolvedValue({
      messages: [],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [optimisticUser, optimisticAssistant],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([optimisticUser, optimisticAssistant]);
    expect(state.chatStream).toBeNull();
  });

  it("does not duplicate optimistic tail messages after history catches up", async () => {
    const optimisticUser = createTextChatMessage("user", "latest ask", undefined, 10);
    const historyUser = createTextChatMessage("user", "latest ask", { seq: 1 });
    const historyAssistant = createTextChatMessage("assistant", "latest answer", { seq: 2 });
    const request = vi.fn().mockResolvedValue({
      messages: [historyUser, historyAssistant],
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [optimisticUser],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([historyUser, historyAssistant]);
  });

  it("shows a targeted message when chat history is unauthorized", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "PERMISSION_DENIED",
        message: "not allowed",
        details: { code: "AUTH_UNAUTHORIZED" },
      }),
    );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [{ role: "assistant", content: [{ type: "text", text: "old" }] }],
      chatThinkingLevel: "high",
      chatVerboseLevel: "full",
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toStrictEqual([]);
    expect(state.chatThinkingLevel).toBeNull();
    expect(state.chatVerboseLevel).toBeNull();
    expect(state.lastError).toBe(
      "This connection is missing operator.read, so existing chat history cannot be loaded yet.",
    );
    expect(state.chatLoading).toBe(false);
  });

  it("coalesces duplicate in-flight history loads for the selected session", async () => {
    const history = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const request = vi.fn(() => history.promise);
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const firstLoad = loadChatHistory(state);
    const secondLoad = loadChatHistory(state);

    expect(request).toHaveBeenCalledTimes(1);
    history.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }],
      thinkingLevel: "low",
    });
    await firstLoad;
    await secondLoad;

    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "ready" }] },
    ]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("preserves a first send appended while the startup history request is in flight", async () => {
    const history = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const request = vi.fn(() => history.promise);
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const load = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const optimisticMessage = createTextChatMessage(
      "user",
      "send before history settles",
      undefined,
      123,
    );
    state.chatMessages = [optimisticMessage];
    state.chatRunId = "run-after-history-start";
    state.chatStream = "";
    state.chatStreamStartedAt = 456;

    history.resolve({ messages: [], thinkingLevel: "low" });
    await load;

    expect(state.chatMessages).toEqual([optimisticMessage]);
    expect(state.chatRunId).toBe("run-after-history-start");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamStartedAt).toBe(456);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("preserves late assistant messages when startup history only catches up to the user turn", async () => {
    const history = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const request = vi.fn(() => history.promise);
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const load = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const userMessage = createTextChatMessage(
      "user",
      "send before history settles",
      undefined,
      123,
    );
    const assistantMessage = createTextChatMessage(
      "assistant",
      "answer before history catches up",
      undefined,
      456,
    );
    state.chatMessages = [userMessage, assistantMessage];

    history.resolve({ messages: [userMessage], thinkingLevel: "low" });
    await load;

    expect(state.chatMessages).toEqual([userMessage, assistantMessage]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("keeps repeated late prompts when startup history only has an older matching prompt", async () => {
    const history = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const request = vi.fn(() => history.promise);
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const load = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const repeatedPrompt = createTextChatMessage("user", "continue", undefined, 200);
    state.chatMessages = [repeatedPrompt];

    history.resolve({
      messages: [createTextChatMessage("user", "continue", undefined, 100)],
      thinkingLevel: "low",
    });
    await load;

    expect(state.chatMessages).toEqual([
      createTextChatMessage("user", "continue", undefined, 100),
      repeatedPrompt,
    ]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("starts a fresh same-session history load after local messages change", async () => {
    const staleRequest = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const freshRequest = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise);
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const staleLoad = loadChatHistory(state);
    state.chatMessages = [{ role: "user", content: [{ type: "text", text: "new local ask" }] }];
    const freshLoad = loadChatHistory(state);

    expect(request).toHaveBeenCalledTimes(2);
    staleRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "old history" }] }],
    });
    await staleLoad;
    expect(state.chatMessages).toEqual([
      { role: "user", content: [{ type: "text", text: "new local ask" }] },
    ]);

    freshRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "fresh history" }] }],
    });
    await freshLoad;
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "fresh history" }] },
    ]);
  });

  it("rejects stale success and cleanup after a same-client reconnect", async () => {
    const staleRequest = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const freshRequest = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise);
    const client = { request } as unknown as NonNullable<ChatState["client"]>;
    const visibleMessage = createTextChatMessage("assistant", "visible before reconnect");
    const state = createState({
      chatMessages: [visibleMessage],
      client,
      connected: true,
      connectionEpoch: 1,
    });

    const staleLoad = loadChatHistory(state);
    state.connected = false;
    state.connectionEpoch = 2;
    state.connected = true;
    state.connectionEpoch = 3;
    const freshLoad = loadChatHistory(state);

    expect(request).toHaveBeenCalledTimes(2);
    staleRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "stale history" }] }],
      thinkingLevel: "high",
    });
    await staleLoad;

    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(state.chatThinkingLevel).toBeNull();
    expect(state.chatLoading).toBe(true);

    freshRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "fresh history" }] }],
      thinkingLevel: "low",
    });
    await freshLoad;

    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "fresh history" }] },
    ]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("rejects stale errors and cleanup after a same-client reconnect", async () => {
    const staleRequest = createDeferred<{ messages: Array<unknown> }>();
    const request = vi.fn(() => staleRequest.promise);
    const client = { request } as unknown as NonNullable<ChatState["client"]>;
    const state = createState({
      client,
      connected: true,
      connectionEpoch: 1,
    });

    const staleLoad = loadChatHistory(state);
    state.connected = false;
    state.connectionEpoch = 2;
    state.connected = true;
    state.connectionEpoch = 3;
    // The connection owner has already prepared the new epoch. The stale
    // finalizer must not clear its loading state.
    state.chatLoading = true;
    staleRequest.reject(new Error("stale history failure"));
    await staleLoad;

    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(state.chatLoading).toBe(true);
  });

  it("ignores stale history responses after switching sessions", async () => {
    const mainRequest = createDeferred<{
      messages: Array<unknown>;
      thinkingLevel?: string;
      verboseLevel?: string;
    }>();
    const otherRequest = createDeferred<{
      messages: Array<unknown>;
      thinkingLevel?: string;
      verboseLevel?: string;
    }>();
    const request = vi.fn((_method: string, params?: { sessionKey?: string }) => {
      if (params?.sessionKey === "main") {
        return mainRequest.promise;
      }
      if (params?.sessionKey === "other") {
        return otherRequest.promise;
      }
      throw new Error(`Unexpected sessionKey: ${String(params?.sessionKey)}`);
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [{ role: "assistant", content: [{ type: "text", text: "visible old" }] }],
    });

    const firstLoad = loadChatHistory(state);
    state.sessionKey = "other";
    const secondLoad = loadChatHistory(state);

    mainRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "main history" }] }],
      thinkingLevel: "high",
      verboseLevel: "full",
    });
    await firstLoad;

    expect(state.chatLoading).toBe(true);
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible old" }] },
    ]);
    expect(state.chatThinkingLevel).toBeNull();
    expect(state.chatVerboseLevel).toBeNull();

    otherRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "other history" }] }],
      thinkingLevel: "low",
      verboseLevel: "full",
    });
    await secondLoad;

    expect(state.chatLoading).toBe(false);
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "other history" }] },
    ]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatVerboseLevel).toBe("full");
  });

  it("ignores stale global history responses after switching selected agents", async () => {
    const workRequest = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const request = vi.fn((_method: string, params?: { agentId?: string; sessionKey?: string }) => {
      if (params?.sessionKey === "global" && params.agentId === "work") {
        return workRequest.promise;
      }
      throw new Error(`Unexpected request: ${JSON.stringify(params)}`);
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessages: [{ role: "assistant", content: [{ type: "text", text: "visible old" }] }],
    });

    const load = loadChatHistory(state);
    state.assistantAgentId = "main";
    workRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "work history" }] }],
      thinkingLevel: "high",
    });
    await load;

    expect(state.chatLoading).toBe(false);
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible old" }] },
    ]);
    expect(state.chatThinkingLevel).toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
