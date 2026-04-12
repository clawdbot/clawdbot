import { resolveRunModelFallbacksOverride } from "../../agents/agent-scope.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getAgentRuntimeCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { getRuntimeConfigSnapshot, type OpenClawConfig } from "../../config/config.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import type { TemplateContext } from "../templating.js";
import {
  resolveProviderScopedAuthProfile,
  resolveRunAuthProfile,
} from "./agent-runner-auth-profile.js";
export { resolveProviderScopedAuthProfile, resolveRunAuthProfile };
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;

export function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig {
  return (
    (typeof getRuntimeConfigSnapshot === "function" ? getRuntimeConfigSnapshot() : null) ?? config
  );
}

export async function resolveQueuedReplyExecutionConfig(
  config: OpenClawConfig,
): Promise<OpenClawConfig> {
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(config);
  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    config: runtimeConfig,
    commandName: "reply",
    targetIds: getAgentRuntimeCommandSecretTargetIds(),
  });
  return resolvedConfig ?? runtimeConfig;
}

/**
 * Build provider-specific threading context for tool auto-injection.
 */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: OpenClawConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): ChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
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
    };
  }
  const rawProvider = normalizeOptionalLowercaseString(originProvider);
  if (!rawProvider) {
    return {
      currentMessageId,
    };
  }
  const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., BlueBubbles before plugin registry init)
  const threading = provider ? getChannelPlugin(provider)?.threading : undefined;
  if (!threading?.buildToolContext) {
    return {
      currentChannelId: normalizeOptionalString(originTo),
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
      currentMessageId,
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
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
        MessageThreadId: sessionCtx.MessageThreadId,
        NativeChannelId: sessionCtx.NativeChannelId,
      },
      hasRepliedRef,
    }) ?? {};
  return {
    ...context,
    currentChannelProvider: provider!, // guaranteed non-null since threading exists
    currentMessageId: context.currentMessageId ?? currentMessageId,
  };
}

export const isBunFetchSocketError = (message?: string) =>
  message ? BUN_FETCH_SOCKET_ERROR_RE.test(message) : false;

export const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

export const resolveEnforceFinalTag = (
  run: FollowupRun["run"],
  provider: string,
  model = run.model,
) =>
  (run.skipProviderRuntimeHints ? false : undefined) ??
  (run.enforceFinalTag ||
    isReasoningTagProvider(provider, {
      config: run.config,
      workspaceDir: run.workspaceDir,
      modelId: model,
    }));

export function resolveModelFallbackOptions(run: FollowupRun["run"]) {
  const config = run.config;
  return {
    cfg: config,
    provider: run.provider,
    model: run.model,
    agentDir: run.agentDir,
    fallbacksOverride: resolveRunModelFallbacksOverride({
      cfg: config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
    }),
  };
}

export function buildEmbeddedRunBaseParams(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  runId: string;
  authProfile: ReturnType<typeof resolveProviderScopedAuthProfile>;
  allowTransientCooldownProbe?: boolean;
}) {
  const config = params.run.config;
  return {
    sessionFile: params.run.sessionFile,
    workspaceDir: params.run.workspaceDir,
    agentDir: params.run.agentDir,
    config,
    skillsSnapshot: params.run.skillsSnapshot,
    ownerNumbers: params.run.ownerNumbers,
    inputProvenance: params.run.inputProvenance,
    senderIsOwner: params.run.senderIsOwner,
    enforceFinalTag: resolveEnforceFinalTag(params.run, params.provider, params.model),
    silentExpected: params.run.silentExpected,
    provider: params.provider,
    model: params.model,
    ...params.authProfile,
    thinkLevel: params.run.thinkLevel,
    verboseLevel: params.run.verboseLevel,
    reasoningLevel: params.run.reasoningLevel,
    execOverrides: params.run.execOverrides,
    bashElevated: params.run.bashElevated,
    timeoutMs: params.run.timeoutMs,
    runId: params.runId,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  };
}

export function buildEmbeddedContextFromTemplate(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}) {
  const config = params.run.config;
  return {
    sessionId: params.run.sessionId,
    sessionKey: params.run.sessionKey,
    agentId: params.run.agentId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.sessionCtx.OriginatingChannel,
      provider: params.sessionCtx.Provider,
    }),
    agentAccountId: params.sessionCtx.AccountId,
    messageTo: resolveOriginMessageTo({
      originatingTo: params.sessionCtx.OriginatingTo,
      to: params.sessionCtx.To,
    }),
    messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
    // Provider threading context for tool auto-injection
    ...buildThreadingToolContext({
      sessionCtx: params.sessionCtx,
      config,
      hasRepliedRef: params.hasRepliedRef,
    }),
  };
}

export function buildTemplateSenderContext(sessionCtx: TemplateContext) {
  return {
    senderId: normalizeOptionalString(sessionCtx.SenderId),
    senderName: normalizeOptionalString(sessionCtx.SenderName),
    senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
    senderE164: normalizeOptionalString(sessionCtx.SenderE164),
  };
}

export function buildEmbeddedRunContexts(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
}) {
  return {
    authProfile: resolveRunAuthProfile(params.run, params.provider),
    embeddedContext: buildEmbeddedContextFromTemplate({
      run: params.run,
      sessionCtx: params.sessionCtx,
      hasRepliedRef: params.hasRepliedRef,
    }),
    senderContext: buildTemplateSenderContext(params.sessionCtx),
  };
}

export function buildEmbeddedRunExecutionParams(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
  model: string;
  runId: string;
  allowTransientCooldownProbe?: boolean;
}) {
  const { authProfile, embeddedContext, senderContext } = buildEmbeddedRunContexts(params);
  const runBaseParams = buildEmbeddedRunBaseParams({
    run: params.run,
    provider: params.provider,
    model: params.model,
    runId: params.runId,
    authProfile,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  });
  return {
    embeddedContext,
    senderContext,
    runBaseParams,
  };
}
