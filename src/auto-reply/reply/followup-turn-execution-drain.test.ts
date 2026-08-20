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

beforeEach(() => {
  vi.clearAllMocks();
  state.loadEntryReadOnly.mockReturnValue(undefined);
  state.execute.mockResolvedValue({
    runId: "run-1",
    outcome: { kind: "rejected", payload: { text: "done" } },
  });
});

describe("executeFollowupTurn recovery and drain", () => {
  it("drains detached progress before the caller can project a final", async () => {
    const order: string[] = [];
    let releaseProgress!: () => void;
    const progressBarrier = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      void params.opts?.onItemEvent?.({ progressText: "working" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          onItemEvent: async () => {
            await progressBarrier;
            order.push("progress");
          },
        },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    const drain = result.progress.drain().then(() => order.push("drained"));
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseProgress();
    await drain;
    expect(order).toEqual(["progress", "drained"]);
  });

  it("preserves detached progress delivery failures for the drain", async () => {
    const failure = new Error("progress delivery failed");
    let detachedProgress!: Promise<unknown>;
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      detachedProgress = Promise.resolve(params.opts?.onItemEvent?.({ progressText: "working" }));
      void detachedProgress.catch(() => undefined);
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          onItemEvent: async () => {
            throw failure;
          },
        },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    await expect(detachedProgress).resolves.toBe(false);
    await expect(result.progress.drain()).rejects.toBe(failure);
  });

  it("preserves numeric thread ids during canonical role-ordering recovery", async () => {
    const turn = createTurn({ queued: { ...createTurn().queued, originatingThreadId: 42 } });
    state.reset.mockResolvedValue(true);
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.resetSessionAfterRoleOrderingConflict("invalid history");
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    await executeFollowupTurn({
      turn,
      defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    expect(state.reset).toHaveBeenCalledWith(expect.objectContaining({ messageThreadId: "42" }));
  });

  it("updates the reply operation after role-ordering recovery rotates the session", async () => {
    const updateSessionId = vi.fn();
    const turn = createTurn({
      operation: {
        abortSignal: new AbortController().signal,
        updateSessionId,
      } as unknown as AdmittedFollowupTurn["operation"],
    });
    state.reset.mockImplementation(async (params) => {
      params.onActiveSessionEntry({ sessionId: "reset-session", updatedAt: 2 });
      return true;
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.resetSessionAfterRoleOrderingConflict("invalid history");
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    await executeFollowupTurn({
      turn,
      defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    expect(updateSessionId).toHaveBeenCalledWith("reset-session");
  });

  it("drains detached progress before propagating execution failure", async () => {
    const order: string[] = [];
    let releaseProgress!: () => void;
    const progressBarrier = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    const failure = new Error("execution failed");
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      void params.opts?.onItemEvent?.({ progressText: "working" });
      throw failure;
    });
    const pending = executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          onItemEvent: async () => {
            await progressBarrier;
            order.push("progress");
          },
        },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseProgress();
    await expect(pending).rejects.toBe(failure);
    expect(order).toEqual(["progress"]);
  });

  it("normalizes a post-start execution failure after draining detached progress", async () => {
    const failure = new Error("execution failed after start");
    const onItemEvent = vi.fn(async () => {});
    const fail = vi.fn();
    const operation = {
      abortSignal: new AbortController().signal,
      fail,
    } as unknown as AdmittedFollowupTurn["operation"];
    const turn = createTurn({ operation });
    turn.queued.originatingChatType = "direct";
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      void params.opts?.onItemEvent?.({ progressText: "working" });
      markReplyOperationExecutionStarted(operation);
      throw failure;
    });
    const pending = executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { onItemEvent },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    await expect(pending).resolves.toMatchObject({
      execution: {
        runId: "run-1",
        outcome: { kind: "rejected", payload: { isError: true } },
      },
    });
    expect(onItemEvent).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith("run_failed", failure);
  });

  it("waits for every pending task before propagating a drain failure", async () => {
    const failure = new Error("tool task failed");
    let releaseSlowTask!: () => void;
    const slowBarrier = new Promise<void>((resolve) => {
      releaseSlowTask = resolve;
    });
    const order: string[] = [];
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      const failedTask = Promise.reject(failure).finally(() => {
        params.pendingToolTasks.delete(failedTask);
      });
      const slowTask = slowBarrier
        .then(() => {
          order.push("slow-finished");
        })
        .finally(() => {
          params.pendingToolTasks.delete(slowTask);
        });
      params.pendingToolTasks.add(failedTask);
      params.pendingToolTasks.add(slowTask);
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    const drain = result.progress.drain();
    await Promise.resolve();
    releaseSlowTask();
    await expect(drain).rejects.toBe(failure);
    expect(order).toEqual(["slow-finished"]);
  });
});
