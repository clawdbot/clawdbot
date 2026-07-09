// Control UI tests cover chat behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerChatAttachmentPayload,
  resetChatAttachmentPayloadStoreForTest,
} from "./attachment-payload-store.ts";
import {
  handleChatEvent,
  handleChatGatewayEvent,
  handleChatSideResultGatewayEvent,
  type ChatEventPayload,
} from "./chat-gateway.ts";
import { GatewayRequestError, loadChatHistory, type ChatState } from "./chat-history.ts";
import {
  requestChatSend,
  requestSkillWorkshopRevisionChatSend,
  sendDetachedChatMessage,
  sendSteerChatMessage,
} from "./chat-send.ts";
import { abortChatRun } from "./run-lifecycle.ts";

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
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set<string>(),
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

afterEach(() => {
  resetChatAttachmentPayloadStoreForTest();
});

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

function requireFirstRequestCall(request: ReturnType<typeof vi.fn>): unknown[] {
  const [call] = request.mock.calls;
  if (!call) {
    throw new Error("Expected client request call");
  }
  return call;
}

function createStartedChatSendAck(params: unknown) {
  const requestParams = requireRecord(params);
  const runId = requestParams.idempotencyKey;
  if (typeof runId !== "string") {
    throw new Error("Expected chat.send idempotencyKey");
  }
  return { runId, status: "started" as const };
}

function expectTextChatMessage(message: unknown, role: string, text: string): void {
  const record = requireRecord(message);
  expect(record.role).toBe(role);
  expect(record.content).toEqual([{ type: "text", text }]);
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
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function createOtherRunNoReplyFinalPayload(): ChatEventPayload {
  return createOtherRunSilentFinalPayload("NO_REPLY");
}

describe("chat side result gateway events", () => {
  it("stores BTW side results for the active session", () => {
    const state = createState();

    expect(
      handleChatSideResultGatewayEvent(state, {
        kind: "btw",
        runId: "btw-run-1",
        sessionKey: "main",
        question: "what changed?",
        text: "Only the UI layer was missing support.",
        ts: 123,
      }),
    ).toBe(true);

    expect(state.chatSideResult).toMatchObject({
      kind: "btw",
      runId: "btw-run-1",
      sessionKey: "main",
      question: "what changed?",
      text: "Only the UI layer was missing support.",
    });
    expect(state.chatSideResultTerminalRuns?.has("btw-run-1")).toBe(true);
  });

  it("stores selected-global BTW side results for agent main aliases", () => {
    const state = createState({
      sessionKey: "agent:work:main",
      agentsList: { defaultId: "main" },
    });

    expect(
      handleChatSideResultGatewayEvent(state, {
        kind: "btw",
        runId: "btw-work-global",
        sessionKey: "global",
        agentId: "work",
        question: "what changed?",
        text: "The alias receives canonical global side results.",
        ts: 123,
      }),
    ).toBe(true);

    expect(state.chatSideResult).toMatchObject({
      kind: "btw",
      runId: "btw-work-global",
      sessionKey: "global",
      agentId: "work",
      text: "The alias receives canonical global side results.",
    });
    expect(state.chatSideResultTerminalRuns?.has("btw-work-global")).toBe(true);
  });

  it("ignores selected-global BTW side results from another agent", () => {
    const state = createState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    expect(
      handleChatSideResultGatewayEvent(state, {
        kind: "btw",
        runId: "btw-main-global",
        sessionKey: "global",
        agentId: "main",
        question: "what changed?",
        text: "This belongs to another selected agent.",
        ts: 123,
      }),
    ).toBe(false);

    expect(state.chatSideResult).toBeNull();
    expect(state.chatSideResultTerminalRuns?.has("btw-main-global")).toBe(false);
  });

  it("ignores tracked BTW terminal events without touching the active run", () => {
    const state = createState({
      chatRunId: "main-run-1",
      chatStream: "still streaming",
      chatMessages: [{ role: "assistant", content: [{ type: "text", text: "existing" }] }],
    });
    state.chatSideResultTerminalRuns?.add("btw-run-2");

    expect(
      handleChatGatewayEvent(state, {
        runId: "btw-run-2",
        sessionKey: "main",
        state: "final",
      }),
    ).toBe(null);

    expect(state.chatSideResultTerminalRuns?.has("btw-run-2")).toBe(false);
    expect(state.chatRunId).toBe("main-run-1");
    expect(state.chatStream).toBe("still streaming");
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "existing" }] },
    ]);
    expect(state.lastError).toBeNull();
  });
});

