import { vi } from "vitest";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

const followupTurnTestState = vi.hoisted(() => ({
  execute: vi.fn(),
  loadEntryReadOnly: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: (...args: unknown[]) => followupTurnTestState.execute(...args),
}));

vi.mock("./agent-runner-session-reset.js", () => ({
  resetReplyRunSession: (...args: unknown[]) => followupTurnTestState.reset(...args),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: (...args: unknown[]) =>
    followupTurnTestState.loadEntryReadOnly(...args),
}));

const { executeFollowupTurn } = await import("./followup-turn-execution.js");

export const executeFollowupTurnForTest = executeFollowupTurn;

export function getFollowupTurnTestState() {
  return followupTurnTestState;
}

export function createFollowupTurnTestTypingController() {
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

export function createFollowupTurnTestTurn(
  overrides: Partial<AdmittedFollowupTurn> = {},
): AdmittedFollowupTurn {
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
    operation: { abortSignal: new AbortController().signal } as AdmittedFollowupTurn["operation"],
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

export function resetFollowupTurnTestState() {
  vi.clearAllMocks();
  followupTurnTestState.loadEntryReadOnly.mockReturnValue(undefined);
  followupTurnTestState.execute.mockResolvedValue({
    runId: "run-1",
    outcome: { kind: "rejected", payload: { text: "done" } },
  });
}
