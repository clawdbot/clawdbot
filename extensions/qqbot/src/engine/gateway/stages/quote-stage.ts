/**
 * Quote stage — resolve the quoted-reply (`refMsgIdx`) if any.
 *
 * Three-level fallback mirrors the standalone build:
 *   1. RefIndex cache hit → rich ReplyToInfo
 *   2. `msg_elements[0]` present → re-process the quoted body
 *   3. Otherwise → id-only placeholder so the pipeline still knows it's a reply
 */

import {
  evaluateSupplementalContextVisibility,
  resolveChannelContextVisibilityMode,
} from "openclaw/plugin-sdk/context-visibility-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveQQBotEffectivePolicies } from "../../access/resolve-policy.js";
import { normalizeQQBotSenderId } from "../../access/sender-match.js";
import type { QQBotDmPolicy, QQBotGroupPolicy } from "../../access/types.js";
import {
  formatMessageReferenceForAgent,
  type AttachmentProcessor,
} from "../../ref/format-message-ref.js";
import { formatRefEntryForAgent, getRefIndex } from "../../ref/store.js";
import { MSG_TYPE_QUOTE } from "../../utils/text-parsing.js";
import { formatVoiceText } from "../../utils/voice-text.js";
import { processAttachments } from "../inbound-attachments.js";
import type { InboundPipelineDeps, ReplyToInfo } from "../inbound-context.js";
import type { QueuedMessage } from "../message-queue.js";

/**
 * Resolve the quote metadata for an inbound event.
 *
 * Returns `undefined` when the event is not a reply at all.
 */
export async function resolveQuote(
  event: QueuedMessage,
  deps: InboundPipelineDeps,
): Promise<ReplyToInfo | undefined> {
  if (!event.refMsgIdx) {
    return undefined;
  }

  const { account, log } = deps;

  // ---- Layer 1: cache hit ----
  const refEntry = getRefIndex(event.refMsgIdx);
  if (refEntry) {
    log?.debug?.(
      `Quote detected via refMsgIdx cache: refMsgIdx=${event.refMsgIdx}, sender=${refEntry.senderName ?? refEntry.senderId}`,
    );
    const includeQuote = await shouldIncludeQuoteContext({
      event,
      deps,
      senderId: refEntry.senderId,
      senderIsCurrentAccountBot: refEntry.isBot === true && refEntry.senderId === account.accountId,
    });
    if (!includeQuote) {
      log?.debug?.(
        `Quote context omitted by qqbot visibility policy: refMsgIdx=${event.refMsgIdx}, sender=${refEntry.senderName ?? refEntry.senderId}`,
      );
      return {
        id: event.refMsgIdx,
        isQuote: true,
      };
    }
    return {
      id: event.refMsgIdx,
      body: formatRefEntryForAgent(refEntry),
      sender: refEntry.senderName ?? refEntry.senderId,
      isQuote: true,
    };
  }

  // ---- Layer 2: fall back to msg_elements[0] if this is a quote type ----
  if (event.msgType === MSG_TYPE_QUOTE && event.msgElements?.[0]) {
    if (!(await shouldIncludeQuoteContext({ event, deps }))) {
      log?.debug?.(
        `Quote context omitted by qqbot visibility policy because sender was unavailable: refMsgIdx=${event.refMsgIdx}`,
      );
      return {
        id: event.refMsgIdx,
        isQuote: true,
      };
    }
    try {
      const refElement = event.msgElements[0];
      const refData = {
        content: refElement.content ?? "",
        attachments: refElement.attachments,
      };
      const attachmentProcessor: AttachmentProcessor = {
        processAttachments: async (atts, refCtx) => {
          const result = await processAttachments(
            atts as Array<{
              content_type: string;
              url: string;
              filename?: string;
              voice_wav_url?: string;
              asr_refer_text?: string;
            }>,
            {
              accountId: account.accountId,
              cfg: refCtx.cfg,
              audioConvert: deps.adapters.audioConvert,
              log: refCtx.log,
            },
          );
          return {
            attachmentInfo: result.attachmentInfo,
            voiceTranscripts: result.voiceTranscripts,
            voiceTranscriptSources: result.voiceTranscriptSources,
            attachmentLocalPaths: result.attachmentLocalPaths,
          };
        },
        formatVoiceText: (transcripts) => formatVoiceText(transcripts),
      };
      const refPeerId =
        event.type === "group" && event.groupOpenid ? event.groupOpenid : event.senderId;
      const refBody = await formatMessageReferenceForAgent(
        refData,
        { appId: account.appId, peerId: refPeerId, cfg: account.config, log },
        attachmentProcessor,
      );
      log?.debug?.(
        `Quote detected via msg_elements[0] (cache miss): id=${event.refMsgIdx}, content="${truncateUtf16Safe(refBody ?? "", 80)}..."`,
      );
      return {
        id: event.refMsgIdx,
        body: refBody || undefined,
        isQuote: true,
      };
    } catch (refErr) {
      log?.error(`Failed to format quoted message from msg_elements: ${String(refErr)}`);
    }
  } else {
    log?.debug?.(
      `Quote detected but no cache and msgType=${event.msgType}: refMsgIdx=${event.refMsgIdx}`,
    );
  }

  // ---- Layer 3: id-only placeholder ----
  return {
    id: event.refMsgIdx,
    isQuote: true,
  };
}

