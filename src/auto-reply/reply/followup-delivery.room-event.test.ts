// Tests follow-up reply delivery and route preservation.
import { describe, expect, it, vi } from "vitest";
import { createAdmittedRoomEventSource } from "../../../test/helpers/admitted-room-event-source.js";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { deliverFollowupDecision, resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

const deliveryState = vi.hoisted(() => ({
  followupRoute: undefined as { route: "dispatcher" | "origin" | "drop" } | undefined,
  routeReply: vi.fn(),
  runtimeError: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => deliveryState.followupRoute,
  }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: (...args: unknown[]) => deliveryState.runtimeError(...args) },
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => channel === "discord" || channel === "slack",
  routeReply: (...args: unknown[]) => deliveryState.routeReply(...args),
}));

function createTurn(overrides: Partial<AdmittedFollowupTurn> = {}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
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
        messageProvider: "discord",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

function createSettledExecution(finalText = ""): AgentTurnExecutionResult {
  return {
    runId: "run-1",
    outcome: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: finalText ? [{ text: finalText }] : [],
        meta: { durationMs: 0, finalAssistantVisibleText: finalText },
      },
      resolved: { provider: "anthropic", model: "claude" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
  };
}

function createAccounting(
  payloadArray: ReplyPayload[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    payloadArray,
    providerUsed: "anthropic",
    modelUsed: "claude",
    preserveUserFacingSessionState: false,
    replyUsageState: {},
    usage: undefined,
    terminalFailurePayload: undefined,
    ...overrides,
  } as never;
}

describe("follow-up room-event delivery", () => {
  it("keeps ambient room-event finals silent", () => {
    const turn = createTurn({
      queued: {
        ...createTurn().queued,
        currentInboundEventKind: "room_event",
      },
    });

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution("private room final"),
      }),
    ).toEqual({ kind: "suppress", reason: "room-event" });
  });

  it.each([
    {
      label: "without authority",
      sourceReplyDeliveryMode: undefined,
      queuedSourceReplyDelivery: undefined,
      opts: undefined,
    },
    {
      label: "with automatic mode alone",
      sourceReplyDeliveryMode: "automatic" as const,
      queuedSourceReplyDelivery: {
        deliver: vi.fn(async () => "delivered" as const),
        presentationOptions: {},
      },
      opts: undefined,
    },
    {
      label: "with a retained structural lookalike alone",
      sourceReplyDeliveryMode: "message_tool_only" as const,
      queuedSourceReplyDelivery: {
        deliver: vi.fn(async () => "delivered" as const),
        presentationOptions: {},
      },
      opts: undefined,
    },
    {
      label: "with automatic mode and no retained source owner",
      sourceReplyDeliveryMode: "automatic" as const,
      queuedSourceReplyDelivery: undefined,
      opts: undefined,
    },
  ])(
    "keeps queued room-event finals silent $label",
    ({ sourceReplyDeliveryMode, queuedSourceReplyDelivery, opts }) => {
      const turn = createTurn();
      turn.queued.currentInboundEventKind = "room_event";
      turn.queued.run.sourceReplyDeliveryMode = sourceReplyDeliveryMode;
      turn.queued.queuedSourceReplyDelivery = queuedSourceReplyDelivery;

      expect(
        resolveFollowupDeliveryDecision({
          turn,
          execution: createSettledExecution("private room final"),
          accounting: createAccounting([{ text: "private room final" }]),
          opts,
        }),
      ).toEqual({ kind: "suppress", reason: "room-event" });
    },
  );

  it("keeps send-policy denial ahead of authorized queued room-event delivery", async () => {
    const source = await createAdmittedRoomEventSource();
    const turn = createTurn({ sendPolicy: "deny" });
    turn.queued.currentInboundEventKind = "room_event";
    turn.queued.run.sourceReplyDeliveryMode = "automatic";
    turn.queued.queuedSourceReplyDelivery = source.createQueuedSourceReplyDelivery({
      deliver: vi.fn(async () => "delivered" as const),
    });

    try {
      expect(
        resolveFollowupDeliveryDecision({
          turn,
          execution: createSettledExecution("blocked authorized final"),
          accounting: createAccounting([{ text: "blocked authorized final" }]),
        }),
      ).toEqual({ kind: "suppress", reason: "send-policy" });
    } finally {
      source.retire();
    }
  });

  const createDefaults = (onBlockReply: (payload: ReplyPayload) => Promise<void>) => ({
    defaultModel: "claude",
    typingMode: "never" as const,
    typing: {
      onReplyStart: vi.fn(async () => {}),
      startTypingLoop: vi.fn(async () => {}),
      startTypingOnText: vi.fn(async () => {}),
      refreshTypingTtl: vi.fn(),
      isActive: vi.fn(() => false),
      markRunComplete: vi.fn(),
      markDispatchIdle: vi.fn(),
      cleanup: vi.fn(),
    },
    opts: { onBlockReply },
  });
  it("resolves and delivers an authorized queued room-event final through its retained owner", async () => {
    const source = await createAdmittedRoomEventSource();
    const retainedDeliver = vi.fn(async () => "delivered" as const);
    const latestOnBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    const turn = createTurn();
    turn.queued.currentInboundEventKind = "room_event";
    turn.queued.run.sourceReplyDeliveryMode = "automatic";
    turn.queued.queuedSourceReplyDelivery = source.createQueuedSourceReplyDelivery({
      deliver: retainedDeliver,
    });
    try {
      const decision = resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution("authorized queued final"),
        accounting: createAccounting([{ text: "authorized queued final" }]),
      });

      expect(decision).toMatchObject({
        kind: "deliver",
        payloads: [{ text: "authorized queued final" }],
      });
      await deliverFollowupDecision({
        decision,
        turn,
        defaults: createDefaults(latestOnBlockReply),
        runId: "authorized-queued-run",
        runFollowup: vi.fn(async () => {}),
      });

      expect(retainedDeliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "authorized queued final" }),
        { kind: "final", runId: "authorized-queued-run" },
      );
    } finally {
      source.retire();
    }
    expect(latestOnBlockReply).not.toHaveBeenCalled();
    expect(deliveryState.routeReply).not.toHaveBeenCalled();
  });

  it("delivers only a deferred host-final payload after a retained room owner downgrades to tool-only", async () => {
    const source = await createAdmittedRoomEventSource();
    const retainedDeliver = vi.fn(async () => "delivered" as const);
    const latestOnBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    const turn = createTurn();
    turn.queued.currentInboundEventKind = "room_event";
    turn.queued.originatingChannel = "matrix";
    turn.queued.run.messageProvider = "matrix";
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    turn.queued.queuedSourceReplyDelivery = source.createQueuedSourceReplyDelivery({
      deliver: retainedDeliver,
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["NO_REPLY"],
      lastAssistant: undefined,
      currentAssistant: undefined,
      sessionKey: "main",
      messagingToolSourceReplyPayloads: [
        { text: "host-owned queued final", hostFinalDeferred: true },
      ],
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(payloads).toHaveLength(1);
    expect(getReplyPayloadMetadata(payloads[0] as object)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
    });
    try {
      const ordinaryDecision = resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution("ordinary model final"),
        accounting: createAccounting([{ text: "ordinary model final" }]),
      });
      expect(ordinaryDecision).toEqual({ kind: "suppress", reason: "message-tool-only" });

      const decision = resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution("NO_REPLY"),
        accounting: createAccounting(payloads),
      });

      expect(decision).toMatchObject({
        kind: "deliver",
        payloads: [{ text: "host-owned queued final" }],
      });
      await deliverFollowupDecision({
        decision,
        turn,
        defaults: createDefaults(latestOnBlockReply),
        runId: "host-final-queued-run",
        runFollowup: vi.fn(async () => {}),
      });

      expect(retainedDeliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "host-owned queued final" }),
        { kind: "final", runId: "host-final-queued-run" },
      );
    } finally {
      source.retire();
    }
    expect(latestOnBlockReply).not.toHaveBeenCalled();
    expect(deliveryState.routeReply).not.toHaveBeenCalled();
  });
});
