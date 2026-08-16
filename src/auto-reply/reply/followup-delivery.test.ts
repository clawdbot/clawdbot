// Tests follow-up reply delivery and route preservation.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnExecutionResult } from "./agent-runner-execution.types.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery-payloads.js";
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

const baseConfig = {} as OpenClawConfig;

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops payloads without visible content", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: " \t\n " }, { text: "", mediaUrls: [" "] }],
      }),
    ).toEqual([]);
  });

  it("keeps rich content when text is blank", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: " ", mediaUrl: "file:///tmp/reply.png" }],
      }),
    ).toMatchObject([{ text: " ", mediaUrl: "file:///tmp/reply.png" }]);
  });

  it("drops a durable reasoning payload when reasoningPayloadsEnabled is not set", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "internal reasoning", isReasoning: true }, { text: "final answer" }],
      }),
    ).toEqual([{ text: "final answer" }]);
  });

  it("keeps a durable reasoning payload when reasoningPayloadsEnabled is true", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "internal reasoning", isReasoning: true }, { text: "final answer" }],
        reasoningPayloadsEnabled: true,
      }),
    ).toEqual([{ text: "internal reasoning", isReasoning: true }, { text: "final answer" }]);
  });

  it("drops commentary unless its delivery lane is enabled", () => {
    const payload = { text: "internal commentary", isCommentary: true };
    expect(resolveFollowupDeliveryPayloads({ cfg: baseConfig, payloads: [payload] })).toEqual([]);
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [payload],
        commentaryPayloadsEnabled: true,
      }),
    ).toMatchObject([payload]);
  });

  it("drops heartbeat ack payloads without media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK" }],
      }),
    ).toStrictEqual([]);
  });

  it("keeps media payloads when stripping heartbeat ack text", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "/tmp/image.png" }],
      }),
    ).toEqual([{ text: "", mediaUrl: "/tmp/image.png" }]);
  });

  it("preserves transcript ownership when stripping heartbeat text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "HEARTBEAT_OK still working" },
      { assistantTranscriptOwned: true },
    );

    const [resolved] = resolveFollowupDeliveryPayloads({
      cfg: baseConfig,
      payloads: [payload],
    });

    expect(getReplyPayloadMetadata(resolved ?? {})).toEqual({
      assistantTranscriptOwned: true,
      replyDelivery: {
        replyToMode: "all",
      },
    });
  });

  it("uses the captured reply policy instead of reloading changed config", () => {
    const [resolved] = resolveFollowupDeliveryPayloads({
      cfg: {
        channels: {
          slack: {
            replyToMode: "all",
          },
        },
      } as OpenClawConfig,
      payloads: [{ text: "queued reply" }],
      originatingChannel: "slack",
      originatingChatType: "channel",
      originatingReplyToMode: "off",
    });

    expect(getReplyPayloadMetadata(resolved ?? {})?.replyDelivery).toEqual({
      chatType: "channel",
      replyToMode: "off",
    });
  });

  it("drops text payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        sentTexts: ["hello world!"],
      }),
    ).toStrictEqual([]);
  });

  it("drops media payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        sentMediaUrls: ["/tmp/img.png"],
      }),
    ).toEqual([{ mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("does not dedupe text sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("does not dedupe media sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("dedupes final text only against message-tool text sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "discord-only text" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["slack text", "discord-only text"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1", text: "slack text" },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            text: "discord-only text",
          },
        ],
      }),
    ).toEqual([{ text: "discord-only text" }]);
  });

  it("does not dedupe same-channel text sent to a different routed thread", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "thread reply" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        originatingThreadId: "222.000",
        sentTexts: ["thread reply"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "thread reply",
          },
        ],
      }),
    ).toEqual([{ text: "thread reply" }]);
  });

  it("dedupes same-channel text sent to the same routed thread", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "thread reply" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        originatingThreadId: "111.000",
        sentTexts: ["thread reply"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            threadId: "111.000",
            text: "thread reply",
          },
        ],
      }),
    ).toStrictEqual([]);
  });

  it("dedupes a Slack DM tool send recorded through its routable target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "thread reply" }],
        messageProvider: "slack",
        originatingTo: "user:U123",
        originatingThreadId: "171.222",
        sentTexts: ["thread reply"],
        sentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "user:U123",
            threadId: "171.222",
            text: "thread reply",
          },
        ],
      }),
    ).toStrictEqual([]);
  });

  it("does not apply ambiguous global text evidence across multiple routes", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toStrictEqual([{ text: "hello world!" }]);
  });

  it("dedupes final media only against message-tool media sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/slack-photo.jpg", "file:///tmp/discord-photo.jpg"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            mediaUrls: ["file:///tmp/slack-photo.jpg"],
          },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            mediaUrls: ["file:///tmp/discord-photo.jpg"],
          },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }]);
  });

  it("does not apply ambiguous global media evidence across multiple routes", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("delivers distinct replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("dedupes duplicate replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1", text: "hello world!" }],
      }),
    ).toStrictEqual([]);
  });

  it("delivers distinct replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});

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

describe("resolveFollowupDeliveryDecision", () => {
  it("delivers a yield acknowledgment after accepting a child spawn", () => {
    const execution = createSettledExecution();
    if (execution.outcome.kind === "settled") {
      execution.outcome.result.meta = {
        durationMs: 0,
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      };
      execution.outcome.result.acceptedSessionSpawns = [
        { runId: "child", childSessionKey: "agent:main:child" },
      ];
    }

    expect(
      resolveFollowupDeliveryDecision({
        turn: createTurn(),
        execution,
        accounting: createAccounting(),
      }),
    ).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "Research started; results will follow." }],
    });
  });

  it("delivers a yield acknowledgment in configured group message-tool-only mode", () => {
    const turn = createTurn();
    turn.queued.originatingChatType = "group";
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const execution = createSettledExecution();
    if (execution.outcome.kind === "settled") {
      execution.outcome.result.meta = {
        durationMs: 0,
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      };
    }

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution,
        accounting: createAccounting(),
      }),
    ).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "Research started; results will follow." }],
    });
  });

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

  it("honors the admission-time send policy before any final projection", () => {
    expect(
      resolveFollowupDeliveryDecision({
        turn: createTurn({ sendPolicy: "deny" }),
        execution: createSettledExecution("blocked"),
      }),
    ).toEqual({ kind: "suppress", reason: "send-policy" });
  });

  it("suppresses a settled result whose accepted abort still requires accounting", () => {
    const execution = createSettledExecution("late reply");
    if (execution.outcome.kind === "settled") {
      execution.outcome.abortReason = "user";
    }

    expect(
      resolveFollowupDeliveryDecision({
        turn: createTurn(),
        execution,
        accounting: createAccounting([{ text: "late reply" }]),
      }),
    ).toEqual({ kind: "suppress", reason: "aborted" });
  });

  it("does not leak rejected private text in message-tool-only mode", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: {
          runId: "run-1",
          outcome: { kind: "rejected", payload: { text: "private failure detail" } },
        },
      }),
    ).toEqual({ kind: "suppress", reason: "message-tool-only" });
  });

  it("keeps rejected failures silent for internal follow-ups", () => {
    const turn = createTurn();
    turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: {
          runId: "run-1",
          outcome: { kind: "rejected", payload: { text: "internal failure" } },
        },
      }),
    ).toEqual({ kind: "suppress", reason: "silent" });
  });

  it("keeps provenance-less internal-channel failures non-interactive", () => {
    const turn = createTurn();
    turn.queued.originatingChannel = "webchat";
    turn.queued.run.messageProvider = "webchat";

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: {
          runId: "run-1",
          outcome: { kind: "rejected", payload: { text: "internal failure" } },
        },
        opts: { onBlockReply: vi.fn(async () => {}) },
      }),
    ).toEqual({ kind: "suppress", reason: "silent" });
  });

  it("normalizes rejected failures with the originating delivery context", () => {
    const turn = createTurn();
    turn.queued.originatingChatType = "group";
    turn.queued.originatingReplyToMode = "all";
    const payload = setReplyPayloadMetadata(
      { text: "visible failure", isError: true },
      { deliverDespiteSourceReplySuppression: true },
    );

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: {
        runId: "run-1",
        outcome: { kind: "rejected", payload },
      },
    });

    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
        chatType: "group",
        replyToMode: "all",
      });
    }
  });

  it("creates one priority retry for a substantive message-tool-only final", () => {
    const substantiveFinal =
      "This is a substantive private answer that should have used the message tool. It has a second sentence so recovery is required.";
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(substantiveFinal),
      accounting: createAccounting(),
    });

    expect(decision).toMatchObject({
      kind: "retry-source-delivery",
      run: { strandedReplyRetry: true, disableCollectBatching: true },
    });
  });

  it("delivers explicitly allowed payloads before considering stranded recovery", () => {
    const substantiveFinal =
      "This is a substantive private answer that missed the message tool. It would normally trigger recovery.";
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const explicitPayload = setReplyPayloadMetadata(
      { mediaUrl: "file:///tmp/generated.png" },
      { deliverDespiteSourceReplySuppression: true },
    );

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(substantiveFinal),
      accounting: createAccounting([explicitPayload]),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ mediaUrl: explicitPayload.mediaUrl }],
    });
  });

  it("normalizes explicitly allowed payloads before skipping stranded recovery", () => {
    const substantiveFinal =
      "This is a substantive private answer that missed the message tool. It must still trigger recovery when the marked payload is not deliverable.";
    const rawPayloads: ReplyPayload[] = [
      { text: "   " },
      { text: "HEARTBEAT_OK" },
      { text: "hidden reasoning", isReasoning: true },
    ];

    for (const rawPayload of rawPayloads) {
      const turn = createTurn();
      turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      const explicitPayload = setReplyPayloadMetadata(rawPayload, {
        deliverDespiteSourceReplySuppression: true,
      });

      expect(
        resolveFollowupDeliveryDecision({
          turn,
          execution: createSettledExecution(substantiveFinal),
          accounting: createAccounting([explicitPayload]),
        }),
      ).toMatchObject({ kind: "retry-source-delivery" });
    }
  });

  it("routes settled delivery with the actual runtime provider", () => {
    const decision = resolveFollowupDeliveryDecision({
      turn: createTurn(),
      execution: createSettledExecution(),
      accounting: createAccounting([{ text: "done" }], {
        providerUsed: "claude-cli",
        modelUsed: "claude-sonnet-4-6",
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      resolved: { provider: "claude-cli", model: "claude-sonnet-4-6" },
    });
  });

  it("normalizes auto-compaction notices with the originating delivery context", () => {
    const turn = createTurn();
    turn.queued.originatingChatType = "group";
    turn.queued.originatingReplyToMode = "all";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting([{ text: "done" }], {
        compactionNotice: { text: "compacted" },
      }),
    });

    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      expect(getReplyPayloadMetadata(decision.payloads[0] ?? {})?.replyDelivery).toEqual({
        chatType: "group",
        replyToMode: "all",
      });
    }
  });

  it("turns a second missing source delivery into a sanitized diagnostic", () => {
    const turn = createTurn();
    turn.queued.strandedReplyRetry = true;
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution(),
        accounting: createAccounting(),
      }),
    ).toMatchObject({
      kind: "deliver-diagnostic",
      payload: { isError: true, isStatusNotice: true },
    });
  });

  it("keeps terminal failure fallback silent for internal follow-ups", () => {
    const turn = createTurn();
    turn.queued.run.inputProvenance = { kind: "internal_system", sourceTool: "test" };

    expect(
      resolveFollowupDeliveryDecision({
        turn,
        execution: createSettledExecution(),
        accounting: createAccounting([], {
          terminalFailurePayload: { text: "internal failure", isError: true },
        }),
      }),
    ).toEqual({ kind: "suppress", reason: "silent" });
  });

  it("delivers a sanitized terminal failure in message-tool-only mode", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting([], {
        terminalFailurePayload: { text: "terminal failure", isError: true },
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "terminal failure", isError: true }],
    });
  });

  it("delivers a sanitized fallback for an empty message-tool-only completion", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting(),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [
        {
          text: expect.stringContaining("did not produce a visible reply"),
          isError: true,
        },
      ],
    });
    if (decision.kind === "deliver") {
      expect(
        getReplyPayloadMetadata(decision.payloads[0] ?? {})?.deliverDespiteSourceReplySuppression,
      ).toBe(true);
    }
  });

  it("keeps a terminal failure when suppressed partial output is present", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution: createSettledExecution(),
      accounting: createAccounting([{ text: "private partial" }], {
        terminalFailurePayload: { text: "terminal failure", isError: true },
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "terminal failure", isError: true }],
    });
  });

  it("prefers terminal failure over stranded-text recovery", () => {
    const turn = createTurn();
    turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
    const execution = createSettledExecution(
      "This incomplete private text is substantive. It must not replace the sanitized failure.",
    );

    const decision = resolveFollowupDeliveryDecision({
      turn,
      execution,
      accounting: createAccounting([], {
        terminalFailurePayload: { text: "terminal failure", isError: true },
      }),
    });

    expect(decision).toMatchObject({
      kind: "deliver",
      payloads: [{ text: "terminal failure", isError: true }],
    });
  });
});