describe("handleChatEvent", () => {
  it("returns null when payload is missing", () => {
    const state = createState();
    expect(handleChatEvent(state, undefined)).toBe(null);
  });

  it("returns null when sessionKey does not match and no active run is in flight", () => {
    const state = createState({ sessionKey: "main" });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe(null);
  });

  it("caches final messages for a switched-away session", () => {
    const visibleMessage = {
      role: "assistant",
      content: [{ type: "text", text: "main visible" }],
    };
    const state = createState({
      sessionKey: "main",
      chatMessages: [visibleMessage],
      chatMessagesBySession: new Map(),
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "other",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "other final" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(state.chatMessagesBySession?.get("agent:main:other")).toEqual([payload.message]);
  });

  it.each([
    {
      name: "canonical default-session finals under the main alias",
      activeSessionKey: "agent:main:other",
      payloadSessionKey: "agent:main:main",
      cacheKey: "agent:main:main",
      withConfiguredDefaults: false,
    },
    {
      name: "configured default-session finals under runtime aliases",
      activeSessionKey: "agent:ops:other",
      payloadSessionKey: "agent:ops:home",
      cacheKey: "agent:ops:main",
      withConfiguredDefaults: true,
    },
    {
      name: "canonical non-main finals under the plain session key",
      activeSessionKey: "main",
      payloadSessionKey: "agent:main:project",
      cacheKey: "agent:main:project",
      withConfiguredDefaults: false,
    },
  ])(
    "caches $name",
    ({ activeSessionKey, payloadSessionKey, cacheKey, withConfiguredDefaults }) => {
      const state = createState({ sessionKey: activeSessionKey, chatMessagesBySession: new Map() });
      const payload: ChatEventPayload = {
        runId: "run-1",
        sessionKey: payloadSessionKey,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "cached final" }],
        },
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

      expect(handleChatEvent(state, payload)).toBe(null);
      expect(state.chatMessagesBySession?.get(cacheKey)).toEqual([payload.message]);
      expect(state.chatMessagesBySession?.size).toBe(1);
    },
  );

  it("caches inactive global finals under the payload agent only", () => {
    const visibleMessage = {
      role: "assistant",
      content: [{ type: "text", text: "work visible" }],
    };
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "main final" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(state.chatMessagesBySession?.get("agent:main:main")).toEqual([payload.message]);
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Observed reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
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

    expect(handleChatEvent(state, payload)).toBe(null);
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

    expect(handleChatEvent(state, payload)).toBe(null);
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

    expect(handleChatEvent(state, payload)).toBe(null);
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Work reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Live reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Live reply");
    expect(state.chatRunId).toBe("run-1");
  });

  it("appends gateway deltaText when the cumulative snapshot matches the current prefix", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Live",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: " reply",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Live reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Live reply");
  });

  it("uses the cumulative snapshot when the first observed delta joins mid-stream", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: null,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: " reply",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Live reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Live reply");
  });

  it("appends gateway deltaText when no full message snapshot is present", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Live",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: " reply",
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Live reply");
  });

  it("uses the cumulative snapshot when a missed delta would make append stale", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Hello",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: "!",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world!" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Hello world!");
  });

  it("uses the cumulative snapshot when a same-length missed replacement changes the prefix", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "AB",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: "E",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "CDE" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("CDE");
  });

  it("replaces the stream when gateway deltaText marks a replacement", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Alpha beta",
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      deltaText: "Alpha",
      replace: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ignored snapshot" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Alpha");
  });

  it("adopts the run id for selected-session live deltas observed from another channel", () => {
    const state = createState({
      sessionKey: "agent:main:feishu:direct:peer-1",
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
    });
    const payload: ChatEventPayload = {
      runId: "run-feishu-1",
      sessionKey: "agent:main:feishu:direct:peer-1",
      state: "delta",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Observed reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatRunId).toBe("run-feishu-1");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Canonical reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("delta");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Live reply" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
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

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
  });

  it("clears keyed commentary with the final answer by default", () => {
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer." }],
        timestamp: 5,
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(2);
    expectTextChatMessage(state.chatMessages[0], "user", "Ask");
    expectTextChatMessage(state.chatMessages[1], "assistant", "Final answer.");
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("persists keyed commentary alongside the final answer when chatPersistCommentary is true", () => {
    const user = { role: "user", content: [{ type: "text", text: "Ask" }], timestamp: 1 };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [user],
      chatStream: null,
      chatStreamStartedAt: null,
      settings: { chatPersistCommentary: true },
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
    state.chatStreamSegments = [{ text: "Looking into it.", ts: 2, itemId: "preamble-1" }];
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer." }],
        timestamp: 5,
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(3);
    expectTextChatMessage(state.chatMessages[0], "user", "Ask");
    expectTextChatMessage(state.chatMessages[1], "assistant", "Looking into it.");
    expectTextChatMessage(state.chatMessages[2], "assistant", "Final answer.");
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
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Live reply" }],
        },
      };

      expect(handleChatEvent(state, payload)).toBe("final");

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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Wrong run" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe(null);
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
    expect(handleChatEvent(state, payload)).toBe(null);
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

    expect(handleChatEvent(state, payload)).toBe("delta");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Sub-agent findings" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe(null);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(payload.message);
  });

  it("drops NO_REPLY final payload from another run without clearing active stream", () => {
    const state = createActiveStreamingState();
    const payload = createOtherRunNoReplyFinalPayload();

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("drops HEARTBEAT_OK final payload from another run without clearing active stream", () => {
    const state = createActiveStreamingState();
    const payload = createOtherRunSilentFinalPayload("HEARTBEAT_OK");

    expect(handleChatEvent(state, payload)).toBe("final");
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

      expect(handleChatEvent(state, payload)).toBe(null);
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

    expect(handleChatEvent(state, payload)).toBe("delta");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Alpha" }],
      },
    };
    expect(handleChatEvent(state, payload)).toBe("delta");
    expect(state.chatStream).toBe("Alpha");
  });

  it("returns final for another run when payload has no message", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = {
      runId: "run-announce",
      sessionKey: "main",
      state: "final",
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("keeps active stream for unowned final payloads", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = {
      sessionKey: "main",
      state: "final",
    };

    expect(handleChatEvent(state, payload)).toBe("final");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Injected note" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe(null);
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

      expect(handleChatEvent(state, payload)).toBe(null);
      expect(state.chatRunId).toBe("run-user");
      expect(state.chatStream).toBe("Working...");
      expect(state.chatStreamStartedAt).toBe(123);
      expect(state.chatMessages).toStrictEqual([]);
    },
  );

  it("persists streamed text when final event carries no message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
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

    expect(handleChatEvent(state, payload)).toBe("final");
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
    expect(handleChatEvent(state, payload)).toBe("final");
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
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("prefers final payload message over streamed text", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Streamed partial",
      chatStreamStartedAt: 100,
    });
    const finalMsg = {
      role: "assistant",
      content: [{ type: "text", text: "Complete reply" }],
      timestamp: 101,
    };
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      message: finalMsg,
    };
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([finalMsg]);
    expect(state.chatStream).toBe(null);
  });

  it("keeps repeated assistant final text from a later turn", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 1,
    };
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      timestamp: 2,
    };
    const secondUser = {
      role: "user",
      content: [{ type: "text", text: "second" }],
      timestamp: 3,
    };
    const secondAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      timestamp: 4,
    };
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

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([firstUser, firstAssistant, secondUser, secondAssistant]);
  });

  it("keeps repeated assistant final text within the same turn", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "repeat" }],
      timestamp: 1,
    };
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      timestamp: 2,
    };
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

    expect(handleChatEvent(state, payload)).toBe("final");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reply" }],
        timestamp: 101,
      },
    };
    const assignments = trackChatMessagesAssignments(state);

    expect(handleChatEvent(state, payload)).toBe("final");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "source reply final" }],
        timestamp: 101,
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toHaveLength(2);
    expectTextChatMessage(state.chatMessages[0], "assistant", "before tool");
    expect(state.chatMessages[1]).toEqual(payload.message);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("processes aborted from own run and keeps partial assistant message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Partial reply" }],
      timestamp: 2,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: partialMessage,
    };
    const assignments = trackChatMessagesAssignments(state);

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(assignments.at(-1)).toMatchObject({
      chatRunId: "run-1",
      chatStream: "Partial reply",
    });
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage, partialMessage]);
  });

  it("falls back to streamed partial when aborted payload message is invalid", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: "not-an-assistant-message",
    } as unknown as ChatEventPayload;

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expectTextChatMessage(state.chatMessages[1], "assistant", "Partial reply");
  });

  it("falls back to streamed partial when aborted payload has non-assistant role", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      message: {
        role: "user",
        content: [{ type: "text", text: "unexpected" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatMessages).toHaveLength(2);
    expectTextChatMessage(state.chatMessages[1], "assistant", "Partial reply");
  });

  it("processes aborted from own run without message and empty stream", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Hi" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
    };

    expect(handleChatEvent(state, payload)).toBe("aborted");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toEqual([existingMessage]);
  });

  it("appends visible assistant text for error events with an error message", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Ping" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: 'No API key found for provider "openai".',
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatRunId).toBe(null);
    expect(state.chatMessages).toHaveLength(2);
    expectTextChatMessage(
      state.chatMessages[1],
      "assistant",
      'Error: No API key found for provider "openai".',
    );
    expect(state.lastError).toBe('No API key found for provider "openai".');
  });

  it("keeps streamed assistant text visible when an error ends the run", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Ping" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [existingMessage],
      chatStream: "Partial answer before gateway error.",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "gateway disconnected",
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expectTextChatMessage(
      state.chatMessages[1],
      "assistant",
      "Partial answer before gateway error.",
    );
    expectTextChatMessage(state.chatMessages[2], "assistant", "Error: gateway disconnected");
    expect(state.lastError).toBe("gateway disconnected");
  });

  it("does not duplicate streamed text when the error payload already carries it", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer before gateway error." }],
      timestamp: 101,
      metadata: { source: "gateway" },
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial answer before gateway error.",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "gateway disconnected",
      message,
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([message]);
  });

  it("does not keep partial stream when the error payload contains the fuller text", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer before gateway error. Final detail." }],
      timestamp: 101,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "Partial answer before gateway error.",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "gateway disconnected",
      message,
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([message]);
  });

  it("keeps stream segments visible when an error ends after a tool event", () => {
    const existingMessage = {
      role: "user",
      content: [{ type: "text", text: "Ping" }],
      timestamp: 1,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatMessages: [existingMessage],
      chatStream: null,
      chatStreamStartedAt: null,
    }) as ChatState & { chatStreamSegments: Array<{ text: string; ts: number }> };
    state.chatStreamSegments = [{ text: "Visible text before tool.", ts: 100 }];
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "gateway disconnected",
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expectTextChatMessage(state.chatMessages[1], "assistant", "Visible text before tool.");
    expectTextChatMessage(state.chatMessages[2], "assistant", "Error: gateway disconnected");
  });

  it("does not treat substring matches as stream replacement", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Error: provider said NOT OK yet." }],
      timestamp: 101,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "OK",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "provider said NOT OK yet",
      message,
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toHaveLength(2);
    expectTextChatMessage(state.chatMessages[0], "assistant", "OK");
    expect(state.chatMessages[1]).toEqual(message);
  });

  it("does not duplicate post-tool stream tail when error payload has full text", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "First thought. After tool. Final detail." }],
      timestamp: 101,
    };
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "First thought. After tool.",
      chatStreamStartedAt: 100,
    }) as ChatState & { chatStreamSegments: Array<{ text: string; ts: number }> };
    state.chatStreamSegments = [{ text: "First thought.", ts: 90 }];
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "gateway disconnected",
      message,
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([message]);
  });

  it("prefers server-provided assistant error messages", () => {
    const state = createState({
      sessionKey: "main",
      chatRunId: "run-1",
    });
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Configure provider auth, then try again." }],
      timestamp: 10,
    };
    const payload: ChatEventPayload = {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      errorMessage: "raw gateway error",
      message,
    };

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([message]);
    expect(state.lastError).toBe("raw gateway error");
  });

  it("does not append an orphan error bubble when no run was active", () => {
    const existingMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Error: request failed before start" }],
      timestamp: 1,
    };
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

    expect(handleChatEvent(state, payload)).toBe("error");
    expect(state.chatMessages).toEqual([existingMessage]);
    expect(state.chatRunId).toBe(null);
    expect(state.lastError).toBe("request failed before start");
  });

  it("drops NO_REPLY final payload from another run", () => {
    const state = createActiveStreamingState();
    const payload = createOtherRunNoReplyFinalPayload();

    expect(handleChatEvent(state, payload)).toBe("final");
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
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    expect(handleChatEvent(state, payload)).toBe("final");
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
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      };

      expect(handleChatEvent(state, payload)).toBe("final");
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

    expect(handleChatEvent(state, payload)).toBe("final");
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

    expect(handleChatEvent(state, payload)).toBe("aborted");
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
      message: {
        role: "user",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
    };

    // User messages with NO_REPLY text should NOT be filtered — only assistant messages.
    // normalizeFinalAssistantMessage returns null for user role, so this falls through.
    expect(handleChatEvent(state, payload)).toBe("final");
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
    expect(handleChatEvent(state, payload)).toBe("final");
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

  it("keeps image-only user messages that carry transcript media paths", async () => {
    const messages = [
      { role: "user", content: "", MediaPath: "/tmp/openclaw/user-upload.png" },
      {
        role: "user",
        content: "",
        MediaPaths: ["/tmp/openclaw/first.png", "/tmp/openclaw/second.jpg"],
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
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
          },
        ],
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

    expect(state.chatMessages).toEqual(messages);
  });

  it("applies current session metadata from chat history", async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      sessionId: "legacy-session",
      thinkingLevel: "low",
      verboseLevel: "full",
      sessionInfo: {
        key: "main",
        sessionId: "session-main",
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
    expect(state.chatThinkingLevel).toBe("medium");
    expect(state.chatVerboseLevel).toBe("full");
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

    expect(state.chatMessagesBySession?.get("agent:work:main")).toEqual(messages);
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
  it("passes the backing session id from history without resume for ordinary sends", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "session-before-reconnect",
        messages: [],
      })
      .mockImplementationOnce((_method: string, params?: unknown) =>
        createStartedChatSendAck(params),
      );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);
    const result = await requestChatSend(state, {
      message: "continue",
      runId: "run-continue",
    });

    expect(result).toEqual({ runId: "run-continue", status: "started" });
    expect(state.currentSessionId).toBe("session-before-reconnect");
    const sendRequest = request.mock.calls[request.mock.calls.length - 1];
    expect(sendRequest?.[0]).toBe("chat.send");
    const sendParams = requireRecord(sendRequest?.[1]);
    expect(sendParams.sessionKey).toBe("main");
    expect(sendParams.sessionId).toBe("session-before-reconnect");
    expect(sendParams.resumeSession).toBeUndefined();
    expect(sendParams).not.toHaveProperty("__controlUiReconnectResume");
    expect(sendParams.message).toBe("continue");
  });

  it("sends reconnect resume once when the current session matches the reconnect marker", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-1", status: "started" });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      currentSessionId: "session-before-reconnect",
      reconnectResumeSessionId: "session-before-reconnect",
    });

    await requestChatSend(state, {
      message: "continue",
      runId: "run-1",
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        sessionId: "session-before-reconnect",
        __controlUiReconnectResume: true,
        message: "continue",
        idempotencyKey: "run-1",
      }),
    );
    expect(state.reconnectResumeSessionId).toBeNull();
  });

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

  it("does not reuse another global agent's visible session id for queued sends", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-work", status: "started" });
    const state = createState({
      assistantAgentId: "main",
      currentSessionId: "session-main-visible",
      sessionKey: "global",
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await requestChatSend(state, {
      message: "queued",
      runId: "run-work",
      sessionKey: "global",
      agentId: "work",
    });

    expect(result).toEqual({ runId: "run-work", status: "started" });
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        message: "queued",
        idempotencyKey: "run-work",
      }),
    );
    const sendParams = requireRecord(request.mock.calls[0]?.[1]);
    expect(sendParams.sessionId).toBeUndefined();
  });

  it("preserves optional Gateway ACK server timing metadata", async () => {
    const request = vi.fn().mockResolvedValue({
      runId: "run-timed",
      status: "started",
      serverTiming: {
        receivedToAckMs: 18.25,
        loadSessionMs: 4.5,
        prepareAttachmentsMs: 9,
        ignored: "nope",
      },
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await requestChatSend(state, {
      message: "queued",
      runId: "run-timed",
    });

    expect(result).toEqual({
      runId: "run-timed",
      status: "started",
      serverTiming: {
        receivedToAckMs: 18.25,
        loadSessionMs: 4.5,
        prepareAttachmentsMs: 9,
      },
    });
  });

  it("omits literal global send agentId until selected/default agent is known", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-global", status: "started" });
    const state = createState({
      sessionKey: "global",
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await requestChatSend(state, {
      message: "queued",
      runId: "run-global",
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
  });

  it("uses hello default agent for literal global sends before agents list loads", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-global", status: "started" });
    const state = createState({
      sessionKey: "global",
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        snapshot: { sessionDefaults: { defaultAgentId: "ops" } },
      },
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await requestChatSend(state, {
      message: "queued",
      runId: "run-global",
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ sessionKey: "global", agentId: "ops" }),
    );
  });

  it("requests Skill Workshop revisions with visible instructions and target agent routing", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-revision", status: "started" });
    const state = createState({
      sessionKey: "global",
      currentSessionId: "session-visible",
      assistantAgentId: "target",
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await requestSkillWorkshopRevisionChatSend(state, {
      proposalId: "support-file-sampler-20260531-68207b7b7f",
      agentId: "proposal-owner",
      targetAgentId: "target",
      instructions: "Make the support files 5",
      runId: "run-revision",
    });

    expect(result).toEqual({ runId: "run-revision", status: "started" });
    expect(request).toHaveBeenCalledWith("skills.proposals.requestRevision", {
      agentId: "proposal-owner",
      targetAgentId: "target",
      proposalId: "support-file-sampler-20260531-68207b7b7f",
      instructions: "Make the support files 5",
      sessionKey: "global",
      sessionId: "session-visible",
      idempotencyKey: "run-revision",
    });
  });

  it("preserves terminal timeout acks from Skill Workshop revision sends", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-revision", status: "timeout" });
    const state = createState({
      sessionKey: "global",
      currentSessionId: "session-visible",
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await requestSkillWorkshopRevisionChatSend(state, {
      proposalId: "support-file-sampler-20260531-68207b7b7f",
      instructions: "Make the support files 5",
      runId: "run-revision",
    });

    expect(result).toEqual({ runId: "run-revision", status: "timeout" });
  });

  it("preserves terminal failure acks from generated-run sends", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-detached", status: "error" });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await expect(sendDetachedChatMessage(state, "/btw summarize this")).resolves.toEqual({
      runId: "run-detached",
      status: "error",
    });
  });

  it("preserves terminal ok acks from generated-run steer sends", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-steer-ok", status: "ok" });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await expect(sendSteerChatMessage(state, "tighten the plan")).resolves.toEqual({
      runId: "run-steer-ok",
      status: "ok",
    });
  });

  it("serializes non-image chat attachments as files", async () => {
    const request = vi.fn((_method: string, params?: unknown) =>
      Promise.resolve(createStartedChatSendAck(params)),
    );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await requestChatSend(state, {
      message: "summarize",
      runId: "run-file",
      attachments: [
        {
          id: "att-1",
          dataUrl: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n").toString("base64")}`,
          mimeType: "application/pdf",
          fileName: "brief.pdf",
        },
      ],
    });

    expect(result).toEqual({ runId: "run-file", status: "started" });
    expect(request).toHaveBeenCalledTimes(1);
    const [requestMethod, requestParams] = requireFirstRequestCall(request);
    expect(requestMethod).toBe("chat.send");
    const sendParams = requireRecord(requestParams);
    expect(sendParams.message).toBe("summarize");
    expect(sendParams.attachments).toEqual([
      {
        type: "file",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        content: Buffer.from("%PDF-1.4\n").toString("base64"),
      },
    ]);
  });

  it("serializes attachments from the side payload store without copying data URLs into chat state", async () => {
    const request = vi.fn((_method: string, params?: unknown) =>
      Promise.resolve(createStartedChatSendAck(params)),
    );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });
    const pdfBytes = "%PDF-1.4\n";
    const file = new File([pdfBytes], "brief.pdf", { type: "application/pdf" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "att-side-store",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        sizeBytes: file.size,
      },
      dataUrl: `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`,
      file,
    });
    const previewUrl = attachment.previewUrl;
    expect(previewUrl).toMatch(/^blob:nodedata:/u);

    const result = await requestChatSend(state, {
      message: "summarize",
      runId: "run-side-store",
      attachments: [attachment],
    });

    expect(result).toEqual({ runId: "run-side-store", status: "started" });
    expect(request).toHaveBeenCalledTimes(1);
    const [requestMethod, requestParams] = requireFirstRequestCall(request);
    expect(requestMethod).toBe("chat.send");
    const sendParams = requireRecord(requestParams);
    const attachments = sendParams.attachments;
    expect(Array.isArray(attachments)).toBe(true);
    const [attachmentParam] = attachments as unknown[];
    const attachmentRecord = requireRecord(attachmentParam);
    expect(attachmentRecord.type).toBe("file");
    expect(attachmentRecord.content).toBe(Buffer.from(pdfBytes).toString("base64"));
    expect(JSON.stringify(state.chatMessages)).not.toContain(previewUrl);
  });

  it("sends inline image payloads without copying data URLs into chat state", async () => {
    const request = vi.fn((_method: string, params?: unknown) =>
      Promise.resolve(createStartedChatSendAck(params)),
    );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });
    const imageBase64 = "A".repeat(1024 * 1024);
    const imageDataUrl = `data:image/png;base64,${imageBase64}`;

    const result = await requestChatSend(state, {
      message: "",
      runId: "run-image",
      attachments: [
        {
          id: "att-image",
          dataUrl: imageDataUrl,
          mimeType: "image/png",
          fileName: "photo.png",
        },
      ],
    });

    expect(result).toEqual({ runId: "run-image", status: "started" });
    expect(request).toHaveBeenCalledTimes(1);
    const [requestMethod, requestParams] = requireFirstRequestCall(request);
    expect(requestMethod).toBe("chat.send");
    const sendParams = requireRecord(requestParams);
    expect(sendParams.message).toBe("");
    expect(sendParams.attachments).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        content: imageBase64,
      },
    ]);
    expect(JSON.stringify(state.chatMessages)).not.toContain("data:image/png;base64");

    const captionedRequest = vi.fn((_method: string, params?: unknown) =>
      Promise.resolve(createStartedChatSendAck(params)),
    );
    const captionedState = createState({
      connected: true,
      client: { request: captionedRequest } as unknown as ChatState["client"],
    });

    await expect(
      requestChatSend(captionedState, {
        message: "describe",
        runId: "run-captioned-image",
        attachments: [
          {
            id: "att-captioned-image",
            dataUrl: imageDataUrl,
            mimeType: "image/png",
            fileName: "photo.png",
          },
        ],
      }),
    ).resolves.toEqual({ runId: "run-captioned-image", status: "started" });
    expect(JSON.stringify(captionedState.chatMessages)).not.toContain("data:image/png;base64");
  });
});

