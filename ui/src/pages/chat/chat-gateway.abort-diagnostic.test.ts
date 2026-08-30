// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import type { ChatState } from "./chat-history.ts";

type AbortDiagnosticState = ChatState & {
  chatRunStatus?: { phase: string; runId: string | null; sessionKey: string } | null;
  lastLocalTerminalReconcile?: { sessionStatus: string } | null;
  sessionsResult?: {
    ts: number;
    path: string;
    count: number;
    defaults: Record<string, unknown>;
    sessions: Array<Record<string, unknown>>;
  };
};

function createAbortDiagnosticState(runId = "run-validation-abort"): AbortDiagnosticState {
  return {
    chatAttachments: [],
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatQueue: [],
    chatRunError: null,
    chatRunId: runId,
    chatSending: false,
    chatStream: "Partial assistant reply",
    chatStreamStartedAt: 100,
    chatRunStartup: null,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    client: null,
    connected: true,
    connectionEpoch: 0,
    hello: null,
    lastError: null,
    sessionKey: "main",
    sessionsResult: {
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
          activeRunIds: [runId],
          status: "running",
          startedAt: 100,
        },
      ],
    },
  };
}

describe("aborted chat diagnostics", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { name: "plain cancellation", errorMessage: undefined, expectedError: null },
    {
      name: "validation self-abort",
      errorMessage: "edit tool validation failed: edits: must be an array",
      expectedError: "Error: edit tool validation failed: edits: must be an array",
    },
  ])("keeps first-terminal $name killed and interrupted", ({ errorMessage, expectedError }) => {
    const state = createAbortDiagnosticState();
    const payload: ChatEventPayload = {
      runId: "run-validation-abort",
      sessionKey: "main",
      state: "aborted",
      ...(errorMessage ? { errorMessage } : {}),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("aborted");

    expect(state.chatRunError?.summary ?? null).toBe(expectedError);
    expect(state.chatRunStatus).toMatchObject({
      phase: "interrupted",
      runId: "run-validation-abort",
      sessionKey: "main",
    });
    expect(state.lastLocalTerminalReconcile?.sessionStatus).toBe("killed");
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      activeRunIds: [],
      hasActiveRun: false,
      status: "killed",
    });
    expect(state.chatRunId).toBeNull();
  });

  it("surfaces one late aborted diagnostic and ignores its replay", () => {
    const state = createAbortDiagnosticState();
    const aborted = {
      runId: "run-validation-abort",
      sessionKey: "main",
      state: "aborted" as const,
    };
    const diagnostic = {
      ...aborted,
      errorMessage: "edit tool validation failed: edits: must be an array",
    };

    expect(handleChatGatewayEvent(state, aborted)).toBe("aborted");
    expect(state.chatRunError).toBeNull();
    expect(handleChatGatewayEvent(state, diagnostic)).toBe("aborted");
    const displayedDiagnostic = state.chatRunError;
    expect(handleChatGatewayEvent(state, diagnostic)).toBe("aborted");

    expect(state.chatRunError).toBe(displayedDiagnostic);
    expect(state.chatRunError).toEqual({
      summary: "Error: edit tool validation failed: edits: must be an array",
      runId: "run-validation-abort",
    });
    expect(state.chatRunId).toBeNull();
  });

  it("does not publish a late aborted diagnostic over a newer active run", () => {
    const state = createAbortDiagnosticState("run-old");
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
      }),
    ).toBe("aborted");
    state.chatRunId = "run-new";
    state.chatStream = "New run output";

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
        errorMessage: "edit tool validation failed: invalid arguments",
      }),
    ).toBe("aborted");

    expect(state.chatRunError).toBeNull();
    expect(state.chatRunId).toBe("run-new");
    expect(state.chatStream).toBe("New run output");
  });

  it("does not restore an old diagnostic while a newer send awaits its ACK", () => {
    const state = createAbortDiagnosticState("run-old");
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
      }),
    ).toBe("aborted");
    state.chatQueue = [
      {
        id: "pending-new-send",
        text: "New request",
        createdAt: 200,
        sendRunId: "run-new",
        sendState: "sending",
      },
    ];

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
        errorMessage: "edit tool validation failed: invalid arguments",
      }),
    ).toBe("aborted");

    expect(state.chatRunError).toBeNull();
    expect(state.chatRunId).toBeNull();
    expect(state.lastLocalTerminalReconcile?.runId).toBe("run-old");
  });

  it("does not publish an old aborted diagnostic after a newer run completes", () => {
    const state = createAbortDiagnosticState("run-old");
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
      }),
    ).toBe("aborted");
    state.chatRunId = "run-new";
    state.chatStream = "New final answer";
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-new",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "New final answer" }],
        },
      }),
    ).toBe("final");

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
        errorMessage: "edit tool validation failed: invalid arguments",
      }),
    ).toBe("aborted");

    expect(state.chatRunError).toBeNull();
    expect(state.lastLocalTerminalReconcile?.runId).toBe("run-new");
    expect(state.chatRunId).toBeNull();
    expect(state.chatMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "New final answer" }],
    });
  });
});
