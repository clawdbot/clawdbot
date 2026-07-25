import { describe, expect, it, vi } from "vitest";
import {
  ConversationDeliveryInputError,
  type ConversationDeliveryRecord,
} from "../config/sessions/conversation-delivery-store.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
import {
  claimPendingConversationTurnReply,
  registerPendingConversationTurn,
} from "../sessions/conversation-turns.js";
import { ConversationInputError } from "./conversation-errors.js";
import { runGatewayConversationTurn } from "./conversation-turn.js";

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:molty",
  sessionId: "reef-session",
  sessionKey: "agent:main:reef:direct:molty",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

function sentResult(
  messageId = "reef-outbound-1",
): Extract<MessageActionRunResult, { kind: "send" }> {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: conversation.target,
    handledBy: "core",
    payload: {},
    deliveredText: "hello molty",
    sendResult: {
      channel: "reef",
      to: conversation.target,
      via: "direct",
      mediaUrl: null,
      result: { messageId },
      deliveryStatus: "sent",
    },
    dryRun: false,
  };
}

function createDeps() {
  const operations = new Map<string, ConversationDeliveryRecord>();
  const update = (
    operationId: string,
    patch: Partial<ConversationDeliveryRecord>,
  ): ConversationDeliveryRecord => {
    const current = operations.get(operationId);
    if (!current) {
      throw new Error(`missing operation: ${operationId}`);
    }
    const next = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
    operations.set(operationId, next);
    return next;
  };
  return {
    beginOperation: vi.fn(
      (
        _scope: unknown,
        params: {
          operationId: string;
          operationKind: "send" | "turn";
          conversationRef: string;
          sourceSessionKey?: string;
          message: string;
          preparedMessageId?: string;
        },
      ) => {
        const existing = operations.get(params.operationId);
        if (existing) {
          if (
            existing.operationKind !== params.operationKind ||
            existing.conversationRef !== params.conversationRef ||
            existing.sourceSessionKey !== params.sourceSessionKey ||
            existing.messageHash !== params.message
          ) {
            throw new ConversationDeliveryInputError(
              `Conversation delivery operation was reused with different input: ${params.operationId}`,
            );
          }
          return { created: false, record: existing };
        }
        const record: ConversationDeliveryRecord = {
          operationId: params.operationId,
          operationKind: params.operationKind,
          conversationRef: params.conversationRef,
          channel: conversation.channel,
          ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
          messageHash: params.message,
          status: "created",
          ...(params.preparedMessageId ? { preparedMessageId: params.preparedMessageId } : {}),
          createdAt: 100,
          updatedAt: 100,
        };
        operations.set(params.operationId, record);
        return { created: true, record };
      },
    ),
    getOperation: vi.fn((_scope: unknown, operationId: string) => operations.get(operationId)),
    markQueued: vi.fn((_scope: unknown, operationId: string, queueId: string) =>
      update(operationId, { status: "queued", queueId }),
    ),
    markSent: vi.fn((_scope: unknown, operationId: string, platformMessageId?: string) =>
      update(operationId, {
        status: "sent",
        ...(platformMessageId ? { platformMessageId } : {}),
      }),
    ),
    markSuppressed: vi.fn((_scope: unknown, operationId: string) =>
      update(operationId, { status: "suppressed" }),
    ),
    markUnknown: vi.fn((_scope: unknown, operationId: string) =>
      update(operationId, { status: "unknown" }),
    ),
    registerPendingConversationTurn: vi.fn(registerPendingConversationTurn),
    resolveConversation: vi.fn((): ConversationRecord | undefined => conversation),
    resolveOutboundChannelPlugin: vi.fn(
      () =>
        ({
          outbound: { prepareConversationTurnMessageId: () => "reef-outbound-1" },
        }) as never,
    ),
    resolveOutboundSessionRoute: vi.fn(async () => ({
      sessionKey: conversation.sessionKey,
      baseSessionKey: conversation.sessionKey,
      peer: { kind: "direct" as const, id: "molty" },
      chatType: "direct" as const,
      from: "reef:molty",
      to: conversation.target,
    })),
    bindOutboundSessionEntry: vi.fn(async () => undefined),
    runMessageAction: vi.fn(async () => sentResult()) as never,
    operations,
    update,
  };
}

