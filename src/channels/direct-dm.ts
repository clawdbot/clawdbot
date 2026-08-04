import type { TurnAdoptionLifecycle } from "../auto-reply/get-reply-options.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../plugin-sdk/reply-payload.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { buildChannelInboundEventContext } from "./inbound-event/context.js";
import {
  resolveChannelInboundRouteEnvelope,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
} from "./inbound-event/envelope.js";
import { createChannelReplyPipeline } from "./message/reply-pipeline.js";
import { dispatchChannelInboundTurn } from "./turn/kernel.js";
import type { ChannelTurnPlan } from "./turn/types.js";
export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
  type AccessGroupMembershipResolver,
  type DirectDmCommandAuthorizationRuntime,
  type ResolvedInboundDirectDmAccess,
} from "./direct-dm-access.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm-guard-policy.js";

type DirectDmRoutePeer = { kind: "direct"; id: string };
type DirectDmRoute = { agentId: string; sessionKey: string; accountId?: string };

type DispatchInboundDirectDmParams = {
  cfg: OpenClawConfig;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
  /** Set only after the channel's sender/pairing guard admits this event. */
  inboundAccessAuthorized?: boolean;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};

function buildDirectDmContext(
  params: DispatchInboundDirectDmParams,
  route: DirectDmRoute,
  body: string,
): FinalizedMsgContext {
  const accountId = route.accountId ?? params.accountId;
  return buildChannelInboundEventContext({
    channel: params.channel,
    accountId,
    provider: params.provider,
    surface: params.surface,
    messageId: params.messageId,
    messageIdFull: params.messageId,
    timestamp: params.timestamp,
    from: params.senderAddress,
    sender: { id: params.senderId, name: params.conversationLabel },
    conversation: { kind: "direct", id: params.peer.id, label: params.conversationLabel },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: {
      to: params.recipientAddress,
      originatingTo: params.originatingTo ?? params.recipientAddress,
    },
    message: {
      body,
      bodyForAgent: params.bodyForAgent ?? params.rawBody,
      rawBody: params.rawBody,
      commandBody: params.commandBody ?? params.rawBody,
    },
    access: { commands: { authorized: params.commandAuthorized === true } },
    extra: {
      NativeDirectUserId: params.peer.id,
      OriginatingChannel: params.originatingChannel ?? params.channel,
      ...params.extraContext,
    },
  });
}

export async function dispatchInboundDirectDm(params: DispatchInboundDirectDmParams): Promise<{
  route: DirectDmRoute;
  ctxPayload: FinalizedMsgContext;
}> {
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const ctxPayload = buildDirectDmContext(
    params,
    route,
    buildEnvelope({
      channel: params.channelLabel,
      from: params.conversationLabel,
      body: params.rawBody,
      timestamp: params.timestamp,
    }),
  );
  await dispatchChannelInboundTurn(buildDirectDmTurnPlan(params, route, ctxPayload));

  return { route, ctxPayload };
}

function buildDirectDmTurnPlan(
  params: DispatchInboundDirectDmParams,
  route: DirectDmRoute,
  ctxPayload: FinalizedMsgContext,
): ChannelTurnPlan {
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
  });

  return {
    cfg: params.cfg,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
    ctxPayload,
    record: {
      onRecordError: params.onRecordError,
    },
    delivery: {
      deliver: async (payload) => await params.deliver(normalizeOutboundReplyPayload(payload)),
      onError: params.onDispatchError,
    },
    replyPipeline,
    replyOptions: {
      onModelSelected,
      ...(params.turnAdoptionLifecycle
        ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
        : {}),
    },
  };
}

export async function dispatchInboundDirectDmWithRuntime(
  params: DispatchInboundDirectDmParams & { runtime: PluginRuntime },
): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    runtime: params.runtime.channel,
    sessionStore: params.cfg.session?.store,
  });
  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });
  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.commandBody ?? params.rawBody,
    From: params.senderAddress,
    To: params.recipientAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: "direct",
    ConversationLabel: params.conversationLabel,
    SenderId: params.senderId,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.channel,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    Timestamp: params.timestamp,
    CommandAuthorized: params.commandAuthorized,
    ...(params.inboundAccessAuthorized === true ? { InboundAccessAuthorized: true } : {}),
    OriginatingChannel: params.originatingChannel ?? params.channel,
    OriginatingTo: params.originatingTo ?? params.recipientAddress,
    NativeDirectUserId: params.peer.id,
    ...params.extraContext,
  });
  const plan = buildDirectDmTurnPlan(params, route, ctxPayload);
  await params.runtime.channel.inbound.run({
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    raw: ctxPayload,
    adapter: {
      ingest: () => ({
        id: params.messageId,
        timestamp: params.timestamp,
        rawText: params.rawBody,
        textForAgent: params.bodyForAgent,
        textForCommands: params.commandBody,
        raw: ctxPayload,
      }),
      resolveTurn: () => plan,
    },
  });
  return { route, storePath, ctxPayload };
}
