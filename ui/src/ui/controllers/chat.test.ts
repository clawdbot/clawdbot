import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerChatAttachmentPayload,
  resetChatAttachmentPayloadStoreForTest,
} from "../chat/attachment-payload-store.ts";
import { GatewayRequestError } from "../gateway.ts";
import {
  abortChatRun,
  handleChatEvent,
  loadChatHistory,
  requestChatSend,
  sendChatMessage,
  type ChatEventPayload,
  type ChatState,
} from "./chat.ts";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatThinkingLevel: null,
    client: null,
    connected: true,
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
    expect(handleChatEvent(state, payload)).toBe("final");
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
    expect(handleChatEvent(state, payload)).toBe("final");
    expect(state.chatMessages).toEqual([payload.message]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
    expect(state.chatStreamStartedAt).toBe(null);
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

    expect(handleChatEvent(state, payload)).toBe("aborted");
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
      request: vi.fn().mockResolvedValue({ messages, thinkingLevel: "low" }),
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
});

describe("sendChatMessage", () => {
  it("does not start a second chat.send while the first send is awaiting ack", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn(() => sent.promise);
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const first = sendChatMessage(state, "hello");
    const activeRunId = state.chatRunId;
    const second = sendChatMessage(state, "hello");

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toHaveLength(1);
    await expect(second).resolves.toBe(activeRunId);

    sent.resolve({ runId: activeRunId, status: "started" });
    await expect(first).resolves.toBe(activeRunId);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessages).toHaveLength(1);
  });

  it("passes the backing session id from history when sending after reconnect", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "session-before-reconnect",
        messages: [],
      })
      .mockResolvedValueOnce({ runId: "run-1", status: "started" });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    await loadChatHistory(state);
    const result = await sendChatMessage(state, "continue");

    expect(result).toMatch(UUID_V4_RE);
    expect(state.currentSessionId).toBe("session-before-reconnect");
    const sendRequest = request.mock.calls[request.mock.calls.length - 1];
    expect(sendRequest?.[0]).toBe("chat.send");
    const sendParams = requireRecord(sendRequest?.[1]);
    expect(sendParams.sessionKey).toBe("main");
    expect(sendParams.sessionId).toBe("session-before-reconnect");
    expect(sendParams.message).toBe("continue");
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

  it("adopts the run id and terminal status from the chat.send ack", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "gateway-complete-run", status: "ok" });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await sendChatMessage(state, "already handled");

    expect(result).toBe("gateway-complete-run");
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });

  it("serializes non-image chat attachments as files", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-1", status: "started" });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await sendChatMessage(state, "summarize", [
      {
        id: "att-1",
        dataUrl: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n").toString("base64")}`,
        mimeType: "application/pdf",
        fileName: "brief.pdf",
      },
    ]);

    expect(result).toMatch(UUID_V4_RE);
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
    const userMessage = requireRecord(state.chatMessages[0]);
    expect(userMessage.role).toBe("user");
    const content = userMessage.content;
    expect(Array.isArray(content)).toBe(true);
    const contentParts = content as unknown[];
    expect(contentParts).toHaveLength(2);
    expect(contentParts[0]).toEqual({ type: "text", text: "summarize" });
    const attachmentPart = requireRecord(contentParts[1]);
    expect(attachmentPart.type).toBe("attachment");
    const attachmentPreview = requireRecord(attachmentPart.attachment);
    expect(attachmentPreview.kind).toBe("document");
    expect(attachmentPreview.label).toBe("brief.pdf");
    expect(attachmentPreview.mimeType).toBe("application/pdf");
  });

  it("serializes attachments from the side payload store without copying data URLs into chat state", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-1", status: "started" });
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

    const result = await sendChatMessage(state, "summarize", [attachment]);

    expect(result).toMatch(UUID_V4_RE);
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
    expect(state.chatMessages).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "attachment",
            attachment: {
              url: previewUrl,
              kind: "document",
              label: "brief.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("sends inline image payloads without copying data URLs into optimistic chat state", async () => {
    const request = vi.fn().mockResolvedValue({ runId: "run-1", status: "started" });
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });
    const imageBase64 = "A".repeat(1024 * 1024);
    const imageDataUrl = `data:image/png;base64,${imageBase64}`;

    const result = await sendChatMessage(state, "", [
      {
        id: "att-image",
        dataUrl: imageDataUrl,
        mimeType: "image/png",
        fileName: "photo.png",
      },
    ]);

    expect(result).toMatch(UUID_V4_RE);
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
    expect(state.chatMessages).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Attached image: photo.png" }],
        timestamp: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(state.chatMessages)).not.toContain("data:image/png;base64");

    const captionedRequest = vi.fn().mockResolvedValue({ runId: "run-2", status: "started" });
    const captionedState = createState({
      connected: true,
      client: { request: captionedRequest } as unknown as ChatState["client"],
    });

    await expect(
      sendChatMessage(captionedState, "describe", [
        {
          id: "att-captioned-image",
          dataUrl: imageDataUrl,
          mimeType: "image/png",
          fileName: "photo.png",
        },
      ]),
    ).resolves.toMatch(UUID_V4_RE);
    expect(captionedState.chatMessages).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "text", text: "Attached image: photo.png" },
        ],
        timestamp: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(captionedState.chatMessages)).not.toContain("data:image/png;base64");
  });

  it("formats structured non-auth connect failures for chat send", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: "CONTROL_UI_ORIGIN_NOT_ALLOWED" },
      }),
    );
    const state = createState({
      connected: true,
      client: { request } as unknown as ChatState["client"],
    });

    const result = await sendChatMessage(state, "hello");

    const expectedError =
      "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
    expect(result).toBeNull();
    expect(state.lastError).toBe(expectedError);
    const assistantMessage = requireRecord(state.chatMessages.at(-1));
    expect(assistantMessage.role).toBe("assistant");
    const content = assistantMessage.content;
    expect(Array.isArray(content)).toBe(true);
    const [textPart] = content as unknown[];
    const textRecord = requireRecord(textPart);
    expect(textRecord.type).toBe("text");
    expect(textRecord.text).toBe(`Error: ${expectedError}`);
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
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toStrictEqual([]);
    expect(state.chatThinkingLevel).toBeNull();
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

  it("ignores stale history responses after switching sessions", async () => {
    const mainRequest = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
    const otherRequest = createDeferred<{ messages: Array<unknown>; thinkingLevel?: string }>();
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
    });
    await firstLoad;

    expect(state.chatLoading).toBe(true);
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "visible old" }] },
    ]);
    expect(state.chatThinkingLevel).toBeNull();

    otherRequest.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "other history" }] }],
      thinkingLevel: "low",
    });
    await secondLoad;

    expect(state.chatLoading).toBe(false);
    expect(state.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "other history" }] },
    ]);
    expect(state.chatThinkingLevel).toBe("low");
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
