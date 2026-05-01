/**
 * Shared `InboundContext` stub builders for early-return paths.
 *
 * Both the access-control "blocked" path and the group-gate "skipped"
 * path need to return a fully populated {@link InboundContext} that the
 * upstream handler can inspect without crashing on undefined fields.
 * Centralising the stubs here prevents the two paths from drifting.
 */

import type { QQBotAccessResult } from "../../access/index.js";
import type { InboundContext, InboundGroupInfo } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";
import type { TypingKeepAlive } from "../typing-keepalive.js";

/** Shared fields every stub context needs. */
interface BaseStubFields {
  event: QueuedMessage;
  route: { sessionKey: string; accountId: string; agentId?: string };
  isGroupChat: boolean;
  peerId: string;
  qualifiedTarget: string;
  fromAddress: string;
}

/** Build an {@link InboundContext} with all non-routing fields cleared. */
function emptyInboundContext(fields: BaseStubFields): InboundContext {
  return {
    event: fields.event,
    route: fields.route,
    isGroupChat: fields.isGroupChat,
    peerId: fields.peerId,
    qualifiedTarget: fields.qualifiedTarget,
    fromAddress: fields.fromAddress,
    parsedContent: "",
    userContent: "",
    quotePart: "",
    dynamicCtx: "",
    userMessage: "",
    agentBody: "",
    body: "",
    systemPrompts: [],
    groupSystemPrompt: undefined,
    attachments: {
      attachmentInfo: "",
      imageUrls: [],
      imageMediaTypes: [],
      voiceAttachmentPaths: [],
      voiceAttachmentUrls: [],
      voiceAsrReferTexts: [],
      voiceTranscripts: [],
      voiceTranscriptSources: [],
      attachmentLocalPaths: [],
    },
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
    remoteMediaTypes: [],
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

/**
 * Build an {@link InboundContext} that represents a message blocked by
 * access control (policy denial, allowlist mismatch, etc.).
 */
export function buildBlockedInboundContext(
  params: BaseStubFields & {
    access: QQBotAccessResult;
  },
): InboundContext {
  return {
    ...emptyInboundContext(params),
    blocked: true,
    blockReason: params.access.reason,
    blockReasonCode: params.access.reasonCode,
    accessDecision: params.access.decision,
  };
}

/**
 * Build an {@link InboundContext} that represents a message stopped by
 * the group gate (drop_other_mention, block_unauthorized_command,
 * skip_no_mention). Any history side-effects have already been applied
 * by the gate stage.
 */
export function buildSkippedInboundContext(
  params: BaseStubFields & {
    group: InboundGroupInfo;
    skipReason: NonNullable<InboundContext["skipReason"]>;
    access: QQBotAccessResult;
    typing: { keepAlive: TypingKeepAlive | null };
    inputNotifyRefIdx?: string;
  },
): InboundContext {
  return {
    ...emptyInboundContext(params),
    group: params.group,
    skipped: true,
    skipReason: params.skipReason,
    accessDecision: params.access.decision,
    typing: params.typing,
    inputNotifyRefIdx: params.inputNotifyRefIdx,
  };
}
