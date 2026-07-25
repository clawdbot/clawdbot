/** Utilities for queued reply runtime config, auth, threading, and embedded run params. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import {
  getAgentRuntimeCommandSecretTargetIds,
  getScopedChannelsCommandSecretTargets,
} from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
  type OpenClawConfig,
} from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import type { TemplateContext } from "../templating.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
export { resolveRunAuthProfile };
import { buildEmbeddedRunBaseParams as buildEmbeddedRunBaseParamsCore } from "./agent-runner-run-params.js";
export { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;
type EmbeddedReplyRoute = Pick<
  FollowupRun,
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingChatType"
  | "originatingThreadId"
  | "originatingReplyToId"
>;

/** Selects the freshest runtime config usable by queued reply execution. */
export function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig {
  const runtimeConfig =
    typeof getRuntimeConfigSnapshot === "function" ? getRuntimeConfigSnapshot() : null;
  const runtimeSourceConfig =
    typeof getRuntimeConfigSourceSnapshot === "function" ? getRuntimeConfigSourceSnapshot() : null;
  return (
    selectApplicableRuntimeConfig({
      inputConfig: config,
      runtimeConfig,
      runtimeSourceConfig,
    }) ?? config
  );
}

/** Resolves command secrets for queued reply execution, scoped to the origin route. */
export async function resolveQueuedReplyExecutionConfig(
  config: OpenClawConfig,
  params?: {
    originatingChannel?: string;
    messageProvider?: string;
    originatingAccountId?: string;
    agentAccountId?: string;
  },
): Promise<OpenClawConfig> {
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(config);
  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    config: runtimeConfig,
    commandName: "reply",
    targetIds: getAgentRuntimeCommandSecretTargetIds(),
  });
  const baseResolvedConfig = resolvedConfig ?? runtimeConfig;

  const scope = resolveMessageSecretScope({
    channel: params?.originatingChannel,
    fallbackChannel: params?.messageProvider,
    accountId: params?.originatingAccountId,
    fallbackAccountId: params?.agentAccountId,
  });
  if (!scope.channel) {
    return baseResolvedConfig;
  }

  const scopedTargets = getScopedChannelsCommandSecretTargets({
    config: baseResolvedConfig,
    channel: scope.channel,
    accountId: scope.accountId,
  });
  if (scopedTargets.targetIds.size === 0) {
    return baseResolvedConfig;
  }

  const scopedResolved = await resolveCommandSecretRefsViaGateway({
    config: baseResolvedConfig,
    commandName: "reply",
    targetIds: scopedTargets.targetIds,
    ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
  });
  return scopedResolved.resolvedConfig ?? baseResolvedConfig;
}

/**
 * Build provider-specific threading context for tool auto-injection.
 */
/** Builds channel threading context for message-tool replies. */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: OpenClawConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): InternalChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  const isRestartSentinelContinuation =
    sessionCtx.InputProvenance?.kind === "internal_system" &&
    sessionCtx.InputProvenance.sourceTool === "restart-sentinel";
  const currentMessageId = isRestartSentinelContinuation
    ? sessionCtx.ReplyToId
    : (sessionCtx.MessageSidFull ?? sessionCtx.MessageSid);
  const currentSourceTurnId = readChannelSourceTurnId(sessionCtx);
  const originProvider = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Provider,
  });
  const originTo = resolveOriginMessageTo({
    originatingTo: sessionCtx.OriginatingTo,
    to: sessionCtx.To,
  });
  if (!config) {
    return {
      currentMessageId,
      currentSourceTurnId,
    };
  }
  const rawProvider = normalizeOptionalLowercaseString(originProvider);
  if (!rawProvider) {
    return {
      currentMessageId,
      currentSourceTurnId,
    };
  }
  const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., iMessage before plugin registry init)
  const threading = provider ? getChannelPlugin(provider)?.threading : undefined;
  if (!threading?.buildToolContext) {
    return {
      currentChannelId: normalizeOptionalString(originTo),
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
      currentMessageId,
      currentSourceTurnId,
      hasRepliedRef,
    };
  }
  const context =
    threading.buildToolContext({
      cfg: config,
      accountId: sessionCtx.AccountId,
      context: {
        Channel: originProvider,
        From: sessionCtx.From,
        To: originTo,
        ChatType: sessionCtx.ChatType,
        CurrentMessageId: currentMessageId,
        ReplyToMode: sessionCtx.ReplyToMode,
        ReplyToId: sessionCtx.ReplyToId,
        ReplyToIdFull: sessionCtx.ReplyToIdFull,
        ThreadLabel: sessionCtx.ThreadLabel,
        MessageThreadId: sessionCtx.MessageThreadId,
        TransportThreadId: sessionCtx.TransportThreadId,
        NativeChannelId: sessionCtx.NativeChannelId,
      },
      hasRepliedRef,
    }) ?? {};
  const hasAdapterCurrentMessageId = Object.hasOwn(context, "currentMessageId");
  return {
    ...context,
    currentChannelProvider: provider!, // guaranteed non-null since threading exists
    // Some providers expose only thread resources as reply targets; explicit
    // `undefined` means the adapter rejected the generic message-id fallback.
    currentMessageId: hasAdapterCurrentMessageId ? context.currentMessageId : currentMessageId,
    currentSourceTurnId,
  };
}

