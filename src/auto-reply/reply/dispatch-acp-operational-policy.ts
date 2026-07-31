import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { applyOperationalReplyPolicy } from "./operational-reply-policy.js";

export function createAcpOperationalReplyPolicyApplier(params: {
  abortSignal?: AbortSignal;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  deliverySessionKey: string | undefined;
  directChannel: string | undefined;
  originatingAccountId?: string;
  originatingChannel?: string;
  originatingChatType?: ChatType;
  originatingThreadId?: string | number;
  originatingTo?: string;
  resolvedAccountId?: string;
  runId?: string;
  sendPolicyDenied?: boolean;
  ttsChannel?: string;
}) {
  const sourceEventKey =
    normalizeOptionalString(params.ctx.MessageSidFull) ??
    normalizeOptionalString(params.ctx.MessageSid) ??
    normalizeOptionalString(params.ctx.AmbientTranscriptMessageId) ??
    normalizeOptionalString(params.ctx.MessageSidLast) ??
    normalizeOptionalString(params.ctx.MessageSidFirst) ??
    normalizeOptionalString(params.runId) ??
    crypto.randomUUID();

  return async (payload: ReplyPayload) =>
    await applyOperationalReplyPolicy({
      abortSignal: params.abortSignal,
      cfg: params.cfg,
      payload,
      explicitCommandTurn: getReplyPayloadMetadata(payload)?.commandReply === true,
      sendPolicyDenied: params.sendPolicyDenied === true,
      sourceSessionKey: params.deliverySessionKey,
      sourceEventKey,
      sourceChannel: params.originatingChannel ?? params.ttsChannel ?? params.directChannel,
      sourceConversationKey: JSON.stringify({
        accountId: params.originatingAccountId ?? params.resolvedAccountId,
        channel: params.originatingChannel ?? params.ttsChannel ?? params.directChannel,
        from: params.ctx.From,
        threadId: params.originatingThreadId,
        to: params.originatingTo ?? params.ctx.To,
      }),
      provider: params.ctx.Provider,
      surface: params.ctx.Surface,
      chatType: params.originatingChatType ?? params.ctx.ChatType,
      inboundEventKind: params.ctx.InboundEventKind,
      messageKey: params.ctx.MessageSidFull ?? params.ctx.MessageSid ?? params.runId,
      logPrefix: "dispatch-acp",
    });
}
