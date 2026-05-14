import { withReplyDispatcher } from "../auto-reply/dispatch.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import {
  dispatchReplyFromConfig,
  type DispatchFromConfigResult,
} from "../auto-reply/reply/dispatch-from-config.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  resolveChannelTurnDispatchCounts,
  runChannelTurn,
  runPreparedChannelTurn,
  throwIfDurableInboundReplyDeliveryFailed,
} from "../channels/turn/kernel.js";
import type {
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  DurableInboundReplyDeliveryOptions,
} from "../channels/turn/kernel.js";
import type { PreparedChannelTurn, RunChannelTurnParams } from "../channels/turn/types.js";
export type { ChannelTurnRecordOptions } from "../channels/turn/types.js";
export type { DurableInboundReplyDeliveryParams } from "../channels/turn/kernel.js";
export type { ChannelBotLoopProtectionFacts } from "../channels/turn/kernel.js";
export { recordChannelBotPairLoopAndCheckSuppression } from "../channels/turn/kernel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChannelReplyPipeline } from "./channel-reply-core.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
  type ReplyPayload,
} from "./reply-payload.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;

type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onBlockReply">;

/** Run an already assembled channel turn through shared session-record + dispatch ordering. */
type PreparedInboundReplyTurnWithBotLoopProtection<TDispatchResult> =
  PreparedChannelTurn<TDispatchResult> & {
    botLoopProtection: NonNullable<PreparedChannelTurn<TDispatchResult>["botLoopProtection"]>;
  };

type PreparedInboundReplyTurnWithoutBotLoopProtection<TDispatchResult> = Omit<
  PreparedChannelTurn<TDispatchResult>,
  "botLoopProtection"
> & {
  botLoopProtection?: undefined;
};

export function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedInboundReplyTurnWithBotLoopProtection<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedInboundReplyTurnWithoutBotLoopProtection<TDispatchResult>,
): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
export function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedChannelTurn(params);
}

/** Run a channel turn through shared ingest, record, dispatch, and finalize ordering. */
export async function runInboundReplyTurn<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: RunChannelTurnParams<TRaw, TDispatchResult>,
) {
  return await runChannelTurn(params);
}

export {
  hasFinalChannelTurnDispatch as hasFinalInboundReplyDispatch,
  hasVisibleChannelTurnDispatch as hasVisibleInboundReplyDispatch,
  deliverInboundReplyWithMessageSendContext as deliverDurableInboundReplyPayload,
  deliverInboundReplyWithMessageSendContext,
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
type RecordChannelMessageReplyDispatchParams = {
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
export async function dispatchChannelMessageReplyWithBase(
  params: BuildInboundReplyDispatchBaseParams &
    Pick<
      RecordChannelMessageReplyDispatchParams,
      "deliver" | "durable" | "onRecordError" | "onDispatchError" | "replyOptions"
    >,
): Promise<void> {
  const dispatchBase = buildInboundReplyDispatchBase(params);
  await recordChannelMessageReplyDispatch({
    ...dispatchBase,
    deliver: params.deliver,
    durable: params.durable,
    onRecordError: params.onRecordError,
    onDispatchError: params.onDispatchError,
    replyOptions: params.replyOptions,
  });
}

/**
 * Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
 *
 * @deprecated Legacy inbound reply helper. New channel plugins should expose a
 * `message` adapter via `defineChannelMessageAdapter(...)` and use
 * `dispatchChannelMessageReplyWithBase` only for compatibility dispatchers that
 * have not moved to the message lifecycle yet.
 */
export async function dispatchInboundReplyWithBase(
  params: Parameters<typeof dispatchChannelMessageReplyWithBase>[0],
): Promise<void> {
  await dispatchChannelMessageReplyWithBase(params);
}

/**
 * Record the inbound session first, then dispatch the reply using normalized outbound delivery.
 *
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
 * sends through `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export async function recordChannelMessageReplyDispatch(
  params: RecordChannelMessageReplyDispatchParams,
): Promise<void> {
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
  });
  const deliver = async (payload: unknown, info: { kind: "tool" | "block" | "final" }) => {
    const normalized =
      payload && typeof payload === "object"
        ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
        : {};
    if (params.durable) {
      const durable = await deliverInboundReplyWithMessageSendContext({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        agentId: params.agentId,
        ctxPayload: params.ctxPayload,
        payload: normalized as ReplyPayload,
        info,
        ...params.durable,
      });
      throwIfDurableInboundReplyDeliveryFailed(durable);
      if (isDurableInboundReplyDeliveryHandled(durable)) {
        return;
      }
    }
    await params.deliver(normalized);
  };

  await runPreparedChannelTurn({
    channel: params.channel,
    accountId: params.accountId,
    routeSessionKey: params.routeSessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.recordInboundSession,
    record: {
      onRecordError: params.onRecordError,
    },
    runDispatch: async () =>
      await params.dispatchReplyWithBufferedBlockDispatcher({
        ctx: params.ctxPayload,
        cfg: params.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver,
          onError: params.onDispatchError,
        },
        replyOptions: {
          ...params.replyOptions,
          onModelSelected,
        },
      }),
  });
}

/**
 * Record the inbound session first, then dispatch the reply using normalized outbound delivery.
 *
 * @deprecated Legacy inbound reply helper. New channel plugins should expose a
 * `message` adapter via `defineChannelMessageAdapter(...)` and use
 * `recordChannelMessageReplyDispatch` only for compatibility dispatchers that
 * have not moved to the message lifecycle yet.
 */
export async function recordInboundSessionAndDispatchReply(
  params: RecordChannelMessageReplyDispatchParams,
): Promise<void> {
  await recordChannelMessageReplyDispatch(params);
}

/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
export const buildChannelMessageReplyDispatchBase = buildInboundReplyDispatchBase;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const hasFinalChannelMessageReplyDispatch = hasFinalChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const hasVisibleChannelMessageReplyDispatch = hasVisibleChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const resolveChannelMessageReplyDispatchCounts = resolveChannelTurnDispatchCounts;
