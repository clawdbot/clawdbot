import {
  toLocationContext,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type CommandFacts,
  type NormalizedLocation,
  type SupplementalContextFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelMessageSourceReplyDeliveryMode } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyThreadingPolicy } from "openclaw/plugin-sdk/reply-reference";

type PreparedChannelInboundCommandAuthorization =
  | { kind: "not_checked" }
  | { kind: "authorized" }
  | { kind: "denied"; reason?: string };

type PreparedChannelInboundCommand = Omit<CommandFacts, "authorized"> & {
  authorization: PreparedChannelInboundCommandAuthorization;
};

type PreparedChannelInboundContextFacts = {
  transcript?: string;
  /** Null suppresses the generic fallback from conversation label to group subject. */
  groupSubject?: string | null;
  groupMembers?: string;
  senderE164?: string;
  replyThreading?: ReplyThreadingPolicy;
  location?: NormalizedLocation;
};

export type PreparedChannelInbound = Pick<
  BuildChannelInboundEventContextParams,
  | "channel"
  | "accountId"
  | "provider"
  | "surface"
  | "from"
  | "sender"
  | "conversation"
  | "route"
  | "reply"
  | "message"
  | "sessionTranscript"
  | "media"
  | "contextVisibility"
  | "channelIngress"
> & {
  event: {
    id: string;
    fullId?: string;
    timestamp?: number;
  };
  command?: PreparedChannelInboundCommand;
  mentions?: NonNullable<BuildChannelInboundEventContextParams["access"]>["mentions"];
  supplemental?: SupplementalContextFacts;
  context?: PreparedChannelInboundContextFacts;
};

type PreparedChannelInboundControl = {
  messageReceivedHooks: "channel" | "core";
};

function resolvePreparedCommandFacts(
  command: PreparedChannelInboundCommand | undefined,
): CommandFacts | undefined {
  if (!command) {
    return undefined;
  }
  const { authorization, ...facts } = command;
  return {
    ...facts,
    ...(authorization.kind === "not_checked"
      ? {}
      : { authorized: authorization.kind === "authorized" }),
  };
}

export function projectPreparedChannelInbound(params: {
  inbound: PreparedChannelInbound;
  control: PreparedChannelInboundControl;
  buildContext: (params: BuildChannelInboundEventContextParams) => BuiltChannelInboundEventContext;
}): {
  input: {
    id: string;
    timestamp?: number;
    rawText: string;
    textForAgent?: string;
    textForCommands?: string;
    raw: PreparedChannelInbound;
  };
  context: BuiltChannelInboundEventContext;
} {
  const { inbound, control } = params;
  const command = resolvePreparedCommandFacts(inbound.command);
  const commandAuthorization = inbound.command?.authorization;
  const commandAccess =
    commandAuthorization && commandAuthorization.kind !== "not_checked"
      ? { authorized: commandAuthorization.kind === "authorized" }
      : undefined;
  return {
    input: {
      id: inbound.event.id,
      timestamp: inbound.event.timestamp,
      rawText: inbound.message.rawBody,
      textForAgent: inbound.message.bodyForAgent,
      textForCommands: inbound.message.commandBody,
      raw: inbound,
    },
    context: params.buildContext({
      ...inbound,
      messageId: inbound.event.id,
      messageIdFull: inbound.event.fullId,
      timestamp: inbound.event.timestamp,
      command,
      access:
        inbound.mentions || commandAccess
          ? {
              mentions: inbound.mentions,
              commands: commandAccess,
            }
          : undefined,
      extra: {
        Transcript: inbound.context?.transcript,
        ...(inbound.context && "groupSubject" in inbound.context
          ? { GroupSubject: inbound.context.groupSubject ?? undefined }
          : {}),
        GroupMembers: inbound.context?.groupMembers,
        SenderE164: inbound.context?.senderE164,
        ReplyThreading: inbound.context?.replyThreading,
        SuppressMessageReceivedHooks: control.messageReceivedHooks === "channel",
        ...(inbound.context?.location ? toLocationContext(inbound.context.location) : {}),
      },
    }),
  };
}

type ChannelInboundReplyPolicy = {
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  disableBlockStreaming?: boolean;
  suppressTyping: boolean;
};

/** Keeps WhatsApp reply-policy mapping beside the transport that applies it. */
export function resolveWhatsAppInboundReplyPolicy(params: {
  cfg: Parameters<typeof resolveChannelMessageSourceReplyDeliveryMode>[0]["cfg"];
  ctx: Parameters<typeof resolveChannelMessageSourceReplyDeliveryMode>[0]["ctx"] & {
    ChatType?: string;
    WasMentioned?: boolean;
  };
  blockStreamingEnabled?: boolean;
}): ChannelInboundReplyPolicy {
  const isRoom = params.ctx.ChatType === "group" || params.ctx.ChatType === "channel";
  const sourceReplyDeliveryMode = isRoom
    ? resolveChannelMessageSourceReplyDeliveryMode({
        cfg: params.cfg,
        ctx: params.ctx,
      })
    : undefined;
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  return {
    sourceReplyDeliveryMode,
    disableBlockStreaming: sourceRepliesAreToolOnly
      ? true
      : typeof params.blockStreamingEnabled === "boolean"
        ? !params.blockStreamingEnabled
        : undefined,
    suppressTyping:
      sourceRepliesAreToolOnly &&
      params.ctx.ChatType === "group" &&
      params.ctx.WasMentioned !== true,
  };
}
