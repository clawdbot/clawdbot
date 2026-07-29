// Message-action threading helpers inherit reply/thread metadata only for
// same-conversation sends and prepare outbound session mirroring.
import { readStringParam } from "../../agents/tools/common.js";
import type {
  ChannelId,
  ChannelThreadingAdapter,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  OutboundSessionRoute,
  ResolveOutboundSessionRouteParams,
} from "./outbound-session.js";
import type { ResolvedMessagingTarget } from "./target-resolver.js";

type ResolveAutoThreadId = NonNullable<ChannelThreadingAdapter["resolveAutoThreadId"]>;
type ResolveReplyTransport = NonNullable<ChannelThreadingAdapter["resolveReplyTransport"]>;
type MatchesToolContextTarget = NonNullable<ChannelThreadingAdapter["matchesToolContextTarget"]>;

function suppressesImplicitThreading(actionParams: Record<string, unknown>): boolean {
  return actionParams.topLevel === true || actionParams.threadId === null;
}

/** Resolves and writes the outbound thread id used by message-action sends. */
export function resolveAndApplyOutboundThreadId(
  actionParams: Record<string, unknown>,
  context: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    toolContext?: ChannelThreadingToolContext;
    resolveAutoThreadId?: ResolveAutoThreadId;
    resolveReplyTransport?: ResolveReplyTransport;
    replyToIsExplicit?: boolean;
  },
): string | undefined {
  const threadId = readStringParam(actionParams, "threadId");
  // `topLevel` and explicit null thread ids are caller opt-outs from inherited threading.
  if (!threadId && suppressesImplicitThreading(actionParams)) {
    return undefined;
  }
  const replyToId = readStringParam(actionParams, "replyTo");
  const autoResolvedThreadId = threadId
    ? undefined
    : context.resolveAutoThreadId?.({
        cfg: context.cfg,
        accountId: context.accountId,
        to: context.to,
        toolContext: context.toolContext,
        replyToId,
      });
  const resolvedThreadId = threadId ?? autoResolvedThreadId;
  if (autoResolvedThreadId && !actionParams.threadId) {
    actionParams.threadId = autoResolvedThreadId;
  }
  if (replyToId && resolvedThreadId) {
    const canonicalReplyToId = context.resolveReplyTransport?.({
      cfg: context.cfg,
      accountId: context.accountId,
      threadId: resolvedThreadId,
      replyToId,
      replyToIsExplicit: context.replyToIsExplicit,
    })?.replyToId;
    // Providers that use one canonical root for reply and thread routing opt in
    // through resolveReplyTransport. Other transports keep message replies intact.
    if (canonicalReplyToId && replyToId !== canonicalReplyToId) {
      actionParams.replyTo = canonicalReplyToId;
    }
  }
  return resolvedThreadId ?? undefined;
}

function isSameConversationTarget(
  actionParams: Record<string, unknown>,
  channel: ChannelId,
  toolContext?: ChannelThreadingToolContext,
  matchesToolContextTarget?: MatchesToolContextTarget,
): boolean {
  const currentChannelId = toolContext?.currentChannelId?.trim();
  const currentMessagingTarget = toolContext?.currentMessagingTarget?.trim();
  if (!currentChannelId && !currentMessagingTarget) {
    return false;
  }
  const currentChannelProvider = toolContext?.currentChannelProvider?.trim();
  if (currentChannelProvider && currentChannelProvider !== channel) {
    return false;
  }
  const explicitTarget =
    readStringParam(actionParams, "target") ??
    readStringParam(actionParams, "to") ??
    readStringParam(actionParams, "channelId");
  if (!explicitTarget) {
    return true;
  }
  const target = explicitTarget.trim();
  if (toolContext && matchesToolContextTarget?.({ target, toolContext })) {
    return true;
  }
  return target === currentMessagingTarget || target === currentChannelId;
}