describe("deliverFollowupDecision", () => {
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

  it("keeps dispatcher-only delivery out of a routable origin", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.followupRoute = { route: "dispatcher" };
    deliveryState.routeReply.mockReset();

    try {
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "dispatcher only" }] },
        turn: createTurn(),
        defaults: createDefaults(onBlockReply),
        runId: "run-1",
        runFollowup: vi.fn(async () => {}),
      });

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(deliveryState.routeReply).not.toHaveBeenCalled();
    } finally {
      deliveryState.followupRoute = undefined;
    }
  });

  it("never forwards cross-channel reply content to the live dispatcher on route failure", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "offline",
    });
    const turn = createTurn();
    turn.queued.run.messageProvider = "slack";

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "private reply" }] },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).toHaveBeenCalledOnce();
    const notice = onBlockReply.mock.calls[0]?.[0];
    expect(notice?.text).not.toContain("private reply");
    expect(notice?.text).toContain("could not deliver");
  });

  it("reports a later transcript-owned cross-channel failure after an earlier payload delivers", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply
      .mockResolvedValueOnce({ ok: true, delivered: true })
      .mockResolvedValueOnce({ ok: false, delivered: false, error: "offline" });
    const turn = createTurn();
    turn.queued.run.messageProvider = "slack";
    const finalPayload = setReplyPayloadMetadata(
      { text: "transcript-owned final" },
      { assistantTranscriptOwned: true },
    );

    await deliverFollowupDecision({
      decision: {
        kind: "deliver",
        payloads: [{ text: "earlier status" }, finalPayload],
      },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(deliveryState.routeReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenCalledOnce();
    const notice = onBlockReply.mock.calls[0]?.[0];
    expect(notice?.text).not.toContain("transcript-owned final");
    expect(notice?.text).toContain("could not deliver");
  });

  it("allows the latest same-channel dispatcher to recover a route failure", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "offline",
    });
    const turn = createTurn();
    turn.queued.run.messageProvider = "discord";

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "same-channel reply" }] },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "same-channel reply" }),
    );
  });

  it("keeps block-status delivery out of the assistant transcript", async () => {
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({ ok: true, delivered: true });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "compacting" }] },
      turn: createTurn(),
      defaults: createDefaults(vi.fn(async (_payload: ReplyPayload) => {})),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
      kind: "block",
    });

    expect(deliveryState.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({ mirror: false, replyKind: "block" }),
    );
  });

  it("reports an origin delivery failure when no dispatcher can recover it", async () => {
    deliveryState.routeReply.mockReset();
    deliveryState.runtimeError.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "offline",
    });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "undelivered" }] },
      turn: createTurn(),
      defaults: {
        defaultModel: "claude",
        typingMode: "never",
        typing: createDefaults(vi.fn(async (_payload: ReplyPayload) => {})).typing,
      },
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(deliveryState.runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("route-reply failed: offline"),
    );
  });

  it("does not duplicate a follow-up after a partial route failure delivered it", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: false,
      delivered: true,
      error: "later chunk failed",
    });
    const turn = createTurn();
    turn.queued.run.messageProvider = "discord";

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "already delivered" }] },
      turn,
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not retry a channel-transform-suppressed routed follow-up", async () => {
    const onBlockReply = vi.fn(async (_payload: ReplyPayload) => {});
    deliveryState.routeReply.mockReset();
    deliveryState.routeReply.mockResolvedValue({
      ok: true,
      delivered: false,
      suppressed: true,
      reason: "channel_transform",
    });

    await deliverFollowupDecision({
      decision: { kind: "deliver", payloads: [{ text: "private reply" }] },
      turn: createTurn(),
      defaults: createDefaults(onBlockReply),
      runId: "run-1",
      runFollowup: vi.fn(async () => {}),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
  });
});
