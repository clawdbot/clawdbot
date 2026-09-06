import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";
import { markReplyOperationExecutionStarted } from "./reply-run-registry.state.js";

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  loadEntryReadOnly: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: (...args: unknown[]) => state.execute(...args),
}));

vi.mock("./agent-runner-session-reset.js", () => ({
  resetReplyRunSession: (...args: unknown[]) => state.reset(...args),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: (...args: unknown[]) => state.loadEntryReadOnly(...args),
}));

const { executeFollowupTurn } = await import("./followup-turn-execution.js");

function createTypingController() {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  };
}

function createTurn(overrides: Partial<AdmittedFollowupTurn> = {}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued prompt",
      transcriptPrompt: "queued transcript",
      enqueuedAt: 1,
      messageId: "message-1",
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      originatingThreadId: "thread-1",
      originatingAccountId: "acct-1",
      originatingChatType: "group",
      media: [{ kind: "audio", contentType: "audio/ogg" }],
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: "slack",
        senderId: "user-1",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {
      abortSignal: new AbortController().signal,
      bindToolAuthoritySnapshot: vi.fn(),
    } as unknown as AdmittedFollowupTurn["operation"],
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "on" }),
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

describe("executeFollowupTurn tool-authority snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.execute.mockResolvedValue({ runId: "run-1", outcome: { kind: "completed" } });
    state.loadEntryReadOnly.mockResolvedValue(null);
    state.reset.mockResolvedValue(true);
  });

  // Regression test for #139847: queued followup execution must bind the
  // tool-authority snapshot before dispatching to executeAgentTurn. Without
  // this, the CLI/embedded candidate's bindToolAuthorityRoute call throws
  // "Reply operation has no active tool authority snapshot" and drops the
  // queued message.
  it("binds the tool-authority snapshot before dispatching the queued turn", async () => {
    const bindSnapshot = vi.fn();
    const operation = {
      abortSignal: new AbortController().signal,
      bindToolAuthoritySnapshot: bindSnapshot,
    } as unknown as AdmittedFollowupTurn["operation"];

    state.execute.mockImplementation(async (_params: AgentTurnParams) => {
      markReplyOperationExecutionStarted(operation);
      return { runId: "run-1", outcome: { kind: "completed" } };
    });

    await executeFollowupTurn({
      turn: createTurn({ operation }),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    expect(bindSnapshot).toHaveBeenCalledTimes(1);
  });
});
