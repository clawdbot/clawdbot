import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

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

describe("executeFollowupTurn", () => {
  it("normalizes queued route facts into the canonical execution call", async () => {
    const turn = createTurn();
    const typing = createTypingController();
    const onExecutionStarted = vi.fn();
    const onAgentRunStart = vi.fn();
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      params.opts?.onAgentRunStart?.("run-1");
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    await executeFollowupTurn({
      turn,
      defaults: {
        typing,
        typingMode: "instant",
        defaultModel: "claude",
        opts: { onAgentRunStart },
      },
      onExecutionStarted,
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    const call = state.execute.mock.calls[0]?.[0] as AgentTurnParams;
    expect(call).toMatchObject({
      commandBody: "queued prompt",
      transcriptCommandBody: "queued transcript",
      followupRun: turn.queued,
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      sessionKey: "main",
    });
    expect(call.opts?.runId).toBe("run-1");
    expect(call.sessionCtx).toMatchObject({
      Provider: "slack",
      Surface: "discord",
      SessionKey: "main",
      RuntimePolicySessionKey: "main",
      OriginatingTo: "channel:C1",
      MessageThreadId: "thread-1",
      MessageSid: "message-1",
      SenderId: "user-1",
    });
    expect(call.sessionCtx.media).toEqual([{ kind: "audio", contentType: "audio/ogg" }]);
    expect(onExecutionStarted).toHaveBeenCalledOnce();
    expect(onAgentRunStart).toHaveBeenCalledWith("run-1");
  });

  it("ignores verbosity loaded from a replacement session generation", async () => {
    const currentEntry = {
      sessionId: "session",
      lifecycleRevision: "owned",
      updatedAt: 1,
      verboseLevel: "off" as const,
    };
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        storePath: "/tmp/sessions.json",
        current: () => currentEntry,
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.loadEntryReadOnly.mockReturnValue({
      ...currentEntry,
      lifecycleRevision: "replacement",
      verboseLevel: "full",
    });

    await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    const call = state.execute.mock.calls[0]?.[0] as AgentTurnParams;
    expect(call.resolvedVerboseLevel).toBe("off");
  });

  it("ignores older verbosity from the admitted session generation", async () => {
    const currentEntry = {
      sessionId: "session",
      lifecycleRevision: "owned",
      updatedAt: 2,
      verboseLevel: "off" as const,
    };
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        storePath: "/tmp/sessions.json",
        current: () => currentEntry,
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.loadEntryReadOnly.mockReturnValue({
      ...currentEntry,
      updatedAt: 1,
      verboseLevel: "full",
    });

    await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    const call = state.execute.mock.calls[0]?.[0] as AgentTurnParams;
    expect(call.resolvedVerboseLevel).toBe("off");
  });

  it("keeps room-event progress, tool summaries, and typing silent", async () => {
    const turn = createTurn({
      queued: { ...createTurn().queued, currentInboundEventKind: "room_event" },
    });
    const typing = createTypingController();
    const onToolResult = vi.fn(async () => {});
    const onCompactionStart = vi.fn(async () => {});
    const onCompactionEnd = vi.fn(async () => {});
    const onReasoningEnd = vi.fn(async () => {});
    const onNarrationUpdate = vi.fn(async () => {});
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.typingSignals.signalRunStart();
      await params.opts?.onToolResult?.({ text: "private progress" });
      await params.opts?.onCompactionStart?.();
      await params.opts?.onCompactionEnd?.();
      await params.opts?.onReasoningEnd?.();
      await params.opts?.onNarrationUpdate?.({ text: "private narration" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing,
        typingMode: "instant",
        defaultModel: "claude",
        opts: {
          forceToolResultProgress: true,
          onCompactionStart,
          onCompactionEnd,
          onReasoningEnd,
          onNarrationUpdate,
        },
      },
      onToolResult,
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(onCompactionStart).not.toHaveBeenCalled();
    expect(onCompactionEnd).not.toHaveBeenCalled();
    expect(onReasoningEnd).not.toHaveBeenCalled();
    expect(onNarrationUpdate).not.toHaveBeenCalled();
  });

  it("routes channel-forced tool progress through the channel when verbosity is off", async () => {
    const onToolStart = vi.fn(async () => {});
    const onChannelToolResult = vi.fn(async () => {});
    const onDurableToolResult = vi.fn(async () => {});
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolStart?.({ name: "read", phase: "start" });
      await params.opts?.onToolResult?.({ text: "📄 Web Fetch: working" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          forceToolResultProgress: true,
          onToolStart,
          onToolResult: onChannelToolResult,
        },
      },
      onToolResult: onDurableToolResult,
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onToolStart).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith({ text: "📄 Web Fetch: working" });
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("keeps verbose tool results durable when channel progress is available", async () => {
    const onChannelToolResult = vi.fn(async () => {});
    const onDurableToolResult = vi.fn(async () => {});
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolResult?.({ text: "📄 Web Fetch: working" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          forceToolResultProgress: true,
          onToolResult: onChannelToolResult,
        },
      },
      onToolResult: onDurableToolResult,
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).toHaveBeenCalledWith(
      { text: "📄 Web Fetch: working" },
      { runId: "run-1" },
    );
  });

  it("keeps forced tool results durable when channel progress is unavailable", async () => {
    const onDurableToolResult = vi.fn(async () => {});
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolResult?.({ text: "📄 Web Fetch: working" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { forceToolResultProgress: true },
      },
      onToolResult: onDurableToolResult,
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onDurableToolResult).toHaveBeenCalledWith(
      { text: "📄 Web Fetch: working" },
      { runId: "run-1" },
    );
  });

  it("allows explicitly opted-in tool lifecycle while ordinary progress is hidden", async () => {
    const onToolStart = vi.fn(async () => {});
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolStart?.({ name: "read", phase: "start" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { onToolStart, allowToolLifecycleWhenProgressHidden: true },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onToolStart).toHaveBeenCalledOnce();
  });

  it("preserves plan updates when tool-result verbosity is off", async () => {
    const onPlanUpdate = vi.fn(async () => undefined);
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onPlanUpdate?.({ title: "quiet plan" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn: createTurn({
        session: {
          kind: "session",
          key: "main",
          current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
          publish: () => undefined,
          adopt: () => undefined,
        },
      }),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { onPlanUpdate },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onPlanUpdate).toHaveBeenCalledWith({ title: "quiet plan" });
  });

  it("tracks a visible failed item before suppressing duplicate default warnings", async () => {
    const onItemEvent = vi.fn(async () => undefined);
    let warningSuppressed: boolean | undefined;
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onItemEvent?.({ phase: "end", status: "failed" });
      warningSuppressed = params.opts?.shouldSuppressToolErrorWarnings?.();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { onItemEvent },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onItemEvent).toHaveBeenCalledOnce();
    expect(warningSuppressed).toBe(true);
  });

  it("tracks a full-verbosity failed command before suppressing duplicate warnings", async () => {
    const onCommandOutput = vi.fn(async () => undefined);
    let warningSuppressed: boolean | undefined;
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "full" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onCommandOutput?.({ status: "failed", exitCode: 1 });
      warningSuppressed = params.opts?.shouldSuppressToolErrorWarnings?.();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { onCommandOutput },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onCommandOutput).toHaveBeenCalledOnce();
    expect(warningSuppressed).toBe(true);
  });

  it("does not suppress warnings for hidden verbose-off tool errors", async () => {
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    let warningSuppressed: boolean | undefined;
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolResult?.({ text: "hidden failure", isError: true });
      warningSuppressed = params.opts?.shouldSuppressToolErrorWarnings?.();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const onToolResult = vi.fn(async () => {});

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      },
      onToolResult,
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onToolResult).not.toHaveBeenCalled();
    expect(warningSuppressed).toBe(false);
  });

  it("suppresses duplicate warnings for delivered verbose-off tool errors", async () => {
    const turn = createTurn({
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    let warningSuppressed: boolean | undefined;
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.opts?.onToolResult?.({ text: "visible failure", isError: true });
      warningSuppressed = params.opts?.shouldSuppressToolErrorWarnings?.();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });
    const onToolResult = vi.fn(async () => {});

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
      },
      onToolResult,
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(onToolResult).toHaveBeenCalledWith(
      { text: "visible failure", isError: true },
      { runId: "run-1" },
    );
    expect(warningSuppressed).toBe(true);
  });

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

    await expect(detachedProgress).resolves.toBeUndefined();
    await expect(result.progress.drain()).rejects.toBe(failure);
  });

  it("preserves numeric thread ids during canonical role-ordering recovery", async () => {
    const turn = createTurn({
      queued: { ...createTurn().queued, originatingThreadId: 42 },
    });
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
