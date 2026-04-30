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
  resolveChannelTurnDispatchCounts,
  runChannelTurn,
  runPreparedChannelTurn,
} from "../channels/turn/kernel.js";
import type { PreparedChannelTurn, RunChannelTurnParams } from "../channels/turn/types.js";
export type { ChannelTurnRecordOptions } from "../channels/turn/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
import { createNormalizedOutboundDeliverer, type OutboundReplyPayload } from "./reply-payload.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;

type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onBlockReply">;

/** Run an already assembled channel turn through shared session-record + dispatch ordering. */
export async function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
) {
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
type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof recordInboundSessionAndDispatchReply
>[0];

/** Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn. */
export async function dispatchInboundReplyWithBase(
  params: BuildInboundReplyDispatchBaseParams &
    Pick<
      RecordInboundSessionAndDispatchReplyParams,
      "deliver" | "onRecordError" | "onDispatchError" | "replyOptions"
    >,
): Promise<void> {
  const dispatchBase = buildInboundReplyDispatchBase(params);
  await recordInboundSessionAndDispatchReply({
    ...dispatchBase,
    deliver: params.deliver,
    onRecordError: params.onRecordError,
    onDispatchError: params.onDispatchError,
    replyOptions: params.replyOptions,
  });
}

/** Record the inbound session first, then dispatch the reply using normalized outbound delivery. */
export async function recordInboundSessionAndDispatchReply(params: {
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
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
  replyOptions?: ReplyOptionsWithoutModelSelected;
}): Promise<void> {
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
  });
  const deliver = createNormalizedOutboundDeliverer(params.deliver);

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
