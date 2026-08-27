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
    account.streamingMode !== "off" &&
    resolveChannelStreamingPreviewToolProgress(account.config, true, account.streamingMode)
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

export function buildMattermostButtonInteractionMessageSid(params: {
  postId: string;
  actionId: string;
}): string {
  return `interaction:${params.postId}:${params.actionId}`;
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

export function resolveMattermostInteractionReplyRootId(params: {
  kind: ChatType;
  threadRootId?: string;
  replyToId?: string;
  interactionMessageSid: string;
  sourcePostId: string;
}): string | undefined {
  const interactionMessageSid = normalizeOptionalString(params.interactionMessageSid);
  const replyToId = normalizeOptionalString(params.replyToId);
  // Interaction MessageSid values identify synthetic inbound events, not provider posts.
  // Map only reply-to-current back to the source post or Mattermost rejects the root.
  const providerReplyToId =
    replyToId === interactionMessageSid ? normalizeOptionalString(params.sourcePostId) : replyToId;
  return resolveMattermostReplyRootId({
    kind: params.kind,
    threadRootId: params.threadRootId,
    replyToId: providerReplyToId,
  });
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
  /** Thread root for this turn; `undefined` for a top-level, non-threaded turn. */
  threadRootId: string | undefined;
}): string | null {
  // A top-level DM always dispatches immediately, so it does not need the
  // pending-room history window; keeping it out also avoids one empty bucket per
  // DM conversation.
  //
  // A thread-scoped DM is not the same case. Opting a DM into threading gives
  // each thread its own session with no parent inheritance, so this window is
  // the only in-process record of that thread — and the one thing a restart or a
  // session clear can rebuild it from (#93204). Excluding it here was written
  // when every DM was flat and predates DM threading being configurable.
  if (params.kind === "direct" && !params.threadRootId) {
    return null;
  }
  return params.sessionKey;
}

export function resolveMattermostReactionChannelId(
  payload: Pick<MattermostEventPayload, "broadcast" | "data">,
): string | undefined {
  return (
    normalizeOptionalString(payload.broadcast?.channel_id) ??
    normalizeOptionalString(payload.data?.channel_id)
  );
}
