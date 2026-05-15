import type { CommandTurnContext } from "../../auto-reply/command-turn-context.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { ContextVisibilityMode } from "../../config/types.base.js";
import { shouldIncludeSupplementalContext } from "../../security/context-visibility.js";
import type {
  AccessFacts,
  ConversationFacts,
  InboundMediaFacts,
  MessageFacts,
  ReplyPlanFacts,
  RouteFacts,
  SenderFacts,
  SupplementalContextFacts,
} from "./types.js";

export type BuildChannelTurnContextParams = {
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
  commandTurn?: CommandTurnContext;
  media?: InboundMediaFacts[];
  supplemental?: SupplementalContextFacts;
  contextVisibility?: ContextVisibilityMode;
  extra?: Record<string, unknown>;
};

export type BuiltChannelTurnContext = FinalizedMsgContext & {
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
};

function compactStrings(values: Array<string | undefined>): string[] | undefined {
  const compacted = values.filter((value): value is string => Boolean(value));
  return compacted.length > 0 ? compacted : undefined;
}

function mediaTranscribedIndexes(media: InboundMediaFacts[]): number[] | undefined {
  const indexes = media
    .map((item, index) => (item.transcribed ? index : undefined))
    .filter((index): index is number => index !== undefined);
  return indexes.length > 0 ? indexes : undefined;
}

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

export function filterChannelTurnSupplementalContext(params: {
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

export function buildChannelTurnContext(
  params: BuildChannelTurnContextParams,
): BuiltChannelTurnContext {
  const media = params.media ?? [];
  const supplemental = filterChannelTurnSupplementalContext({
    supplemental: params.supplemental,
    contextVisibility: params.contextVisibility,
  });
  const body = params.message.body ?? params.message.rawBody;

  return finalizeInboundContext({
    Body: body,
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
    MediaPath: media[0]?.path,
    MediaUrl: media[0]?.url ?? media[0]?.path,
    MediaType: media[0]?.contentType ?? media[0]?.kind,
    MediaPaths: compactStrings(media.map((item) => item.path)),
    MediaUrls: compactStrings(media.map((item) => item.url ?? item.path)),
    MediaTypes: compactStrings(media.map((item) => item.contentType ?? item.kind)),
    MediaTranscribedIndexes: mediaTranscribedIndexes(media),
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
    CommandTurn: params.commandTurn,
    MessageThreadId: params.reply.messageThreadId ?? params.conversation.threadId,
    NativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
    OriginatingChannel: params.channel,
    OriginatingTo: params.reply.originatingTo,
    ThreadParentId: params.reply.threadParentId ?? params.conversation.parentId,
    ...params.extra,
  });
}