function persistIntent(input: Record<string, unknown>): void {
  const onDeliveryIntent = input.onDeliveryIntent as (intent: {
    id: string;
    channel: string;
    to: string;
    durability: "required";
  }) => void;
  onDeliveryIntent({
    id: "queue-1",
    channel: "reef",
    to: "molty",
    durability: "required",
  });
}

describe("runGatewayConversationTurn", () => {
  it("creates a context binding only when a discovered address starts a turn", async () => {
    const deps = createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.resolveConversation.mockReturnValueOnce(unbound).mockReturnValue(conversation);
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      persistIntent(input);
      return sentResult();
    }) as never;

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-directory-peer",
          conversationRef: conversation.conversationRef,
          message: "hello molty",
          timeoutMs: 1,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "timeout" });

    expect(deps.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "reef", target: "reef:molty" }),
    );
    expect(deps.bindOutboundSessionEntry).toHaveBeenCalledOnce();
    expect(deps.registerPendingConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: conversation.sessionId }),
    );
  });

  it("registers correlation before durable delivery and consumes a fast reply inline", async () => {
    const deps = createDeps();
    let capture: Promise<void> | undefined;
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      expect(input).toMatchObject({
        preparedMessageId: "reef-outbound-1",
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        suppressTranscriptMirror: true,
      });
      persistIntent(input);
      capture = claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: conversation.conversationRef,
        sessionId: conversation.sessionId,
        messageId: "reef-inbound-1",
        replyToId: "reef-outbound-1",
        text: "hello clawd",
        timestamp: 300,
      }).then((claim) => claim?.complete());
      return sentResult();
    }) as never;

    const result = await runGatewayConversationTurn(
      {
        config: {},
        agentId: "main",
        senderIsOwner: true,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        turnId: "turn-fast-reply",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
        timeoutMs: 1_000,
      },
      deps,
    );
    await capture;

    expect(result).toMatchObject({
      status: "replied",
      messageId: "reef-outbound-1",
      reply: { text: "hello clawd", replyToId: "reef-outbound-1" },
    });
    expect(deps.registerPendingConversationTurn.mock.invocationCallOrder[0]).toBeLessThan(
      (deps.runMessageAction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it("uses the durable prepared id when another process creates the operation during preflight", async () => {
    const deps = createDeps();
    let capture: Promise<void> | undefined;
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          deps.operations.set("turn-raced", {
            operationId: "turn-raced",
            operationKind: "turn",
            conversationRef: conversation.conversationRef,
            channel: conversation.channel,
            messageHash: "hello molty",
            status: "created",
            preparedMessageId: "reef-authoritative-a",
            createdAt: 100,
            updatedAt: 100,
          });
          return "reef-candidate-b";
        },
      },
    } as never);
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      expect(input).toMatchObject({ preparedMessageId: "reef-authoritative-a" });
      persistIntent(input);
      capture = claimPendingConversationTurnReply({
        agentId: "main",
        conversationRef: conversation.conversationRef,
        sessionId: conversation.sessionId,
        messageId: "reef-inbound-race",
        replyToId: "reef-authoritative-a",
        text: "durable id acknowledged",
        timestamp: 300,
      }).then((claim) => claim?.complete());
      return sentResult("reef-authoritative-a");
    }) as never;

    const result = await runGatewayConversationTurn(
      {
        config: {},
        agentId: "main",
        senderIsOwner: true,
        turnId: "turn-raced",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
        timeoutMs: 1_000,
      },
      deps,
    );
    await capture;

    expect(result).toMatchObject({
      status: "replied",
      messageId: "reef-authoritative-a",
      reply: { text: "durable id acknowledged", replyToId: "reef-authoritative-a" },
    });
  });

  it("returns a prior durable reply without sending again", async () => {
    const deps = createDeps();
    deps.operations.set("turn-replied", {
      operationId: "turn-replied",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageHash: "hello",
      status: "replied",
      preparedMessageId: "reef-outbound-1",
      platformMessageId: "reef-outbound-1",
      reply: { messageId: "reply-1", replyToId: "reef-outbound-1", text: "ack", timestamp: 300 },
      createdAt: 100,
      updatedAt: 300,
    });
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-replied",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "replied", reply: { text: "ack" } });
    expect(deps.resolveConversation).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("returns queued state without retrying recipient-visible I/O", async () => {
    const deps = createDeps();
    deps.operations.set("turn-queued", {
      operationId: "turn-queued",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageHash: "hello",
      status: "queued",
      preparedMessageId: "reef-outbound-1",
      queueId: "queue-existing",
      createdAt: 100,
      updatedAt: 200,
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-queued",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "queued", messageId: "reef-outbound-1" });
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("returns a durable permanent rejection as invalid input after restart", async () => {
    const deps = createDeps();
    deps.operations.set("turn-rejected", {
      operationId: "turn-rejected",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageHash: "hello",
      status: "rejected",
      preparedMessageId: "reef-outbound-1",
      queueId: "queue-rejected",
      rejectionError: "atomic message limit",
      createdAt: 100,
      updatedAt: 200,
    });

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-rejected",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expect(deps.runMessageAction).not.toHaveBeenCalled();
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
  });

  it("classifies durable operation-id input reuse as invalid input", async () => {
    const deps = createDeps();
    deps.operations.set("turn-reused", {
      operationId: "turn-reused",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageHash: "original",
      status: "sent",
      preparedMessageId: "reef-outbound-reused",
      createdAt: 100,
      updatedAt: 200,
    });
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-reused",
          conversationRef: conversation.conversationRef,
          message: "different",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationOperationConflictError",
      message: expect.stringContaining("reused with different input"),
    });
    expect(deps.resolveConversation).not.toHaveBeenCalled();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("requires a live binding before resuming an unfinished durable turn", async () => {
    const deps = createDeps();
    deps.operations.set("turn-created", {
      operationId: "turn-created",
      operationKind: "turn",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageHash: "hello",
      status: "created",
      preparedMessageId: "reef-outbound-created",
      createdAt: 100,
      updatedAt: 100,
    });
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-created",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.resolveOutboundChannelPlugin).not.toHaveBeenCalled();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("classifies a final rendered provider rejection as invalid input", async () => {
    const deps = createDeps();
    deps.runMessageAction = vi.fn(async () => {
      deps.update("turn-rendered-rejected", {
        status: "rejected",
        rejectionError: "atomic message limit",
      });
      throw new PlatformMessageNotDispatchedError("atomic message limit", {
        cause: new Error("rendered text is too large"),
        retryable: false,
      });
    }) as never;

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-rendered-rejected",
          conversationRef: conversation.conversationRef,
          message: "raw text passed preflight",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
  });

  it("rejects unsupported channels before registering or sending", async () => {
    const deps = createDeps();
    const {
      sessionId: _sessionId,
      sessionKey: _sessionKey,
      role: _role,
      ...unbound
    } = conversation;
    deps.resolveConversation.mockReturnValue(unbound);
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({ outbound: {} } as never);

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-unsupported",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.resolveOutboundSessionRoute).not.toHaveBeenCalled();
    expect(deps.bindOutboundSessionEntry).not.toHaveBeenCalled();
    expect(deps.beginOperation).not.toHaveBeenCalled();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("rejects channel preflight before creating a durable operation", async () => {
    const deps = createDeps();
    deps.resolveOutboundChannelPlugin.mockReturnValueOnce({
      outbound: {
        prepareConversationTurnMessageId: () => {
          throw new Error("atomic message limit");
        },
      },
    } as never);

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-preflight-rejected",
          conversationRef: conversation.conversationRef,
          message: "oversized",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).rejects.toMatchObject({
      name: "ConversationInputError",
      message: "atomic message limit",
    });
    expect(deps.beginOperation).not.toHaveBeenCalled();
    expect(deps.registerPendingConversationTurn).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("disables inline correlation when delivery changes the reserved id", async () => {
    const deps = createDeps();
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      persistIntent(input);
      return sentResult("reef-different-id");
    }) as never;

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-wrong-id",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({
      status: "sent",
      messageId: "reef-different-id",
      error: expect.stringContaining("did not preserve its prepared message id"),
    });
  });

  it("returns suppression without promoting it to sent", async () => {
    const deps = createDeps();
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      const onDeliveryIntent = input.onDeliveryIntent as (intent: {
        id: string;
        channel: string;
        to: string;
        durability: "required";
      }) => void;
      onDeliveryIntent({
        id: "queue-suppressed",
        channel: "reef",
        to: "molty",
        durability: "required",
      });
      return {
        ...sentResult(),
        sendResult: { ...sentResult().sendResult, deliveryStatus: "suppressed" as const },
      };
    }) as never;

    await expect(
      runGatewayConversationTurn(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          turnId: "turn-suppressed",
          conversationRef: conversation.conversationRef,
          message: "hello",
          timeoutMs: 1_000,
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "suppressed", correlationPersisted: false });
  });
});
