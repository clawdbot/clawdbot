// Mattermost plugin module owns monitor routing and delivery context helpers.
import { resolveChannelStreamingPreviewToolProgress } from "openclaw/plugin-sdk/channel-outbound";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedMattermostAccount } from "./accounts.js";
import { resolveThreadSessionKeys } from "./monitor-helpers.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import {
  evaluateMattermostNoVisibleReply,
  formatMattermostNoVisibleReplyLog,
} from "./no-visible-reply-diagnostic.js";
import type { MattermostReplyDeliveryOutcome } from "./reply-delivery.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";

export function shouldUpdateMattermostDraftToolProgress(
  account: Pick<ResolvedMattermostAccount, "config" | "streamingMode">,
): boolean {
  return (
    account.streamingMode !== "off" && resolveChannelStreamingPreviewToolProgress(account.config)
  );
}

export function shouldSuppressMattermostDefaultToolProgressMessages(
  account: Pick<ResolvedMattermostAccount, "streamingMode">,
): boolean {
  return account.streamingMode !== "off";
}

export function buildMattermostModelPickerSelectMessageSid(params: {
  postId: string;
  provider: string;
  model: string;
}): string {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const model = normalizeLowercaseStringOrEmpty(params.model);
  return `interaction:${params.postId}:select:${provider}/${model}`;
}

export function resolveMattermostReplyRootId(params: {
  kind: ChatType;
  threadRootId?: string;
  replyToId?: string;
}): string | undefined {
  const threadRootId = normalizeOptionalString(params.threadRootId);
  // Flat DMs (no thread context) get no reply root. A DM carries a threadRootId
  // only when its effective per-chat-type mode enables threading.
  if (params.kind === "direct" && !threadRootId) {
    return undefined;
  }
  if (threadRootId) {
    return threadRootId;
  }
  return normalizeOptionalString(params.replyToId);
}

export function canFinalizeMattermostPreviewInPlace(params: {
  kind: ChatType;
  previewRootId?: string;
  threadRootId?: string;
  replyToId?: string;
}): boolean {
  return (
    resolveMattermostReplyRootId({
      kind: params.kind,
      threadRootId: params.threadRootId,
      replyToId: params.replyToId,
    }) === params.previewRootId?.trim()
  );
}

export function formatMattermostFinalDeliveryOutcomeLog(params: {
  outcome: MattermostReplyDeliveryOutcome;
  payload: ReplyPayload;
  to: string;
  accountId: string;
  agentId: string | undefined;
}): string | undefined {
  const violation = evaluateMattermostNoVisibleReply({
    outcome: params.outcome,
    payload: params.payload,
  });
  if (violation) {
    return formatMattermostNoVisibleReplyLog({
      violation,
      to: params.to,
      accountId: params.accountId,
      agentId: params.agentId,
    });
  }
  if (params.outcome === "text" || params.outcome === "media") {
    return `delivered reply to ${params.to}`;
  }
  return undefined;
}

function resolveMattermostEffectiveReplyToId(params: {
  kind: ChatType;
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): string | undefined {
  // Flat DMs never thread. Opted-in DMs use the same thread-root logic as rooms;
  // replyToMode already reflects the effective per-chat-type mode.
  if (params.kind === "direct" && params.replyToMode === "off") {
    return undefined;
  }
  const threadRootId = normalizeOptionalString(params.threadRootId);
  if (threadRootId) {
    return threadRootId;
  }
  const postId = normalizeOptionalString(params.postId);
  if (!postId) {
    return undefined;
  }
  return params.replyToMode === "all" ||
    params.replyToMode === "first" ||
    params.replyToMode === "batched"
    ? postId
    : undefined;
}

export function resolveMattermostThreadSessionContext(params: {
  baseSessionKey: string;
  kind: ChatType;
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): { effectiveReplyToId?: string; sessionKey: string; parentSessionKey?: string } {
  const effectiveReplyToId = resolveMattermostEffectiveReplyToId({
    kind: params.kind,
    postId: params.postId,
    replyToMode: params.replyToMode,
    threadRootId: params.threadRootId,
  });
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: effectiveReplyToId,
    // DM threads start fresh; room threads inherit their base session.
    parentSessionKey:
      effectiveReplyToId && params.kind !== "direct" ? params.baseSessionKey : undefined,
  });
  return {
    effectiveReplyToId,
    sessionKey: threadKeys.sessionKey,
    parentSessionKey: threadKeys.parentSessionKey,
  };
}

export function resolveMattermostPendingHistoryKey(params: {
  kind: ChatType;
  sessionKey: string;
}): string | null {
  // DMs always dispatch immediately, so they do not need the pending-room
  // history window. Keeping them out also avoids one empty bucket per DM thread.
  return params.kind === "direct" ? null : params.sessionKey;
}

export function resolveMattermostReactionChannelId(
  payload: Pick<MattermostEventPayload, "broadcast" | "data">,
): string | undefined {
  return (
    normalizeOptionalString(payload.broadcast?.channel_id) ??
    normalizeOptionalString(payload.data?.channel_id)
  );
}
