import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalNativeReplyContext } from "./monitor/event-handler.types.js";

type SignalNativeReplyIdPlan = {
  peek: () => string | undefined;
  use: () => string | undefined;
  markSent: () => void;
};

function resolveSignalNativeReplyId(params: {
  payload: ReplyPayload;
  replyContext?: SignalNativeReplyContext;
}): string | undefined {
  if (params.payload.replyToCurrent === false) {
    return undefined;
  }
  const payloadReplyToId = normalizeOptionalString(params.payload.replyToId);
  const isExplicitCurrentReply =
    params.payload.replyToTag === true || params.payload.replyToCurrent === true;
  if (
    !payloadReplyToId &&
    !isExplicitCurrentReply &&
    params.replyContext?.allowImplicitCurrentMessage === false
  ) {
    return undefined;
  }
  const contextReplyToId = normalizeOptionalString(params.replyContext?.replyToId);
  if (!contextReplyToId || (payloadReplyToId && payloadReplyToId !== contextReplyToId)) {
    return undefined;
  }
  return payloadReplyToId ?? contextReplyToId;
}

function isSignalStatusNoticePayload(payload: ReplyPayload): boolean {
  return Boolean(payload.isCompactionNotice || payload.isFallbackNotice || payload.isStatusNotice);
}

export function createSignalNativeReplyIdPlan(params: {
  payload: ReplyPayload;
  replyContext?: SignalNativeReplyContext;
  replyToMode: ReplyToMode;
}): SignalNativeReplyIdPlan {
  const replyToId = resolveSignalNativeReplyId(params);
  if (!replyToId) {
    return { peek: () => undefined, use: () => undefined, markSent: () => undefined };
  }
  const isExplicitReply =
    params.payload.replyToTag === true || params.payload.replyToCurrent === true;
  const isStatusNotice = isSignalStatusNoticePayload(params.payload);
  if (isStatusNotice) {
    const resolve = params.replyToMode === "off" ? () => undefined : () => replyToId;
    return { peek: resolve, use: resolve, markSent: () => undefined };
  }
  if (isExplicitReply) {
    const resolve = () => replyToId;
    return { peek: resolve, use: resolve, markSent: () => undefined };
  }
  const planner = createReplyReferencePlanner({
    replyToMode: params.replyToMode,
    existingId: replyToId,
    hasReplied: params.replyContext?.state?.hasReplied,
  });
  const syncState = () => {
    if (params.replyContext?.state) {
      params.replyContext.state.hasReplied = planner.hasReplied();
    }
  };
  return {
    peek: () => planner.peek(),
    use: () => {
      const nextReplyToId = planner.use();
      syncState();
      return nextReplyToId;
    },
    markSent: () => {
      planner.markSent();
      syncState();
    },
  };
}

export function createSignalNativeReplyIdResolver(params: {
  payload: ReplyPayload;
  replyContext?: SignalNativeReplyContext;
  replyToMode: ReplyToMode;
}): () => string | undefined {
  const plan = createSignalNativeReplyIdPlan(params);
  return plan.use;
}
