/**
 * @deprecated Compatibility shim for openclaw/skills' openclaw-zulip plugin and
 * tloncorp/tlon-apps. Removal is targeted for the next Plugin SDK major.
 */
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
  type DurableInboundReplyDeliveryOptions,
} from "../channels/turn/durable-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../infra/outbound/reply-payload-normalize.js";
import { dispatchChannelInboundReply } from "./channel-inbound.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;

function buildInboundReplyDispatchBase(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  route: { agentId: string; sessionKey: string };
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  core: {
    channel: {
      session: { recordInboundSession: RecordInboundSessionFn };
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
      };
    };
  };
}) {
  return {
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    agentId: params.route.agentId,
    routeSessionKey: params.route.sessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
  };
}

type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordInboundSessionAndDispatchReplyParams = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSessionFn;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  durable?: false | DurableInboundReplyDeliveryOptions;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
  replyOptions?: ReplyOptionsWithoutModelSelected;
};

async function recordInboundSessionAndDispatchReply(
  params: RecordInboundSessionAndDispatchReplyParams,
): Promise<void> {
  await dispatchChannelInboundReply({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    agentId: params.agentId,
    routeSessionKey: params.routeSessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: params.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      preparePayload: (payload): OutboundReplyPayload =>
        payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {},
      deliver: async (payload, info) => {
        if (params.durable) {
          const durable = await deliverInboundReplyWithMessageSendContextCore({
            cfg: params.cfg,
            channel: params.channel,
            accountId: params.accountId,
            agentId: params.agentId,
            ctxPayload: params.ctxPayload,
            payload,
            info,
            ...params.durable,
          });
          throwIfDurableInboundReplyDeliveryFailed(durable);
          if (isDurableInboundReplyDeliveryHandled(durable)) {
            return durable.delivery;
          }
        }
        return await params.deliver(payload as OutboundReplyPayload);
      },
      onError: params.onDispatchError,
    },
    replyPipeline: {},
    replyOptions: params.replyOptions,
    record: { onRecordError: params.onRecordError },
  });
}

export async function dispatchInboundReplyWithBase(
  params: BuildInboundReplyDispatchBaseParams &
    Pick<
      RecordInboundSessionAndDispatchReplyParams,
      "deliver" | "durable" | "onRecordError" | "onDispatchError" | "replyOptions"
    >,
): Promise<void> {
  const dispatchBase = buildInboundReplyDispatchBase(params);
  await recordInboundSessionAndDispatchReply({
    ...dispatchBase,
    deliver: params.deliver,
    durable: params.durable,
    onRecordError: params.onRecordError,
    onDispatchError: params.onDispatchError,
    replyOptions: params.replyOptions,
  });
}

export {
  dispatchChannelInboundReply,
  hasFinalInboundReplyDispatch,
  hasVisibleInboundReplyDispatch,
  recordChannelBotPairLoopAndCheckSuppression,
  recordDroppedChannelInboundHistory,
  recordDroppedChannelTurnHistory,
  resolveInboundReplyDispatchCounts,
  runChannelInboundEvent,
  runPreparedInboundReply,
} from "./channel-inbound.js";
export { deliverInboundReplyWithMessageSendContext } from "./channel-outbound.js";
export type {
  AssembledInboundReply,
  ChannelBotLoopProtectionFacts,
  ChannelInboundDroppedHistoryOptions,
  ChannelInboundEventRunnerParams,
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  DurableInboundReplyDeliveryParams,
  InboundReplyDispatchResult,
  InboundReplyRecordOptions,
  PreparedInboundReply,
} from "./channel-inbound.js";
