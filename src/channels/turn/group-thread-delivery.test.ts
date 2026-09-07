import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import type { DurableMessageBatchSendParams } from "../message/send.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createDurableSendResult,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";

const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const sendDurableMessageBatch = vi.hoisted(() => vi.fn());
const resolveOutboundDurableFinalDeliverySupport = vi.hoisted(() => vi.fn());
const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const createMessageSentEmitter = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/outbound/message-sent-hook.js").createMessageSentEmitter>(),
);

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../infra/outbound/message-sent-hook.js", () => ({ createMessageSentEmitter }));

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return { ...actual, resolveOutboundDurableFinalDeliverySupport };
});

vi.mock("../message/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../message/send.js")>();
  return { ...actual, sendDurableMessageBatchCore: sendDurableMessageBatch };
});

vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: vi.fn(async () => undefined) };
});

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>();
  return {
    ...actual,
    settlePendingFinalDelivery: vi.fn(async (_completion: unknown, state: string) => ({ state })),
  };
});

describe("group thread channel delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outboundMessageIdentities.clear();
    resetDiagnosticEventsForTest();
    resolveOutboundDurableFinalDeliverySupport.mockResolvedValue({ ok: true });
  });

  it.each(["deferred direct", "durable"])(
    "attributes group %s delivery to each participant",
    async (lane) => {
      const actualDispatch = await vi.importActual<typeof import("../../auto-reply/dispatch.js")>(
        "../../auto-reply/dispatch.js",
      );
      const actualSent = await vi.importActual<
        typeof import("../../infra/outbound/message-sent-hook.js")
      >("../../infra/outbound/message-sent-hook.js");
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(
        actualDispatch.dispatchInboundMessageWithRoutedChannelDispatcher,
      );
      createMessageSentEmitter.mockImplementation(actualSent.createMessageSentEmitter);
      const runMessageSending = vi.fn(async () => undefined);
      const runMessageSent = vi.fn(async () => undefined);
      getGlobalHookRunner.mockReturnValue({
        hasHooks: (name: string) => name === "message_sending" || name === "message_sent",
        runMessageSending,
        runMessageSent,
      });
      const token = createExecutionIdentityAdmissionToken("run-alice");
      const durableRequests: DurableMessageBatchSendParams[] = [];
      const durableSend = async (request: DurableMessageBatchSendParams) => {
        durableRequests.push(request);
        return createDurableSendResult([`sent-${request.payloads[0]?.text}`]);
      };
      if (lane === "durable") {
        sendDurableMessageBatch
          .mockImplementationOnce(durableSend)
          .mockImplementationOnce(durableSend);
      }
      const result = await dispatchRoutedChannelTurn({
        cfg: {
          agents: { entries: { alice: {}, bob: {} } },
          broadcast: { "telegram:chat-1": ["alice", "bob"] },
        },
        channel: "telegram",
        accountId: "acct",
        route: { agentId: "main", sessionKey: "agent:main:telegram:group:chat-1" },
        ctxPayload: createCtx({
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          From: "chat-1",
          OriginatingTo: "chat-1",
          NativeChannelId: "chat-1",
          AccountId: "acct",
          ReplyToId: "source-1",
          MessageSid: "source-1",
          MessageThreadId: 42,
        }),
        dispatchReplyFromConfig: async ({ ctx, dispatcher, replyOptions }) => {
          replyOptions?.onAgentRunStart?.(
            `run-${ctx.AgentId}`,
            ctx.AgentId === "alice" ? token : undefined,
          );
          return {
            queuedFinal: dispatcher.sendFinalReply({ text: `${ctx.AgentId} answer` }),
            counts: dispatcher.getQueuedCounts(),
          };
        },
        delivery: {
          observeMessageSent: true,
          ...(lane === "durable" ? { durable: { to: "chat-1" } } : {}),
          deliver: async (payload) => ({
            visibleReplySent: false,
            finalization: Promise.resolve({
              visibleReplySent: true,
              content: payload.text,
              messageIds: [`sent-${payload.text}`],
            }),
          }),
        },
      });

      expectDispatched(result);
      if (lane === "durable") {
        expect(durableRequests).toHaveLength(2);
        for (const agentId of ["alice", "bob"]) {
          const request = durableRequests.find((entry) => entry.session?.agentId === agentId);
          expect(request).toMatchObject({
            channel: "telegram",
            accountId: "acct",
            to: "chat-1",
            replyToId: "source-1",
            threadId: 42,
            runId: `run-${agentId}`,
            session: {
              agentId,
              key: `agent:${agentId}:telegram:group:chat-1:thread:telegram-account-acct:thread:42`,
            },
          });
          expect(request?.executionIdentityToken).toBe(agentId === "alice" ? token : undefined);
        }
        expect(runMessageSent).not.toHaveBeenCalled();
        return;
      }
      expect(runMessageSending).toHaveBeenCalledTimes(2);
      expect(runMessageSent).toHaveBeenCalledTimes(2);
      for (const agentId of ["alice", "bob"]) {
        const context = expect.objectContaining({
          channelId: "telegram",
          accountId: "acct",
          conversationId: "chat-1",
          sessionKey: `agent:${agentId}:telegram:group:chat-1:thread:telegram-account-acct:thread:42`,
          runId: `run-${agentId}`,
        });
        expect(runMessageSending).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "chat-1",
            content: `${agentId} answer`,
            replyToId: "source-1",
            threadId: 42,
          }),
          context,
        );
        expect(runMessageSent).toHaveBeenCalledWith(
          expect.objectContaining({ to: "chat-1", content: `${agentId} answer`, success: true }),
          context,
        );
      }
    },
  );
});