async function shouldIncludeQuoteContext(params: {
  event: QueuedMessage;
  deps: InboundPipelineDeps;
  senderId?: string;
  senderIsCurrentAccountBot?: boolean;
}): Promise<boolean> {
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.deps.cfg,
    channel: "qqbot",
    accountId: params.deps.account.accountId,
  });
  if (
    params.senderIsCurrentAccountBot ||
    evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: "quote",
      senderAllowed: false,
    }).include
  ) {
    return true;
  }

  const visibilityPolicy = resolveQuoteVisibilityPolicy(params.event, params.deps.account.config);
  if (!visibilityPolicy.requiresSenderCheck) {
    return evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: "quote",
      senderAllowed: true,
    }).include;
  }

  let senderAllowed = false;
  if (params.senderId) {
    const quotedAccess = await params.deps.adapters.access.resolveInboundAccess({
      cfg: params.deps.cfg,
      accountId: params.deps.account.accountId,
      isGroup: isGroupConversation(params.event),
      senderId: params.senderId,
      conversationId: resolveConversationId(params.event),
      allowFrom: params.deps.account.config?.allowFrom,
      groupAllowFrom: params.deps.account.config?.groupAllowFrom,
      dmPolicy: visibilityPolicy.dmPolicy ?? params.deps.account.config?.dmPolicy,
      groupPolicy: visibilityPolicy.groupPolicy ?? params.deps.account.config?.groupPolicy,
    });
    senderAllowed = quotedAccess.senderAccess.decision === "allow";
  }

  return evaluateSupplementalContextVisibility({
    mode: contextVisibilityMode,
    kind: "quote",
    senderAllowed,
  }).include;
}

type QuoteVisibilityPolicy = {
  requiresSenderCheck: boolean;
  dmPolicy?: QQBotDmPolicy;
  groupPolicy?: QQBotGroupPolicy;
};

function resolveQuoteVisibilityPolicy(
  event: QueuedMessage,
  config: InboundPipelineDeps["account"]["config"],
): QuoteVisibilityPolicy {
  const policies = resolveQQBotEffectivePolicies(config ?? {});
  if (isGroupConversation(event)) {
    const groupAllowFrom = resolveGroupQuoteAllowFrom(config);
    if (hasUniversalAllowlist(groupAllowFrom)) {
      return { requiresSenderCheck: false };
    }
    if (policies.groupPolicy === "open") {
      return hasRestrictedAllowlist(groupAllowFrom)
        ? { requiresSenderCheck: true, groupPolicy: "allowlist" }
        : { requiresSenderCheck: false };
    }
    if (policies.groupPolicy === "disabled") {
      return { requiresSenderCheck: true };
    }
    return { requiresSenderCheck: true };
  }
  if (policies.dmPolicy === "disabled") {
    return { requiresSenderCheck: true };
  }
  if (hasUniversalAllowlist(config?.allowFrom)) {
    return { requiresSenderCheck: false };
  }
  return {
    requiresSenderCheck: policies.dmPolicy !== "open" || hasRestrictedAllowlist(config?.allowFrom),
  };
}

function isGroupConversation(event: QueuedMessage): boolean {
  return event.type === "guild" || event.type === "group";
}

function resolveConversationId(event: QueuedMessage): string {
  if (event.type === "guild") {
    return event.channelId ?? "unknown";
  }
  if (event.type === "group") {
    return event.groupOpenid ?? "unknown";
  }
  return event.senderId;
}

function resolveGroupQuoteAllowFrom(
  config: InboundPipelineDeps["account"]["config"],
): Array<string | number> | undefined {
  return config?.groupAllowFrom && config.groupAllowFrom.length > 0
    ? config.groupAllowFrom
    : config?.allowFrom;
}

function hasUniversalAllowlist(list: Array<string | number> | undefined | null): boolean {
  return (list ?? []).some((entry) => normalizeQQBotSenderId(entry) === "*");
}

function hasRestrictedAllowlist(list: Array<string | number> | undefined | null): boolean {
  return (list ?? []).some((entry) => {
    const normalized = normalizeQQBotSenderId(entry);
    return normalized !== "" && normalized !== "*";
  });
}
