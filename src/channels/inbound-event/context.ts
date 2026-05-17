import {
  commandTurnKindToSource,
  createCommandTurnContext,
  type CommandTurnContext,
} from "../../auto-reply/command-turn-context.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { ContextVisibilityMode } from "../../config/types.base.js";
import { shouldIncludeSupplementalContext } from "../../security/context-visibility.js";
import type {
  AccessFacts,
  CommandFacts,
  ConversationFacts,
  InboundMediaFacts,
  MessageFacts,
  ReplyPlanFacts,
  RouteFacts,
  SenderFacts,
  SupplementalContextFacts,
} from "../turn/types.js";
import type { InboundEventKind } from "./kind.js";
import { buildChannelInboundMediaPayload } from "./media.js";

export type BuildChannelInboundEventContextParams = {
  channel: string;
  accountId?: string;
  provider?: string;
  surface?: string;
  messageId?: string;
  messageIdFull?: string;
  timestamp?: number;
  from: string;
  sender: SenderFacts;
  conversation: ConversationFacts;
  route: RouteFacts;
  reply: ReplyPlanFacts;
  message: MessageFacts;
  access?: AccessFacts;
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};

export type BuiltChannelInboundEventContext = FinalizedMsgContext & {
  Body: string;
  BodyForAgent: string;
  BodyForCommands: string;
  ChatType: ConversationFacts["kind"];
  CommandAuthorized: boolean;
  CommandBody: string;
  From: string;
  RawBody: string;
  SessionKey: string;
  To: string;
  InboundEventKind: InboundEventKind;
};

function keepSupplementalContext(params: {
  mode?: ContextVisibilityMode;
  kind: "quote" | "forwarded" | "thread";
  senderAllowed?: boolean;
}): boolean {
  if (!params.mode || params.mode === "all") {
    return true;
  }
  if (params.senderAllowed === undefined) {
    return false;
  }
  return shouldIncludeSupplementalContext({
    mode: params.mode,
    kind: params.kind,
    senderAllowed: params.senderAllowed,
  });
}

export function filterChannelInboundSupplementalContext(params: {
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
}): SupplementalContextFacts | undefined {
  const supplemental = params.supplemental;
  if (!supplemental) {
    return undefined;
  }
  const quote = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "quote",
    senderAllowed: supplemental.quote?.senderAllowed,
  })
    ? supplemental.quote
    : undefined;
  const forwarded = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "forwarded",
    senderAllowed: supplemental.forwarded?.senderAllowed,
  })
    ? supplemental.forwarded
    : undefined;
  const thread = keepSupplementalContext({
    mode: params.contextVisibility,
    kind: "thread",
    senderAllowed: supplemental.thread?.senderAllowed,
  })
    ? supplemental.thread
    : undefined;

  return {
    ...supplemental,
    quote,
    forwarded,
    thread,
  };
}

function resolveAccessFactsCommandAuthorized(access: AccessFacts | undefined): boolean | undefined {
  const commands = access?.commands;
  return typeof commands?.authorized === "boolean"
    ? commands.authorized
    : commands?.authorizers?.some((entry) => entry.allowed);
}

function resolveChannelCommandContext(params: {
  command?: CommandFacts;
  commandTurn?: CommandTurnContext;
  message: MessageFacts;
  access?: AccessFacts;
}): CommandTurnContext | undefined {
  if (params.commandTurn) {
    return params.commandTurn;
  }
  const command = params.command;
  if (!command) {
    return undefined;
  }
  const body = command.body ?? params.message.commandBody ?? params.message.rawBody;
  return createCommandTurnContext(commandTurnKindToSource(command.kind), {
    authorized:
      command.kind === "normal"
        ? false
        : (command.authorized ?? resolveAccessFactsCommandAuthorized(params.access) === true),
    commandName: command.name,
    body,
  });
}

export function buildChannelInboundEventContext(
  params: BuildChannelInboundEventContextParams,
): BuiltChannelInboundEventContext {
  const media = params.media ?? [];
  const mediaPayload = buildChannelInboundMediaPayload(media);
  const supplemental = filterChannelInboundSupplementalContext({
    supplemental: params.supplemental,
    contextVisibility: params.contextVisibility,
  });
  const body = params.message.body ?? params.message.rawBody;
  const commandTurn = resolveChannelCommandContext({
    command: params.command,
    commandTurn: params.commandTurn,
    message: params.message,
    access: params.access,
  });

  return finalizeInboundContext({
    Body: body,
    InboundEventKind: params.message.inboundEventKind ?? "user_request",
    BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
    InboundHistory: params.message.inboundHistory,
    RawBody: params.message.rawBody,
    CommandBody: params.message.commandBody ?? params.message.rawBody,
    BodyForCommands: params.message.commandBody ?? params.message.rawBody,
    From: params.from,
    To: params.reply.to,
    SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
    AccountId: params.route.accountId ?? params.accountId,
    ParentSessionKey: params.route.parentSessionKey,
    ModelParentSessionKey: params.route.modelParentSessionKey,
    MessageSid: params.messageId,
    MessageSidFull: params.messageIdFull,
    ReplyToId: params.reply.replyToId ?? supplemental?.quote?.id,
    ReplyToIdFull: params.reply.replyToIdFull ?? supplemental?.quote?.fullId,
    ReplyToBody: supplemental?.quote?.body,
    ReplyToSender: supplemental?.quote?.sender,
    ReplyToIsQuote: supplemental?.quote?.isQuote,
    ForwardedFrom: supplemental?.forwarded?.from,
    ForwardedFromType: supplemental?.forwarded?.fromType,
    ForwardedFromId: supplemental?.forwarded?.fromId,
    ForwardedDate: supplemental?.forwarded?.date,
    ThreadStarterBody: supplemental?.thread?.starterBody,
    ThreadHistoryBody: supplemental?.thread?.historyBody,
    ThreadLabel: supplemental?.thread?.label,
    ...mediaPayload,
    ChatType: params.conversation.kind,
    ConversationLabel: params.conversation.label,
    GroupSubject: params.conversation.kind !== "direct" ? params.conversation.label : undefined,
    GroupSpace: params.conversation.spaceId,
    GroupSystemPrompt: supplemental?.groupSystemPrompt,
    UntrustedStructuredContext: supplemental?.untrustedContext,
    SenderName: params.sender.name ?? params.sender.displayLabel,
    SenderId: params.sender.id,
    SenderUsername: params.sender.username,
    SenderTag: params.sender.tag,
    MemberRoleIds: params.sender.roles,
    Timestamp: params.timestamp,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.provider ?? params.channel,
    WasMentioned: params.access?.mentions?.wasMentioned,
    CommandAuthorized: resolveAccessFactsCommandAuthorized(params.access) === true,
    CommandTurn: commandTurn,
    MessageThreadId: params.reply.messageThreadId ?? params.conversation.threadId,
    NativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.reply.originatingTo,
    ThreadParentId: params.reply.threadParentId ?? params.conversation.parentId,
    ...params.extra,
  });
}
