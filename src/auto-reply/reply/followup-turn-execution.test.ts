import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTypingController,
  createFollowupTurnTestTurn,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

const state = getFollowupTurnTestState();
const createTypingController = createFollowupTurnTestTypingController;
const createTurn = createFollowupTurnTestTurn;
const executeFollowupTurn = executeFollowupTurnForTest;

beforeEach(resetFollowupTurnTestState);

async function runFastAutoProgressCase(params: {
  currentInboundEventKind?: "room_event";
  verboseLevel?: "on" | "off";
  sourceReplyDeliveryMode?: "message_tool_only";
  includeChannelCallback?: boolean;
  callbackResult?: boolean;
  opts?: NonNullable<Parameters<typeof executeFollowupTurn>[0]["defaults"]["opts"]>;
  payload?: ReplyPayload;
}) {
  const payload =
    params.payload ??
    ({
      text: "💨Fast: auto-on",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload);
  const onChannelToolResult = vi.fn(() => params.callbackResult);
  const onDurableToolResult = vi.fn(async () => {});
  const turn = createTurn({
    session: {
      kind: "session",
      key: "main",
      current: () => ({
        sessionId: "session",
        updatedAt: 1,
        verboseLevel: params.verboseLevel ?? "on",
      }),
      publish: () => undefined,
      adopt: () => undefined,
    },
  });
  turn.queued.currentInboundEventKind = params.currentInboundEventKind;
  turn.queued.run.sourceReplyDeliveryMode = params.sourceReplyDeliveryMode;
  state.execute.mockImplementation(async (turnParams: AgentTurnParams) => {
    await turnParams.opts?.onToolResult?.(payload);
    return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
  });

  const result = await executeFollowupTurn({
    turn,
    defaults: {
      typing: createTypingController(),
      typingMode: "never",
      defaultModel: "claude",
      opts: {
        ...params.opts,
        ...(params.includeChannelCallback === false ? {} : { onToolResult: onChannelToolResult }),
      },
    },
    onToolResult: onDurableToolResult,
    onCompactionNoticePayload: vi.fn(async () => {}),
  });
  await result.progress.drain();
  return { onChannelToolResult, onDurableToolResult, payload };
}

describe("executeFollowupTurn", () => {
  it.each([false, true])(
    "records each source receipt without changing newer runner state (preflight: %s)",
    async (preflight) => {
      const receipts: ReplyOperationRunState[] = [{}, {}];
      const newerReceipt: ReplyOperationRunState = {};
      const turn = createTurn();
      turn.queued.replyOperationRunStates = receipts;
      if (preflight) {
        turn.preflightFailurePayload = { text: "preflight failed" };
      }

      await executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: { [REPLY_OPERATION_RUN_STATE]: newerReceipt },
        },
        onToolResult: vi.fn(async () => {}),
        onCompactionNoticePayload: vi.fn(async () => {}),
      });

      expect(receipts.map(resolveReplyOperationAgentTurn)).toEqual(["failed", "failed"]);
      expect(resolveReplyOperationAgentTurn(newerReceipt)).toBeUndefined();
      expect(state.execute).toHaveBeenCalledTimes(preflight ? 0 : 1);
    },
  );

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

  it.each(["off", "on", "full"] as const)(
    "keeps explicit turn verbosity %s despite live-session changes",
    async (selected) => {
      let liveLevel: "on" | "off" = selected === "off" ? "on" : "off";
      const turn = createTurn({
        session: {
          kind: "session",
          key: "main",
          current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: liveLevel }),
          publish: () => undefined,
          adopt: () => undefined,
        },
      });
      turn.queued.run.verboseLevelOverride = selected;
      const toolResult = vi.fn(async () => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        expect(params.resolvedVerboseLevel).toBe(selected);
        expect(params.shouldEmitToolResult()).toBe(selected !== "off");
        expect(params.shouldEmitToolOutput()).toBe(selected === "full");
        liveLevel = liveLevel === "off" ? "on" : "off";
        expect(params.shouldEmitToolResult()).toBe(selected !== "off");
        if (params.shouldEmitToolResult()) {
          await params.opts?.onToolResult?.({ text: "TOOL_STATUS" });
        }
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });
      const result = await executeFollowupTurn({
        turn,
        defaults: { typing: createTypingController(), typingMode: "never", defaultModel: "claude" },
        onToolResult: toolResult,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();
      expect(toolResult).toHaveBeenCalledTimes(selected === "off" ? 0 : 1);
    },
  );

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

  it("keeps queued fast auto progress hidden at verbosity off", async () => {
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      verboseLevel: "off",
    });
    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("routes queued visible fast auto progress through the channel once", async () => {
    const payload = {
      text: "💨Fast: auto-off(75s>=60s)",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      callbackResult: true,
      payload,
    });
    expect(onChannelToolResult).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith(payload);
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("requires source-suppression opt-in before a queued fast auto callback owns delivery", async () => {
    const payload = {
      text: "💨Fast: auto-off(75s>=60s)",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      callbackResult: false,
      sourceReplyDeliveryMode: "message_tool_only",
      opts: { suppressDefaultToolProgressMessages: true },
      payload,
    });
    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).toHaveBeenCalledOnce();
    expect(onDurableToolResult).toHaveBeenCalledWith(payload, { runId: "run-1" });
  });

  it("lets an opted-in queued fast auto callback own source-suppressed delivery", async () => {
    const payload = {
      text: "💨Fast: auto-off(75s>=60s)",
      channelData: { openclawProgressKind: "fast-mode-auto" },
    } satisfies ReplyPayload;
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      callbackResult: true,
      sourceReplyDeliveryMode: "message_tool_only",
      opts: { allowProgressCallbacksWhenSourceDeliverySuppressed: true },
      payload,
    });
    expect(onChannelToolResult).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith(payload);
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("falls back once when a queued forced fast auto callback declines visibility", async () => {
    const { onChannelToolResult, onDurableToolResult, payload } = await runFastAutoProgressCase({
      callbackResult: false,
      opts: { forceToolResultProgress: true },
    });
    expect(onChannelToolResult).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith(payload);
    expect(onDurableToolResult).toHaveBeenCalledOnce();
    expect(onDurableToolResult).toHaveBeenCalledWith(payload, { runId: "run-1" });
  });

  it.each([true, undefined] as const)(
    "does not duplicate queued fast auto progress accepted with %s",
    async (callbackResult) => {
      const { onChannelToolResult, onDurableToolResult, payload } = await runFastAutoProgressCase({
        callbackResult,
        opts: { forceToolResultProgress: true },
      });
      expect(onChannelToolResult).toHaveBeenCalledOnce();
      expect(onChannelToolResult).toHaveBeenCalledWith(payload);
      expect(onDurableToolResult).not.toHaveBeenCalled();
    },
  );

  it("falls back once for queued forced fast auto progress without a channel callback", async () => {
    const { onDurableToolResult, payload } = await runFastAutoProgressCase({
      includeChannelCallback: false,
      opts: { forceToolResultProgress: true },
    });
    expect(onDurableToolResult).toHaveBeenCalledOnce();
    expect(onDurableToolResult).toHaveBeenCalledWith(payload, { runId: "run-1" });
  });

  it("routes queued hidden fast auto progress only to lifecycle callbacks", async () => {
    const { onChannelToolResult, onDurableToolResult, payload } = await runFastAutoProgressCase({
      verboseLevel: "off",
      callbackResult: false,
      opts: { allowToolLifecycleWhenProgressHidden: true },
    });
    expect(onChannelToolResult).toHaveBeenCalledOnce();
    expect(onChannelToolResult).toHaveBeenCalledWith(payload);
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it("suppresses queued fast auto callbacks when tool progress is disabled", async () => {
    const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
      verboseLevel: "off",
      callbackResult: false,
      opts: {
        forceToolResultProgress: true,
        suppressToolProgressMessages: true,
        allowToolLifecycleWhenProgressHidden: true,
      },
    });
    expect(onChannelToolResult).not.toHaveBeenCalled();
    expect(onDurableToolResult).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "lifecycle",
      verboseLevel: "off",
      opts: { allowToolLifecycleWhenProgressHidden: true },
    },
    { label: "verbose", verboseLevel: "on", opts: {} },
    { label: "forced", verboseLevel: "off", opts: { forceToolResultProgress: true } },
  ] as const)(
    "keeps queued room-event fast auto $label progress silent",
    async ({ opts, verboseLevel }) => {
      const { onChannelToolResult, onDurableToolResult } = await runFastAutoProgressCase({
        currentInboundEventKind: "room_event",
        verboseLevel,
        callbackResult: true,
        sourceReplyDeliveryMode: "message_tool_only",
        opts: {
          ...opts,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        },
      });
      expect(onChannelToolResult).not.toHaveBeenCalled();
      expect(onDurableToolResult).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    {
      label: "quiet draft",
      options: { suppressDefaultToolProgressMessages: true },
      sendPolicy: "allow",
      roomEvent: false,
      startVisible: true,
      structuredVisible: true,
    },
    {
      label: "lifecycle-only opt-in",
      options: { allowToolLifecycleWhenProgressHidden: true },
      sendPolicy: "allow",
      roomEvent: false,
      startVisible: true,
      structuredVisible: false,
    },
    {
      label: "denied draft",
      options: { suppressDefaultToolProgressMessages: true },
      sendPolicy: "deny",
      roomEvent: false,
      startVisible: false,
      structuredVisible: false,
    },
    {
      label: "room-event draft",
      options: { suppressDefaultToolProgressMessages: true },
      sendPolicy: "allow",
      roomEvent: true,
      startVisible: false,
      structuredVisible: false,
    },
  ] as const)(
    "keeps queued $label progress separate from generic summaries",
    async ({ options, sendPolicy, roomEvent, startVisible, structuredVisible }) => {
      const onToolStart = vi.fn(async () => true);
      const onItemEvent = vi.fn(async () => true);
      const onCommandOutput = vi.fn(async () => true);
      const onApprovalEvent = vi.fn(async () => true);
      const onPatchSummary = vi.fn(async () => true);
      const onChannelToolResult = vi.fn(async () => {});
      const onDurableToolResult = vi.fn(async () => {});
      const turn = createTurn({ sendPolicy });
      turn.queued.run.verboseLevelOverride = "off";
      if (roomEvent) {
        turn.queued.currentInboundEventKind = "room_event";
      }
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        expect(params.shouldEmitToolResult()).toBe(false);
        expect(params.shouldEmitToolOutput()).toBe(false);
        expect(await params.opts?.onToolStart?.({ name: "read", phase: "start" })).toBe(
          startVisible,
        );
        expect(await params.opts?.onItemEvent?.({ kind: "tool", status: "blocked" })).toBe(
          structuredVisible,
        );
        expect(
          await params.opts?.onCommandOutput?.({ name: "exec", phase: "end", exitCode: 0 }),
        ).toBe(structuredVisible);
        expect(await params.opts?.onApprovalEvent?.({ phase: "requested" })).toBe(
          structuredVisible,
        );
        expect(await params.opts?.onPatchSummary?.({ phase: "end", modified: ["file.ts"] })).toBe(
          structuredVisible,
        );
        if (params.shouldEmitToolResult()) {
          await params.opts?.onToolResult?.({ text: "Generic summary" });
        }
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            ...options,
            onToolStart,
            onItemEvent,
            onCommandOutput,
            onApprovalEvent,
            onPatchSummary,
            onToolResult: onChannelToolResult,
          },
        },
        onToolResult: onDurableToolResult,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();

      expect(onToolStart).toHaveBeenCalledTimes(startVisible ? 1 : 0);
      for (const callback of [onItemEvent, onCommandOutput, onApprovalEvent, onPatchSummary]) {
        expect(callback).toHaveBeenCalledTimes(structuredVisible ? 1 : 0);
      }
      expect(onChannelToolResult).not.toHaveBeenCalled();
      expect(onDurableToolResult).not.toHaveBeenCalled();
    },
  );

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
});
