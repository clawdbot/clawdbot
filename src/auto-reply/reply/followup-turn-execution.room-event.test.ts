import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRoomEventSource } from "../../../test/helpers/admitted-room-event-source.js";
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

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: (...args: unknown[]) => state.loadEntryReadOnly(...args),
}));

const { executeFollowupTurn } = await import("./followup-turn-execution.js");

const capabilityCleanups = new Set<() => void>();

afterEach(() => {
  for (const cleanup of capabilityCleanups) {
    cleanup();
  }
  capabilityCleanups.clear();
});

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

describe("executeFollowupTurn room-event delivery", () => {
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
    const onPartialReply = vi.fn(async () => true as const);
    const onAssistantMessageStart = vi.fn(async () => true as const);
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.typingSignals.signalRunStart();
      await params.opts?.onPartialReply?.({ text: "private partial" });
      await params.opts?.onAssistantMessageStart?.();
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
          onPartialReply,
          onAssistantMessageStart,
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
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onAssistantMessageStart).not.toHaveBeenCalled();
  });

  it("keeps automatic room-event partial previews silent without retained host authority", async () => {
    const onPartialReply = vi.fn(async () => true as const);
    const onAssistantMessageStart = vi.fn(async () => true as const);
    const turn = createTurn({
      queued: {
        ...createTurn().queued,
        currentInboundEventKind: "room_event",
        queuedSourceReplyDelivery: {
          deliver: vi.fn(async () => "delivered" as const),
          presentationOptions: { onPartialReply, onAssistantMessageStart },
        },
        run: { ...createTurn().queued.run, sourceReplyDeliveryMode: "automatic" },
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      expect(params.opts?.onPartialReply).toBeUndefined();
      expect(params.opts?.onAssistantMessageStart).toBeUndefined();
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    await executeFollowupTurn({
      turn,
      defaults: {
        typing: createTypingController(),
        typingMode: "instant",
        defaultModel: "claude",
        opts: turn.queued.queuedSourceReplyDelivery?.presentationOptions,
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onAssistantMessageStart).not.toHaveBeenCalled();
  });

  it("reopens retained preview progress for an authorized automatic queued room event", async () => {
    const source = await createAdmittedRoomEventSource();
    capabilityCleanups.add(source.retire);
    const typing = createTypingController();
    const onChannelToolResult = vi.fn(async () => true as const);
    const onToolStart = vi.fn(async () => true as const);
    const onItemEvent = vi.fn(async () => true as const);
    const onPlanUpdate = vi.fn(async () => true as const);
    const onCompactionStart = vi.fn(async () => true as const);
    const onCompactionEnd = vi.fn(async () => true as const);
    const onReasoningEnd = vi.fn(async () => true as const);
    const onNarrationUpdate = vi.fn(async () => {});
    const onPartialReply = vi.fn(async () => true as const);
    const onAssistantMessageStart = vi.fn(async () => true as const);
    const presentationOptions = {
      forceToolResultProgress: true,
      onToolResult: onChannelToolResult,
      onToolStart,
      onItemEvent,
      onPlanUpdate,
      onCompactionStart,
      onCompactionEnd,
      onReasoningEnd,
      onNarrationUpdate,
      onPartialReply,
      onAssistantMessageStart,
    };
    const turn = createTurn({
      queued: {
        ...createTurn().queued,
        currentInboundEventKind: "room_event",
        queuedSourceReplyDelivery: source.createQueuedSourceReplyDelivery({
          deliver: vi.fn(async () => "delivered" as const),
          presentationOptions,
        }),
        run: {
          ...createTurn().queued.run,
          sourceReplyDeliveryMode: "automatic",
        },
      },
      session: {
        kind: "session",
        key: "main",
        current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "off" }),
        publish: () => undefined,
        adopt: () => undefined,
      },
    });
    state.execute.mockImplementation(async (params: AgentTurnParams) => {
      await params.typingSignals.signalRunStart();
      await params.opts?.onPartialReply?.({ text: "preview partial" });
      await params.opts?.onAssistantMessageStart?.();
      await params.opts?.onToolStart?.({ name: "exec", phase: "start" });
      await params.opts?.onToolResult?.({ text: "preview tool progress" });
      await params.opts?.onItemEvent?.({ kind: "tool", progressText: "preview item progress" });
      await params.opts?.onPlanUpdate?.({ title: "preview plan" });
      await params.opts?.onCompactionStart?.();
      await params.opts?.onCompactionEnd?.();
      await params.opts?.onReasoningEnd?.();
      await params.opts?.onNarrationUpdate?.({ text: "preview narration" });
      return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
    });

    const result = await executeFollowupTurn({
      turn,
      defaults: {
        typing,
        typingMode: "instant",
        defaultModel: "claude",
        // createFollowupRunner projects this exact retained object for the queued turn.
        opts: presentationOptions,
      },
      onToolResult: vi.fn(async () => {}),
      onCompactionNoticePayload: vi.fn(async () => {}),
    });
    await result.progress.drain();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(onPartialReply).toHaveBeenCalledWith({ text: "preview partial" });
    expect(onAssistantMessageStart).toHaveBeenCalledOnce();
    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onChannelToolResult).toHaveBeenCalledWith({ text: "preview tool progress" });
    expect(onItemEvent).toHaveBeenCalledWith({
      kind: "tool",
      progressText: "preview item progress",
    });
    expect(onPlanUpdate).toHaveBeenCalledWith({ title: "preview plan" });
    expect(onCompactionStart).toHaveBeenCalledOnce();
    expect(onCompactionEnd).toHaveBeenCalledOnce();
    expect(onReasoningEnd).toHaveBeenCalledOnce();
    expect(onNarrationUpdate).toHaveBeenCalledWith({ text: "preview narration" });
  });
});