describe("abortChatRun", () => {
  it("formats structured non-auth connect failures for chat abort", async () => {
    // Abort now shares the same structured connect-error formatter as send.
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" },
      }),
    );
    const state = createState({
      connected: true,
      chatRunId: "run-1",
      client: { request } as unknown as ChatState["client"],
    });

    const result = await abortChatRun(state);

    expect(result).toBe(false);
    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "main",
      runId: "run-1",
    });
    expect(state.lastError).toBe(
      "device identity required (use HTTPS/localhost or allow insecure auth explicitly)",
    );
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
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "subagent completion payload",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
              ].join("\n"),
            },
          ],
        },
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

  it("keeps local optimistic tail messages when history reload returns a stale snapshot", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      __openclaw: { seq: 1 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      timestamp: 10,
    };
    const optimisticAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "latest answer" }],
      timestamp: 11,
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser, optimisticUser, optimisticAssistant],
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([persistedUser, optimisticUser, optimisticAssistant]);
    expect(state.chatStream).toBeNull();
  });

  it("keeps active streamed assistant text when history reload returns a stale snapshot", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      __openclaw: { seq: 1 },
    };
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      timestamp: 10,
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser, optimisticUser],
      chatRunId: "run-1",
      chatStream: "First visible stream text.",
      chatStreamStartedAt: 100,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([persistedUser, optimisticUser]);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe("First visible stream text.");
    expect(state.chatStreamStartedAt).toBe(100);
  });

  it("clears live tool cards when history catches up before assistant text", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
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
    expect(state.chatStream).toBe("Still answering.");
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("inserts multiple recovered stream segments before their matching persisted tools", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const firstToolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "shell",
      content: [{ type: "text", text: "first output" }],
      timestamp: 2,
      __openclaw: { seq: 2 },
    };
    const secondToolResult = {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "shell",
      content: [{ type: "text", text: "second output" }],
      timestamp: 4,
      __openclaw: { seq: 3 },
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, firstToolResult, secondToolResult],
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
    state.chatStreamSegments = [
      { text: "before first tool", ts: 1 },
      { text: "before first tool\nbefore second tool", ts: 3 },
    ];
    state.chatToolMessages = [firstToolResult, secondToolResult];
    state.toolStreamById = new Map([
      ["call_1", { message: firstToolResult }],
      ["call_2", { message: secondToolResult }],
    ]);
    state.toolStreamOrder = ["call_1", "call_2"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(5);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(state.chatMessages[1], "assistant", "before first tool");
    expect(state.chatMessages[2]).toEqual(firstToolResult);
    expectTextChatMessage(state.chatMessages[3], "assistant", "before second tool");
    expect(state.chatMessages[4]).toEqual(secondToolResult);
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(1);
    expect(requireRecord(state.chatMessages[3]).timestamp).toBe(3);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("prunes only the live tool cards that history has caught up with", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const firstToolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "shell",
      content: [{ type: "text", text: "first output" }],
      timestamp: 2,
      __openclaw: { seq: 2 },
    };
    const secondLiveToolResult = {
      role: "assistant",
      toolCallId: "call_2",
      runId: "run-1",
      content: [
        { type: "toolcall", name: "shell", arguments: {} },
        { type: "toolresult", name: "shell", text: "second output" },
      ],
      timestamp: 4,
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, firstToolResult],
      thinkingLevel: "low",
    });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
      chatMessages: [persistedUser],
      chatRunId: "run-1",
      chatStream: "before first tool\nbefore second tool\nStill answering.",
      chatStreamStartedAt: 100,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number; toolCallId?: string }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [
      { text: "before first tool", ts: 1, toolCallId: "call_1" },
      {
        text: "before first tool\nbefore second tool",
        ts: 3,
        toolCallId: "call_2",
      },
    ];
    state.chatToolMessages = [firstToolResult, secondLiveToolResult];
    state.toolStreamById = new Map([
      ["call_1", { message: firstToolResult }],
      ["call_2", { message: secondLiveToolResult }],
    ]);
    state.toolStreamOrder = ["call_1", "call_2"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(state.chatMessages[1], "assistant", "before first tool");
    expect(state.chatMessages[2]).toEqual(firstToolResult);
    expect(state.chatToolMessages).toEqual([secondLiveToolResult]);
    expect(state.chatStreamSegments).toEqual([
      { text: "before second tool", ts: 3, toolCallId: "call_2" },
    ]);
    expect(state.chatStream).toBe("Still answering.");
    expect(state.toolStreamById.size).toBe(1);
    expect(state.toolStreamById.has("call_2")).toBe(true);
    expect(state.toolStreamOrder).toEqual(["call_2"]);
  });

  it("uses segment tool ids when a tool starts before any stream text", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const firstToolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "shell",
      content: [{ type: "text", text: "first output" }],
      timestamp: 2,
      __openclaw: { seq: 2 },
    };
    const secondToolResult = {
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "shell",
      content: [{ type: "text", text: "second output" }],
      timestamp: 4,
      __openclaw: { seq: 3 },
    };
    const request = vi.fn().mockResolvedValue({
      messages: [persistedUser, firstToolResult, secondToolResult],
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
      chatStreamSegments: Array<{ text: string; ts: number; toolCallId?: string }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [{ text: "before second tool", ts: 3, toolCallId: "call_2" }];
    state.chatToolMessages = [firstToolResult, secondToolResult];
    state.toolStreamById = new Map([
      ["call_1", { message: firstToolResult }],
      ["call_2", { message: secondToolResult }],
    ]);
    state.toolStreamOrder = ["call_1", "call_2"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(4);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expect(state.chatMessages[1]).toEqual(firstToolResult);
    expectTextChatMessage(state.chatMessages[2], "assistant", "before second tool");
    expect(state.chatMessages[3]).toEqual(secondToolResult);
    expect(requireRecord(state.chatMessages[2]).timestamp).toBe(3);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("trims accumulated current stream after materializing caught-up tool segments", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
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
      chatStream: "before tool\nafter tool",
      chatStreamStartedAt: 100,
    }) as ChatState & {
      chatStreamSegments: Array<{ text: string; ts: number; toolCallId?: string }>;
      chatToolMessages: Record<string, unknown>[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      toolStreamSyncTimer: number | null;
    };
    state.chatStreamSegments = [{ text: "before tool", ts: 1, toolCallId: "call_1" }];
    state.chatToolMessages = [persistedToolResult];
    state.toolStreamById = new Map([["call_1", { message: persistedToolResult }]]);
    state.toolStreamOrder = ["call_1"];
    state.toolStreamSyncTimer = null;

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextChatMessage(state.chatMessages[1], "assistant", "before tool");
    expect(state.chatMessages[2]).toEqual(persistedToolResult);
    expect(state.chatStream).toBe("after tool");
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("keeps live tool cards when only older history has a persisted tool result", async () => {
    const olderUser = {
      role: "user",
      content: [{ type: "text", text: "older ask" }],
      __openclaw: { seq: 1 },
    };
    const olderToolResult = {
      role: "toolResult",
      toolCallId: "call_old",
      toolName: "shell",
      content: [{ type: "text", text: "old tool output" }],
      __openclaw: { seq: 2 },
    };
    const latestUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 3 },
    };
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
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
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
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
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
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      __openclaw: { seq: 1 },
    };
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
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: 200,
      __openclaw: { seq: 1 },
    };
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
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
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
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const historyAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "First visible stream text. More final text." }],
      __openclaw: { seq: 2 },
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
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([persistedUser, historyAssistant]);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });

  it("keeps live tool cards when history only replaces streamed text", async () => {
    const persistedUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const historyAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "First visible stream text. More final text." }],
      __openclaw: { seq: 2 },
    };
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
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "first ask" }],
      timestamp: 10,
    };
    const optimisticAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      timestamp: 11,
    };
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
    const optimisticUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      timestamp: 10,
    };
    const historyUser = {
      role: "user",
      content: [{ type: "text", text: "latest ask" }],
      __openclaw: { seq: 1 },
    };
    const historyAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "latest answer" }],
      __openclaw: { seq: 2 },
    };
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

    const optimisticMessage = {
      role: "user",
      content: [{ type: "text", text: "send before history settles" }],
      timestamp: 123,
    };
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

    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "send before history settles" }],
      timestamp: 123,
    };
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "answer before history catches up" }],
      timestamp: 456,
    };
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

    const repeatedPrompt = {
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: 200,
    };
    state.chatMessages = [repeatedPrompt];

    history.resolve({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
          timestamp: 100,
        },
      ],
      thinkingLevel: "low",
    });
    await load;

    expect(state.chatMessages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "continue" }],
        timestamp: 100,
      },
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
    const visibleMessage = {
      role: "assistant",
      content: [{ type: "text", text: "visible before reconnect" }],
    };
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
