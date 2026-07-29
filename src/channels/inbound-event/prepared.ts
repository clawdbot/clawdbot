import type { ReplyThreadingPolicy } from "../../auto-reply/types.js";
import type { NormalizedLocation } from "../location.js";
import { toLocationContext } from "../location.js";
import type { CommandFacts, NormalizedTurnInput, SupplementalContextFacts } from "../turn/types.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
} from "./context.js";

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
}): {
  input: NormalizedTurnInput;
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
    context: buildChannelInboundEventContext({
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