/** Detects Bun socket-close errors that should be formatted more clearly. */
export const isBunFetchSocketError = (message?: string) =>
  message ? BUN_FETCH_SOCKET_ERROR_RE.test(message) : false;

/** Formats Bun socket-close errors for user-facing reply output. */
export const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

/** Resolves candidate-scoped fast mode after model fallback changes provider/model. */
export function resolveRunFastModeForFallbackCandidate(params: {
  run: FollowupRun["run"];
  config: OpenClawConfig;
  provider: string;
  model: string;
  sessionEntry?: Pick<SessionEntry, "fastMode">;
}) {
  const state = resolveFastModeState({
    cfg: params.config,
    provider: params.provider,
    model: params.model,
    agentId: params.run.agentId,
    sessionEntry: params.sessionEntry,
  });
  if (params.run.fastModeOverride) {
    return {
      fastMode: params.run.fastMode,
      fastModeAutoOnSeconds: params.run.fastModeAutoOnSecondsOverride
        ? params.run.fastModeAutoOnSeconds
        : state.fastAutoOnSeconds,
    };
  }
  return {
    fastMode: state.mode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSecondsOverride
      ? params.run.fastModeAutoOnSeconds
      : state.fastAutoOnSeconds,
  };
}
/** Builds base embedded run params with auth and provider runtime hints. */
function buildEmbeddedRunBaseParams(params: Parameters<typeof buildEmbeddedRunBaseParamsCore>[0]) {
  return buildEmbeddedRunBaseParamsCore({
    ...params,
    isReasoningTagProvider,
  });
}

function buildEmbeddedContextFromTemplate(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}) {
  const config = params.run.config;
  const sessionCtx = {
    ...params.sessionCtx,
    OriginatingChannel:
      params.replyRoute?.originatingChannel ?? params.sessionCtx.OriginatingChannel,
    OriginatingTo: params.replyRoute?.originatingTo ?? params.sessionCtx.OriginatingTo,
    AccountId:
      params.replyRoute?.originatingAccountId ??
      params.sessionCtx.AccountId ??
      params.run.agentAccountId,
    ChatType:
      normalizeChatType(params.replyRoute?.originatingChatType) ??
      normalizeChatType(params.sessionCtx.ChatType) ??
      params.run.chatType,
    MessageThreadId: params.replyRoute?.originatingThreadId ?? params.sessionCtx.MessageThreadId,
    ReplyToId: params.replyRoute?.originatingReplyToId ?? params.sessionCtx.ReplyToId,
  };
  return {
    sessionId: params.run.sessionId,
    sessionKey: params.run.sessionKey,
    sandboxSessionKey: params.run.runtimePolicySessionKey,
    agentId: params.run.agentId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: sessionCtx.OriginatingChannel,
      provider: sessionCtx.Provider,
    }),
    ...(sessionCtx.ChatType ? { chatType: sessionCtx.ChatType } : {}),
    agentAccountId: sessionCtx.AccountId,
    messageTo: resolveOriginMessageTo({
      originatingTo: sessionCtx.OriginatingTo,
      to: sessionCtx.To,
    }),
    messageThreadId: sessionCtx.MessageThreadId ?? undefined,
    chatId:
      normalizeOptionalString(sessionCtx.NativeChannelId) ??
      normalizeOptionalString(sessionCtx.ChatId),
    memberRoleIds: normalizeMemberRoleIds(sessionCtx.MemberRoleIds),
    // Provider threading context for tool auto-injection
    ...buildThreadingToolContext({
      sessionCtx,
      config,
      hasRepliedRef: params.hasRepliedRef,
    }),
    currentInboundAudio: hasInboundAudio(sessionCtx),
  };
}

function normalizeMemberRoleIds(value: TemplateContext["MemberRoleIds"]): string[] | undefined {
  const roles = Array.isArray(value)
    ? value
        .map((roleId) => normalizeOptionalString(roleId))
        .filter((roleId): roleId is string => Boolean(roleId))
    : [];
  return roles.length > 0 ? roles : undefined;
}

function buildTemplateSenderContext(sessionCtx: TemplateContext) {
  return {
    senderId: normalizeOptionalString(sessionCtx.SenderId),
    channelContext: sessionCtx.ChannelContext,
    senderName: normalizeOptionalString(sessionCtx.SenderName),
    senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
    senderE164: normalizeOptionalString(sessionCtx.SenderE164),
  };
}

/** Builds execution-specific embedded run params for queued reply dispatch. */
export function buildEmbeddedRunExecutionParams(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
  model: string;
  runId: string;
  promptCacheKey?: string;
  allowTransientCooldownProbe?: boolean;
}) {
  const authProfile = resolveRunAuthProfile(params.run, params.provider);
  const embeddedContext = buildEmbeddedContextFromTemplate({
    run: params.run,
    replyRoute: params.replyRoute,
    sessionCtx: params.sessionCtx,
    hasRepliedRef: params.hasRepliedRef,
  });
  const senderContext = buildTemplateSenderContext(params.sessionCtx);
  const runBaseParams = buildEmbeddedRunBaseParams({
    run: params.run,
    provider: params.provider,
    model: params.model,
    runId: params.runId,
    promptCacheKey: params.promptCacheKey,
    authProfile,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  });
  return {
    embeddedContext,
    senderContext,
    runBaseParams,
  };
}
