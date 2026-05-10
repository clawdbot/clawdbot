import type { QQBotInboundAccess } from "../../adapter/index.js";
import type { InboundContext, InboundGroupInfo } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";
import type { TypingKeepAlive } from "../typing-keepalive.js";

interface BaseStubFields {
  event: QueuedMessage;
  route: { sessionKey: string; accountId: string; agentId?: string };
  isGroupChat: boolean;
  peerId: string;
  qualifiedTarget: string;
  fromAddress: string;
}

function emptyInboundContext(fields: BaseStubFields): InboundContext {
  return {
    event: fields.event,
    route: fields.route,
    isGroupChat: fields.isGroupChat,
    peerId: fields.peerId,
    qualifiedTarget: fields.qualifiedTarget,
    fromAddress: fields.fromAddress,
    agentBody: "",
    body: "",
    groupSystemPrompt: undefined,
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
    uniqueVoicePaths: [],
    uniqueVoiceUrls: [],
    uniqueVoiceAsrReferTexts: [],
    voiceMediaTypes: [],
    hasAsrReferFallback: false,
    voiceTranscriptSources: [],
    replyTo: undefined,
    commandAuthorized: false,
    group: undefined,
    blocked: false,
    skipped: false,
    typing: { keepAlive: null },
    inputNotifyRefIdx: undefined,
  };
}

export function buildBlockedInboundContext(
  params: BaseStubFields & {
    access: QQBotInboundAccess;
  },
): InboundContext {
  return {
    ...emptyInboundContext(params),
    blocked: true,
    blockReason: params.access.senderAccess.reasonCode,
    blockReasonCode: params.access.senderAccess.reasonCode,
    accessDecision: params.access.senderAccess.decision,
  };
}

export function buildSkippedInboundContext(
  params: BaseStubFields & {
    group: InboundGroupInfo;
    skipReason: NonNullable<InboundContext["skipReason"]>;
    access: QQBotInboundAccess;
    typing: { keepAlive: TypingKeepAlive | null };
    inputNotifyRefIdx?: string;
  },
): InboundContext {
  return {
    ...emptyInboundContext(params),
    group: params.group,
    skipped: true,
    skipReason: params.skipReason,
    accessDecision: params.access.senderAccess.decision,
    typing: params.typing,
    inputNotifyRefIdx: params.inputNotifyRefIdx,
  };
}
