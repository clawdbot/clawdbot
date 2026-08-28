import { describe, expect, it, vi } from "vitest";
import {
  beginConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
  markConversationDeliverySuppressed,
  markConversationDeliveryUnknown,
  type ConversationDeliveryRecord,
} from "../config/sessions/conversation-delivery-store.js";
import { registerConversationAddresses } from "../config/sessions/conversation-registry.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import {
  conversation,
  createConversationDeliveryTestStore,
} from "./conversation-delivery.test-support.js";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "./conversation-errors.js";
import { runGatewayConversationSend } from "./conversation-send.js";

function sentResult(): Extract<MessageActionResult, { kind: "send" }> {
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

function createDeps(agentId = "main") {
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
    ...createConversationDeliveryTestStore(agentId),
    resolveConversation: vi.fn((): typeof conversation | undefined => conversation),
    runMessageAction: runMessageActionMock as never,
    runMessageActionMock,
  };
}

describe("runGatewayConversationSend", () => {
  it.each([
    {
      status: "sent",
      preparedMessageId: "prepared",
      platformMessageId: "platform",
      messageId: "platform",
    },
    { status: "sent", preparedMessageId: "prepared", messageId: "prepared" },
    { status: "sent" },
    {
      status: "replied",
      preparedMessageId: "prepared",
      platformMessageId: "platform",
      messageId: "platform",
    },
    { status: "queued", preparedMessageId: "prepared", messageId: "prepared" },
    { status: "queued" },
    { status: "suppressed", preparedMessageId: "prepared" },
    { status: "unknown", preparedMessageId: "prepared" },
    { status: "rejected" },
  ] satisfies Array<{
    status: ConversationDeliveryRecord["status"];
    preparedMessageId?: string;
    platformMessageId?: string;
    messageId?: string;
  }>)(
    "replays $status with persisted metadata and no current store access ($messageId)",
    async ({ status, preparedMessageId, platformMessageId, messageId }) => {
      const deps = createDeps();
      const operationId = "send-completed";
      beginConversationDeliveryOperation(deps.scope, {
        operationId,
        operationKind: "send",
        conversationRef: conversation.conversationRef,
        message: "hello",
        preparedMessageId,
      });
      markConversationDeliveryQueued(deps.scope, operationId, "queue-existing");
      switch (status) {
        case "queued":
          break;
        case "sent":
        case "replied":
          markConversationDeliverySent(deps.scope, operationId, platformMessageId);
          if (status === "replied") {
            markConversationDeliveryReplied(deps.scope, {
              operationId,
              reply: { messageId: "reply-existing", text: "ack", timestamp: 300 },
            });
          }
          break;
        case "suppressed":
          markConversationDeliverySuppressed(deps.scope, operationId);
          break;
        case "unknown":
          markConversationDeliveryUnknown(deps.scope, operationId);
          break;
        case "rejected":
          markConversationDeliveryRejected(deps.scope, operationId, "permanent rejection");
          break;
      }
      deps.resolveConversation.mockReturnValue({
        ...conversation,
        channel: "reef-current",
        conversationRef: "conv_ffffffffffffffffffffffffffffffff",
      });
      const result = runGatewayConversationSend(
        {
          config: deps.config,
          readCurrentConfig: () => ({
            session: {
              get store(): string {
                throw new Error("current store must not be opened");
              },
            },
          }),
          agentId: "main",
          senderIsOwner: true,
          operationId,
          conversationRef: conversation.conversationRef,
          message: "hello",
        },
        deps,
      );
      if (status === "rejected") {
        await expect(result).rejects.toMatchObject({
          name: "ConversationInputError",
          message: "permanent rejection",
        });
      } else {
        await expect(result).resolves.toEqual({
          status: status === "replied" ? "sent" : status,
          conversationRef: conversation.conversationRef,
          channel: conversation.channel,
          queueId: "queue-existing",
          ...(messageId ? { messageId } : {}),
        });
      }
      expect(deps.resolveConversation).toHaveBeenCalled();
      expect(deps.runMessageAction).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "projects current conversation metadata for an unfinished send (existing=%s)",
    async (existing) => {
      const deps = createDeps();
      if (existing) {
        beginConversationDeliveryOperation(deps.scope, {
          operationId: "send-unfinished",
          operationKind: "send",
          conversationRef: conversation.conversationRef,
          message: "hello",
        });
      }
      const current = {
        ...conversation,
        channel: "reef-current",
        conversationRef: "conv_ffffffffffffffffffffffffffffffff",
      };
      registerConversationAddresses(deps.scope, [{ ...current, deliveryTarget: current.target }]);
      deps.resolveConversation.mockReturnValue(current);
      await expect(
        runGatewayConversationSend(
          {
            config: deps.config,
            agentId: "main",
            senderIsOwner: true,
            operationId: "send-unfinished",
            conversationRef: conversation.conversationRef,
            message: "hello",
          },
          deps,
        ),
      ).resolves.toMatchObject({
        status: "sent",
        channel: current.channel,
        conversationRef: current.conversationRef,
      });
      expect(deps.runMessageAction).toHaveBeenCalledOnce();
    },
  );

  it("owns durable delivery in the Gateway and binds the source session", async () => {
    const deps = createDeps();
    const result = await runGatewayConversationSend(
      {
        config: deps.config,
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
        defaultAccountId: conversation.accountId,
        gatewayOwnedDelivery: true,
        forceCoreDelivery: true,
        requireQueuePersistence: true,
        suppressTranscriptMirror: true,
        sessionKey: "agent:main:telegram:direct:operator",
      }),
    );
    expect(deps.runMessageActionMock.mock.calls[0]?.[0]?.params).not.toHaveProperty("accountId");
    expect(result).toEqual({
      status: "sent",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
  });

  it("does not reveal completed send state after the route owner changes", async () => {
    const deps = createDeps();
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "send-reassigned",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      message: "hello",
    });
    markConversationDeliverySent(deps.scope, "send-reassigned", "reef-private-message");

    await expect(
      runGatewayConversationSend(
        {
          config: {
            ...deps.config,
            agents: { entries: { main: {}, finance: {} } },
            bindings: [
              {
                type: "route",
                agentId: "finance",
                match: { channel: "reef", accountId: "default" },
              },
            ],
          },
          agentId: "main",
          senderIsOwner: true,
          operationId: "send-reassigned",
          conversationRef: conversation.conversationRef,
          message: "hello",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
  });

  it("rejects a stored conversation route owned by another agent", async () => {
    const deps = createDeps();

    await expect(
      runGatewayConversationSend(
        {
          config: {
            ...deps.config,
            agents: { entries: { main: {}, finance: {} } },
            bindings: [
              {
                type: "route",
                agentId: "finance",
                match: { channel: "reef", accountId: "default" },
              },
            ],
          },
          agentId: "main",
          senderIsOwner: true,
          operationId: "send-sibling-route",
          conversationRef: conversation.conversationRef,
          message: "hello",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ConversationInputError);
    expect(deps.beginOperation).not.toHaveBeenCalled();
    expect(deps.runMessageAction).not.toHaveBeenCalled();
  });

  it("revalidates a route-owner change at the durable delivery attempt", async () => {
    const deps = createDeps();
    deps.runMessageAction = vi.fn(async (input: Record<string, unknown>) => {
      const onDeliveryIntent = input.onDeliveryIntent as (intent: {
        id: string;
        channel: string;
        to: string;
        durability: "required";
      }) => void;
      onDeliveryIntent({
        id: "queue-revoked-route",
        channel: "reef",
        to: "molty",
        durability: "required",
      });
      await (input.onDeliveryAttempt as () => Promise<void>)();
      return sentResult();
    }) as never;
    const readCurrentConfig = vi
      .fn()
      .mockReturnValueOnce(deps.config)
      .mockReturnValue({
        ...deps.config,
        agents: { entries: { main: {}, finance: {} } },
        bindings: [
          {
            type: "route",
            agentId: "finance",
            match: { channel: "reef", accountId: "default" },
          },
        ],
      });

    await expect(
      runGatewayConversationSend(
        {
          config: deps.config,
          readCurrentConfig,
          agentId: "main",
          senderIsOwner: true,
          operationId: "send-revoked-route",
          conversationRef: conversation.conversationRef,
          message: "hello",
        },
        deps,
      ),
    ).resolves.toMatchObject({ status: "queued", queueId: "queue-revoked-route" });

    expect(readCurrentConfig).toHaveBeenCalledTimes(2);
    expect(deps.markSent).not.toHaveBeenCalled();
  });

  it("namespaces stable queue intents across agents", async () => {
    const mainDeps = createDeps();
    const workerDeps = createDeps("worker");

    await runGatewayConversationSend(
      {
        config: mainDeps.config,
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
        config: {
          ...workerDeps.config,
          agents: { entries: { worker: { default: true } } },
        },
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
          config: deps.config,
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
    beginConversationDeliveryOperation(deps.scope, {
      operationId: "send-reused",
      operationKind: "send",
      conversationRef: conversation.conversationRef,
      message: "original",
    });
    markConversationDeliverySent(deps.scope, "send-reused");
    deps.resolveConversation.mockReturnValue(undefined);

    await expect(
      runGatewayConversationSend(
        {
          config: deps.config,
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
