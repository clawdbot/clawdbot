import {
  recordInboundSessionMetaSafe as recordInboundSessionMetaSafeImpl,
  resolveConversationLabel as resolveConversationLabelImpl,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveMarkdownTableMode as resolveMarkdownTableModeImpl } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  dispatchReplyWithDispatcher as dispatchReplyWithDispatcherImpl,
  finalizeInboundContext as finalizeInboundContextImpl,
  resolveChunkMode as resolveChunkModeImpl,
} from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute as resolveAgentRouteImpl } from "openclaw/plugin-sdk/routing";
import { deliverSlackSlashReplies as deliverSlackSlashRepliesImpl } from "./replies.js";

type ResolveChunkMode = typeof import("openclaw/plugin-sdk/reply-runtime").resolveChunkMode;
type FinalizeInboundContext =
  typeof import("openclaw/plugin-sdk/reply-runtime").finalizeInboundContext;
type DispatchReplyWithDispatcher =
  typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithDispatcher;
type ResolveConversationLabel =
  typeof import("openclaw/plugin-sdk/conversation-runtime").resolveConversationLabel;
type RecordInboundSessionMetaSafe =
  typeof import("openclaw/plugin-sdk/conversation-runtime").recordInboundSessionMetaSafe;
type ResolveMarkdownTableMode =
  typeof import("openclaw/plugin-sdk/markdown-table-runtime").resolveMarkdownTableMode;
type ResolveAgentRoute = typeof import("openclaw/plugin-sdk/routing").resolveAgentRoute;
type DeliverSlackSlashReplies = typeof import("./replies.js").deliverSlackSlashReplies;

export function resolveChunkMode(
  ...args: Parameters<ResolveChunkMode>
): ReturnType<ResolveChunkMode> {
  return resolveChunkModeImpl(...args);
}

export function finalizeInboundContext(
  ...args: Parameters<FinalizeInboundContext>
): ReturnType<FinalizeInboundContext> {
  return finalizeInboundContextImpl(...args);
}

export function dispatchReplyWithDispatcher(
  ...args: Parameters<DispatchReplyWithDispatcher>
): ReturnType<DispatchReplyWithDispatcher> {
  return dispatchReplyWithDispatcherImpl(...args);
}

export function resolveConversationLabel(
  ...args: Parameters<ResolveConversationLabel>
): ReturnType<ResolveConversationLabel> {
  return resolveConversationLabelImpl(...args);
}

export function recordInboundSessionMetaSafe(
  ...args: Parameters<RecordInboundSessionMetaSafe>
): ReturnType<RecordInboundSessionMetaSafe> {
  return recordInboundSessionMetaSafeImpl(...args);
}

export function resolveMarkdownTableMode(
  ...args: Parameters<ResolveMarkdownTableMode>
): ReturnType<ResolveMarkdownTableMode> {
  return resolveMarkdownTableModeImpl(...args);
}

export function resolveAgentRoute(
  ...args: Parameters<ResolveAgentRoute>
): ReturnType<ResolveAgentRoute> {
  return resolveAgentRouteImpl(...args);
}

export function deliverSlackSlashReplies(
  ...args: Parameters<DeliverSlackSlashReplies>
): ReturnType<DeliverSlackSlashReplies> {
  return deliverSlackSlashRepliesImpl(...args);
}