/** Resolves and writes reply-to metadata for same-conversation message-action sends. */
export function resolveAndApplyOutboundReplyToId(
  actionParams: Record<string, unknown>,
  context: {
    channel: ChannelId;
    toolContext?: ChannelThreadingToolContext;
    matchesToolContextTarget?: MatchesToolContextTarget;
  },
): string | undefined {
  const explicitReplyToId = readStringParam(actionParams, "replyTo");
  if (explicitReplyToId) {
    if (context.toolContext?.replyToMode === "first") {
      const hasRepliedRef = context.toolContext.hasRepliedRef;
      if (hasRepliedRef) {
        hasRepliedRef.value = true;
      }
    }
    return explicitReplyToId;
  }
  if (suppressesImplicitThreading(actionParams)) {
    return undefined;
  }
  if (
    !isSameConversationTarget(
      actionParams,
      context.channel,
      context.toolContext,
      context.matchesToolContextTarget,
    )
  ) {
    return undefined;
  }

  const currentMessageId = context.toolContext?.currentMessageId;
  if (currentMessageId == null) {
    return undefined;
  }

  const mode = context.toolContext?.replyToMode ?? "off";
  if (mode === "off" || mode === "batched") {
    return undefined;
  }

  if (mode === "first") {
    const hasRepliedRef = context.toolContext?.hasRepliedRef;
    if (hasRepliedRef?.value) {
      return undefined;
    }
    // First-reply mode consumes the current inbound message once across batched sends.
    if (hasRepliedRef) {
      hasRepliedRef.value = true;
    }
  }

  const resolvedReplyToId =
    typeof currentMessageId === "number" ? String(currentMessageId) : currentMessageId.trim();
  if (!resolvedReplyToId) {
    return undefined;
  }
  actionParams.replyTo = resolvedReplyToId;
  return resolvedReplyToId;
}

/** Prepares outbound session mirroring metadata for message-action sends. */
export async function prepareOutboundMirrorRoute(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  to: string;
  actionParams: Record<string, unknown>;
  accountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
  agentId?: string;
  currentSessionKey?: string;
  dryRun?: boolean;
  resolvedTarget?: ResolvedMessagingTarget;
  resolveAutoThreadId?: ResolveAutoThreadId;
  resolveReplyTransport?: ResolveReplyTransport;
  replyToIsExplicit?: boolean;
  resolveOutboundSessionRoute: (
    params: ResolveOutboundSessionRouteParams,
  ) => Promise<OutboundSessionRoute | null>;
  ensureOutboundSessionEntry: (params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    accountId?: string | null;
    route: OutboundSessionRoute;
  }) => Promise<void>;
}): Promise<{
  resolvedThreadId?: string;
  outboundRoute: OutboundSessionRoute | null;
}> {
  const resolvedThreadId = resolveAndApplyOutboundThreadId(params.actionParams, {
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    toolContext: params.toolContext,
    resolveAutoThreadId: params.resolveAutoThreadId,
    resolveReplyTransport: params.resolveReplyTransport,
    replyToIsExplicit: params.replyToIsExplicit,
  });
  const replyToId = readStringParam(params.actionParams, "replyTo");
  const outboundRoute =
    params.agentId && !params.dryRun
      ? await params.resolveOutboundSessionRoute({
          cfg: params.cfg,
          channel: params.channel,
          agentId: params.agentId,
          accountId: params.accountId,
          target: params.to,
          currentSessionKey: params.currentSessionKey,
          resolvedTarget: params.resolvedTarget,
          replyToId,
          threadId: resolvedThreadId,
        })
      : null;
  if (outboundRoute && params.agentId && !params.dryRun) {
    await params.ensureOutboundSessionEntry({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      route: outboundRoute,
    });
  }
  if (outboundRoute && !params.dryRun) {
    params.actionParams["__sessionKey"] = outboundRoute.sessionKey;
  }
  if (params.agentId) {
    params.actionParams["__agentId"] = params.agentId;
  }
  return {
    resolvedThreadId,
    outboundRoute,
  };
}
