import { describe, expect, it, vi } from "vitest";
import {
  ConversationDeliveryInputError,
  type ConversationDeliveryRecord,
} from "../config/sessions/conversation-delivery-store.js";
import type { MessageActionRunResult } from "../infra/outbound/message-action-runner.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";
import { runGatewayConversationSend } from "./conversation-send.js";

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

function sentResult(): Extract<MessageActionRunResult, { kind: "send" }> {
  return {
    kind: "send",
    channel: "reef",
    action: "send",
    to: conversation.target,
    handledBy: "core",
    payload: {},
    sendResult: {
      channel: "reef",
      to: conversation.target,
      via: "direct",
      mediaUrl: null,
      result: { messageId: "reef-outbound-1" },
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
  const runMessageActionMock = vi.fn(async (input: Record<string, unknown>) => {
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
    return sentResult();
  });
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
    resolveConversation: vi.fn((): typeof conversation | undefined => conversation),
    runMessageAction: runMessageActionMock as never,
    runMessageActionMock,
    operations,
  };
}

describe("runGatewayConversationSend", () => {
  it("owns durable delivery in the Gateway and binds the source session", async () => {
    const deps = createDeps();
    const result = await runGatewayConversationSend(
      {
        config: {},
        agentId: "main",
        senderIsOwner: true,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        operationId: "send-1",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
      },
      deps,
    );

    expect(deps.beginOperation).toHaveBeenCalledWith(expect.any(Object), {
      operationId: "send-1",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      sourceSessionKey: "agent:main:telegram:direct:operator",
      message: "hello molty",
    });
    expect(deps.runMessageAction).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        suppressTranscriptMirror: true,
        sessionKey: "agent:main:telegram:direct:operator",
      }),
    );
    expect(result).toEqual({
      status: "sent",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
  });

  it("returns durable completed state without recipient-visible I/O", async () => {
    const deps = createDeps();
    deps.operations.set("send-replayed", {
      operationId: "send-replayed",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageHash: "hello",
      status: "sent",
      platformMessageId: "reef-existing",
      queueId: "queue-existing",
      createdAt: 100,
      updatedAt: 200,
    });
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationSend(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          operationId: "send-replayed",
          conversationRef: conversation.conversationRef,
          message: "hello",
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "sent", messageId: "reef-existing" });
    expect(deps.resolveConversation).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("namespaces stable queue intents across agents", async () => {
    const mainDeps = createDeps();
    const workerDeps = createDeps();

    await runGatewayConversationSend(
      {
        config: {},
        agentId: "main",
        senderIsOwner: true,
        operationId: "shared-operation",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
      },
      mainDeps,
    );
    await runGatewayConversationSend(
      {
        config: {},
        agentId: "worker",
        senderIsOwner: true,
        operationId: "shared-operation",
        conversationRef: conversation.conversationRef,
        message: "hello molty",
      },
      workerDeps,
    );

    const mainIntent = mainDeps.runMessageActionMock.mock.calls[0]?.[0]?.deliveryIntentId;
    const workerIntent = workerDeps.runMessageActionMock.mock.calls[0]?.[0]?.deliveryIntentId;
    expect(mainIntent).toMatch(/^convq_[a-f0-9]{32}$/u);
    expect(workerIntent).toMatch(/^convq_[a-f0-9]{32}$/u);
    expect(mainIntent).not.toBe(workerIntent);
  });

  it("maps unknown conversations to terminal input errors", async () => {
    const deps = createDeps();
    deps.resolveConversation.mockReturnValueOnce(undefined);

    await expect(
      runGatewayConversationSend(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          operationId: "send-missing",
          conversationRef: conversation.conversationRef,
          message: "hello",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.beginOperation).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("preserves durable operation conflicts for Gateway identity recovery", async () => {
    const deps = createDeps();
    deps.operations.set("send-reused", {
      operationId: "send-reused",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      channel: conversation.channel,
      messageHash: "original",
      status: "sent",
      createdAt: 100,
      updatedAt: 200,
    });
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationSend(
        {
          config: {},
          agentId: "main",
          senderIsOwner: true,
          operationId: "send-reused",
          conversationRef: conversation.conversationRef,
          message: "different",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationOperationConflictError);
    expect(deps.resolveConversation).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });
});
