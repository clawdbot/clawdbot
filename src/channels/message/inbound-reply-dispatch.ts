/**
 * Shared inbound reply dispatch helpers for channel message adapters.
 */

import { withReplyDispatcher } from "../../auto-reply/dispatch.js";
import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import {
  dispatchReplyFromConfig,
  type DispatchFromConfigResult,
} from "../../auto-reply/reply/dispatch-from-config.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../../infra/outbound/reply-payload-normalize.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  deliverInboundReplyWithMessageSendContext,
  dispatchChannelInboundTurn as dispatchChannelInboundTurnCore,
  dispatchChannelInboundReply as dispatchChannelInboundReplyCore,
  isDurableInboundReplyDeliveryHandled,
  resolveChannelTurnDispatchCounts,
  recordDroppedChannelInboundHistory,
  runChannelInboundEvent as runChannelInboundEventCore,
  runPreparedInboundReply as runPreparedInboundReplyCore,
  throwIfDurableInboundReplyDeliveryFailed,
} from "../turn/kernel.js";
import type { ChannelTurnResult, DurableInboundReplyDeliveryOptions } from "../turn/kernel.js";
import type {
  AssembledChannelTurn,
  ChannelTurnPlan,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "../turn/types.js";

export type {
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnDroppedHistoryOptions as ChannelInboundDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  ChannelTurnRecordOptions as InboundReplyRecordOptions,
} from "../turn/types.js";
export type { DurableInboundReplyDeliveryParams } from "../turn/kernel.js";
export type { ChannelBotLoopProtectionFacts } from "../turn/kernel.js";
export { recordChannelBotPairLoopAndCheckSuppression } from "../turn/kernel.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../session.js").recordInboundSession;

type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onBlockReply">;
export type ChannelInboundEventRunnerParams<
  TRaw,
  TDispatchResult = DispatchFromConfigResult,
> = RunChannelTurnParams<TRaw, TDispatchResult>;
export type PreparedInboundReply<TDispatchResult> = PreparedChannelTurn<TDispatchResult>;
export type AssembledInboundReply = AssembledChannelTurn;
export type ChannelInboundTurnPlan = ChannelTurnPlan;
export type InboundReplyDispatchResult<TDispatchResult> = ChannelTurnResult<TDispatchResult>;

/** Run an already prepared inbound reply through shared session-record + dispatch ordering. */
export async function runPreparedInboundReply<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedInboundReplyCore(params);
}

/** @deprecated Use `runPreparedInboundReply`. */
export async function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedInboundReply(params);
}

export async function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: ChannelInboundEventRunnerParams<TRaw, TDispatchResult>,
) {
  return await runChannelInboundEventCore(params);
}

/** @deprecated Use `runChannelInboundEvent`. */
export async function runInboundReplyTurn<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: ChannelInboundEventRunnerParams<TRaw, TDispatchResult>,
) {
  return await runChannelInboundEvent(params);
}

export async function dispatchChannelInboundReply(params: AssembledInboundReply) {
  return await dispatchChannelInboundReplyCore(params);
}

export async function dispatchChannelInboundTurn(params: ChannelInboundTurnPlan) {
  return await dispatchChannelInboundTurnCore(params);
}

export {
  hasFinalChannelTurnDispatch as hasFinalInboundReplyDispatch,
  hasVisibleChannelTurnDispatch as hasVisibleInboundReplyDispatch,
  deliverInboundReplyWithMessageSendContext,
  recordDroppedChannelInboundHistory as recordDroppedChannelTurnHistory,
  recordDroppedChannelInboundHistory,
  resolveChannelTurnDispatchCounts as resolveInboundReplyDispatchCounts,
};

/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
export async function dispatchReplyFromConfigWithSettledDispatcher(params: {
  cfg: OpenClawConfig;
  ctxPayload: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  onSettled: () => void | Promise<void>;
  replyOptions?: ReplyDispatchFromConfigOptions;
  configOverride?: OpenClawConfig;
}): Promise<DispatchFromConfigResult> {
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    onSettled: params.onSettled,
    run: () =>
      dispatchReplyFromConfig({
        ctx: params.ctxPayload,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        configOverride: params.configOverride,
      }),
  });
}

/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
export function buildInboundReplyDispatchBase(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  route: {
    agentId: string;
    sessionKey: string;
  };
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  core: {
    channel: {
      session: {
        recordInboundSession: RecordInboundSessionFn;
      };
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

/**
 * Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
 *
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
 * sends through `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
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

/**
 * Record the inbound session first, then dispatch the reply using normalized outbound delivery.
 *
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
 * sends through `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export async function recordInboundSessionAndDispatchReply(
  params: RecordInboundSessionAndDispatchReplyParams,
): Promise<void> {
  await dispatchChannelInboundReplyCore({
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
          const durable = await deliverInboundReplyWithMessageSendContext({
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
    record: {
      onRecordError: params.onRecordError,
    },
  });
}
