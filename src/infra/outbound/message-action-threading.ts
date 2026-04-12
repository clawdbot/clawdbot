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

export function resolveAndApplyOutboundThreadId(
  actionParams: Record<string, unknown>,
  context: {
    cfg: OpenClawConfig;
    to: string;
    accountId?: string | null;
    toolContext?: ChannelThreadingToolContext;
    resolveAutoThreadId?: ResolveAutoThreadId;
  },
): string | undefined {
  const threadId = readStringParam(actionParams, "threadId");
  const resolved =
    threadId ??
    context.resolveAutoThreadId?.({
      cfg: context.cfg,
      accountId: context.accountId,
      to: context.to,
      toolContext: context.toolContext,
      replyToId: readStringParam(actionParams, "replyTo"),
    });
  if (resolved && !actionParams.threadId) {
    actionParams.threadId = resolved;
  }
  return resolved ?? undefined;
}

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
  const replyToId = readStringParam(params.actionParams, "replyTo");
  const resolvedThreadId = resolveAndApplyOutboundThreadId(params.actionParams, {
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    toolContext: params.toolContext,
    resolveAutoThreadId: params.resolveAutoThreadId,
  });
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
    params.actionParams.__sessionKey = outboundRoute.sessionKey;
  }
  if (params.agentId) {
    params.actionParams.__agentId = params.agentId;
  }
  return {
    resolvedThreadId,
    outboundRoute,
  };
}
