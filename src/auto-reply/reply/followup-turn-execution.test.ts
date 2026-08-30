import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
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

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
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
    expect(onAgentRunStart).toHaveBeenCalledWith("run-1");
  });

  it("projects the queued lifecycle instead of a newer runner lifecycle", async () => {
    const queuedLifecycle = {
      onAdopted: vi.fn(async () => {}),
      cronCreatorAuthorityUnavailable: "queued-local-operator" as const,
    };
    const newerRunnerLifecycle = { onAdopted: vi.fn(async () => {}) };
    const turn = createTurn();
    turn.queued.turnAdoptionLifecycle = queuedLifecycle;

    await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "instant",
        defaultModel: "claude",
        opts: { turnAdoptionLifecycle: newerRunnerLifecycle },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    const call = state.execute.mock.calls[0]?.[0] as AgentTurnParams;
    expect(call.opts?.turnAdoptionLifecycle).toBe(queuedLifecycle);
    expect(call.opts?.turnAdoptionLifecycle).not.toBe(newerRunnerLifecycle);
    expect(queuedLifecycle.onAdopted).not.toHaveBeenCalled();
    expect(newerRunnerLifecycle.onAdopted).not.toHaveBeenCalled();
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

  it.each([
    {
      initialLevel: "off",
      queuedLevel: "on",
      expectedDurableCommentary: true,
    },
    {
      initialLevel: "on",
      queuedLevel: "off",
      expectedDurableCommentary: false,
    },
  ] as const)(
    "refreshes commentary ownership for a queued $initialLevel-to-$queuedLevel transition",
    async ({ initialLevel, queuedLevel, expectedDurableCommentary }) => {
      let verboseLevel = queuedLevel;
      let isVerboseProgressActive = () => initialLevel !== "off";
      const turn = createTurn({
        session: {
          kind: "session",
          key: "main",
          current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel }),
          publish: () => undefined,
          adopt: () => undefined,
        },
      });
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        expect(params.resolvedVerboseLevel).toBe(queuedLevel);
        expect(params.opts?.commentaryPayloadsEnabled).toBe(expectedDurableCommentary);
        verboseLevel = queuedLevel === "off" ? "on" : "off";
        expect(isVerboseProgressActive()).toBe(queuedLevel !== "off");
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            commentaryPayloadsEnabled: true,
            shouldDeliverCommentaryPayloads: () => isVerboseProgressActive(),
            onVerboseProgressVisibility: (getter) => {
              isVerboseProgressActive = getter;
            },
          },
        },
        onToolResult: vi.fn(async () => {}),
        onCompactionNoticePayload: vi.fn(async () => {}),
      });

      expect(result.commentaryPayloadsEnabled).toBe(expectedDurableCommentary);
    },
  );

  it("routes a queued verbose-off preamble to the draft commentary owner", async () => {
    const onItemEvent = vi.fn(async () => true as const);
    let preambleVisible: boolean | void = false;
    let toolVisible: boolean | void = true;
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
      expect(params.opts?.commentaryPayloadsEnabled).toBe(false);
      preambleVisible = await params.opts?.onItemEvent?.({
        kind: "preamble",
        progressText: "Checking the queued request",
      });
      toolVisible = await params.opts?.onItemEvent?.({
        kind: "tool",
        progressText: "running exec",
      });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: {
          commentaryPayloadsEnabled: true,
          shouldDeliverCommentaryPayloads: () => false,
          onItemEvent,
        },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(result.commentaryPayloadsEnabled).toBe(false);
    expect(preambleVisible).toBe(true);
    expect(toolVisible).toBe(false);
    expect(onItemEvent).toHaveBeenCalledOnce();
    expect(onItemEvent).toHaveBeenCalledWith({
      kind: "preamble",
      progressText: "Checking the queued request",
    });
  });

  it.each([
    {
      owner: "without a static opt-in",
      ownerOptions: {},
      expectedDurableCommentary: false,
    },
    {
      owner: "with only a static opt-in",
      ownerOptions: { commentaryPayloadsEnabled: true },
      expectedDurableCommentary: true,
    },
    {
      owner: "with the durable callback owner",
      ownerOptions: {
        commentaryPayloadsEnabled: true,
        shouldDeliverCommentaryPayloads: () => true,
      },
      expectedDurableCommentary: true,
    },
  ] as const)(
    "suppresses queued verbose-off preambles $owner",
    async ({ ownerOptions, expectedDurableCommentary }) => {
      const onItemEvent = vi.fn(async () => true as const);
      let preambleVisible: boolean | void = true;
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
        preambleVisible = await params.opts?.onItemEvent?.({
          kind: "preamble",
          progressText: "Checking the queued request",
        });
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: { onItemEvent, ...ownerOptions },
        },
        onToolResult: vi.fn(async () => {}),
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();

      expect(result.commentaryPayloadsEnabled).toBe(expectedDurableCommentary);
      expect(preambleVisible).toBe(false);
      expect(onItemEvent).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    {
      label: "media",
      payload: { mediaUrl: "https://example.com/tool-result.png" },
    },
    {
      label: "captioned media",
      payload: {
        text: "Generated image",
        mediaUrl: "https://example.com/tool-result.png",
      },
    },
    {
      label: "exec approvals",
      payload: {
        text: "Approval required.",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      },
    },
    {
      label: "unavailable exec approvals",
      payload: {
        text: "Exec approval is unavailable.",
        channelData: {
          execApprovalUnavailable: { reason: "no-approval-route" },
        },
      },
    },
    {
      label: "ask-user prompts",
      payload: {
        text: "Question for you: Where should this deploy?",
        channelData: { askUser: { questionId: "question-owned-by-agent-runtime" } },
      },
    },
  ] satisfies Array<{ label: string; payload: ReplyPayload }>)(
    "keeps quiet forced $label on the durable path",
    async ({ payload }) => {
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
        await params.opts?.onToolResult?.(payload);
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
            onToolResult: onChannelToolResult,
          },
        },
        onToolResult: onDurableToolResult,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();

      expect(onChannelToolResult).not.toHaveBeenCalled();
      expect(onDurableToolResult).toHaveBeenCalledOnce();
      expect(onDurableToolResult).toHaveBeenCalledWith(payload, { runId: "run-1" });
    },
  );

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

  it.each([
    { label: "sync void", callback: () => undefined, expected: true },
    { label: "async void", callback: async () => undefined, expected: true },
    { label: "explicit true", callback: () => true, expected: true },
    { label: "explicit false", callback: () => false, expected: false },
  ])("classifies $label followup progress", async ({ callback, expected }) => {
    let observed: boolean | void = undefined;
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      observed = await params.opts?.onPlanUpdate?.({ title: "queued plan" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn: createTurn(),
      defaults: {
        typing: createTypingController(),
        typingMode: "never",
        defaultModel: "claude",
        opts: { onPlanUpdate: callback },
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(observed).toBe(expected);
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

    await expect(detachedProgress).resolves.toBe(false);
    await expect(result.progress.drain()).rejects.toBe(failure);
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
        outcome: {
          kind: "rejected",
          payload: { isError: true },
        },
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
