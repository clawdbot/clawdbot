import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { readToolStringParam } from "../../agents/tools/common.js";
import { normalizeChatType, type ChatType } from "../../channels/chat-type.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import {
  prepareExternalMessageActionTargetForResolution,
  shouldDeferExternalMessageActionTargetResolution,
} from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelPlugin,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { resolveFirstBoundAccountId } from "../../routing/bound-account-read.js";
import { readTrimmedStringAlias } from "../../utils/string-readers.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import { validateExplicitMessageAccountSelection } from "./message-account-selection.js";
import type { MessageActionInput } from "./message-action-contracts.js";
import {
  normalizeMessageActionInput,
  resolveImplicitMessageActionTarget,
} from "./message-action-normalization.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";
import { actionRequiresTarget } from "./message-action-spec.js";
import { enforceCrossContextPolicy } from "./outbound-policy.js";
import {
  invalidMessageActionTargetError,
  missingMessageActionTargetError,
} from "./target-errors.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";

async function resolveChannel(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  toolContext?: { currentChannelProvider?: string },
  action?: ChannelMessageActionName,
  agentId?: string,
) {
  const channel = readToolStringParam(params, "channel");
  // Explicit reads must never switch to the source conversation when their
  // requested provider is unknown or unavailable.
  const fallbackChannel =
    action === "read" && channel ? undefined : toolContext?.currentChannelProvider;
  const selection = await resolveMessageChannelSelection({
    cfg,
    channel,
    fallbackChannel,
    agentId,
  });
  if (selection.source === "tool-context-fallback") {
    params.channel = selection.channel;
  }
  return selection;
}

function enforceCrossProviderEgressPolicyBeforeTargetResolution(params: {
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  cfg: OpenClawConfig;
  agentId?: string | null;
}): void {
  const currentProvider = params.toolContext?.currentChannelProvider;
  if (!currentProvider || currentProvider === params.channel) {
    return;
  }
  // Cross-context egress policy applies to direct and delegated callers alike;
  // direct origin bypasses only the conversation-read visibility gate. A
  // provider mismatch needs no target interpretation, so reject it before an
  // external resolver can perform provider I/O. Same-provider aliases still
  // wait for canonicalization before the full policy check below.
  enforceCrossContextPolicy(params);
}

function addCandidateAndUnprefixedAlias(candidates: Set<string>, value?: string | null) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return;
  }
  candidates.add(normalized);
  const unprefixed = normalized.replace(/^(channel|group|user):/i, "").trim();
  if (unprefixed && unprefixed !== normalized) {
    candidates.add(unprefixed);
  }
}

function normalizeTargetForAccountBinding(channel: ChannelId, target: string): string | undefined {
  try {
    return normalizeTargetForProvider(channel, target);
  } catch {
    return undefined;
  }
}

function inferPeerKindForAccountBinding(
  channel: ChannelId,
  target: string,
  channelPlugin?: ChannelPlugin,
): ChatType | undefined {
  const inferred = normalizeChatType(
    channelPlugin?.messaging?.inferTargetChatType?.({ to: target }),
  );
  if (inferred) {
    return inferred;
  }
  const normalized = normalizeTargetForAccountBinding(channel, target);
  const candidates = [target, normalized].filter((value): value is string => Boolean(value));
  if (candidates.some((value) => /^user:/i.test(value))) {
    return "direct";
  }
  if (candidates.some((value) => /^(channel|group):/i.test(value))) {
    return "channel";
  }
  return undefined;
}

function resolveTargetBoundAccountId(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  channelPlugin?: ChannelPlugin;
  args: Record<string, unknown>;
  agentId?: string;
}): string | undefined {
  if (!params.agentId) {
    return undefined;
  }
  const target =
    normalizeOptionalString(params.args.to) ?? normalizeOptionalString(params.args.channelId) ?? "";
  if (!target) {
    return resolveFirstBoundAccountId({
      cfg: params.cfg,
      channelId: params.channel,
      agentId: params.agentId,
    });
  }

  const candidates = new Set<string>();
  addCandidateAndUnprefixedAlias(candidates, target);
  addCandidateAndUnprefixedAlias(
    candidates,
    normalizeTargetForAccountBinding(params.channel, target),
  );
  const [peerId, ...exactPeerIdAliases] = Array.from(candidates);
  return resolveFirstBoundAccountId({
    cfg: params.cfg,
    channelId: params.channel,
    agentId: params.agentId,
    peerId,
    exactPeerIdAliases,
    peerKind: inferPeerKindForAccountBinding(params.channel, target, params.channelPlugin),
  });
}

async function resolveActionTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
  plugin?: ChannelPlugin;
}): Promise<ResolvedMessagingTarget | undefined> {
  let resolvedTarget: ResolvedMessagingTarget | undefined;
  const toRaw = normalizeOptionalString(params.args.to) ?? "";
  if (toRaw) {
    const resolved = await resolveResolvedTargetOrThrow({
      cfg: params.cfg,
      channel: params.channel,
      input: toRaw,
      accountId: params.accountId ?? undefined,
      plugin: params.plugin,
    });
    params.args.to = resolved.to;
    resolvedTarget = resolved;
  }
  const channelIdRaw = normalizeOptionalString(params.args.channelId) ?? "";
  if (channelIdRaw) {
    const resolved = await resolveResolvedTargetOrThrow({
      cfg: params.cfg,
      channel: params.channel,
      input: channelIdRaw,
      accountId: params.accountId ?? undefined,
      plugin: params.plugin,
      preferredKind: "group",
      validateResolvedTarget: (target) =>
        target.kind === "user"
          ? `Channel id "${channelIdRaw}" resolved to a user target.`
          : undefined,
    });
    params.args.channelId = sanitizeGroupTargetId(resolved.to);
  }
  return resolvedTarget;
}

function sanitizeGroupTargetId(target: string): string {
  return target.replace(/^(channel|group):/i, "");
}

async function resolveResolvedTargetOrThrow(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string;
  plugin?: ChannelPlugin;
  preferredKind?: "group" | "user" | "channel";
  validateResolvedTarget?: (target: ResolvedMessagingTarget) => string | undefined;
}): Promise<ResolvedMessagingTarget> {
  const resolved = await resolveChannelTarget({
    cfg: params.cfg,
    channel: params.channel,
    input: params.input,
    accountId: params.accountId,
    preferredKind: params.preferredKind,
    plugin: params.plugin,
  });
  if (!resolved.ok) {
    throw resolved.error;
  }
  const validationError = params.validateResolvedTarget?.(resolved.target);
  if (validationError) {
    throw invalidMessageActionTargetError(validationError);
  }
  return resolved.target;
}

function hasExplicitSingularTargetParam(params: Record<string, unknown>): boolean {
  return readTrimmedStringAlias(params, ["target", "to", "channelId"]) !== undefined;
}

function hasExplicitTargetParam(params: Record<string, unknown>): boolean {
  return (
    hasExplicitSingularTargetParam(params) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => normalizeOptionalString(value)))
  );
}

function hasPotentialActionTargetInput(
  input: MessageActionInput,
  params: Record<string, unknown>,
): boolean {
  return Boolean(
    hasExplicitSingularTargetParam(params) ||
    resolveImplicitMessageActionTarget(input.toolContext) ||
    hasPotentialPluginActionParam(params),
  );
}

function isCurrentSourceTargetParam(
  input: MessageActionInput,
  params: Record<string, unknown>,
): boolean {
  const currentChannelId = normalizeOptionalString(input.toolContext?.currentChannelId);
  const currentMessagingTarget = normalizeOptionalString(input.toolContext?.currentMessagingTarget);
  if (!currentChannelId && !currentMessagingTarget) {
    return false;
  }
  const currentChannelProvider = normalizeOptionalLowercaseString(
    input.toolContext?.currentChannelProvider,
  );
  const explicitChannel = normalizeOptionalLowercaseString(params.channel);
  if (explicitChannel && currentChannelProvider && explicitChannel !== currentChannelProvider) {
    return false;
  }

  const explicitTarget =
    normalizeOptionalString(params.target) ??
    normalizeOptionalString(params.to) ??
    normalizeOptionalString(params.channelId);
  if (!explicitTarget) {
    return false;
  }

  const provider = explicitChannel ?? currentChannelProvider;
  const currentCandidates = new Set<string>();
  for (const currentTarget of [currentMessagingTarget, currentChannelId]) {
    if (!currentTarget) {
      continue;
    }
    addCandidateAndUnprefixedAlias(currentCandidates, currentTarget);
    if (provider) {
      addCandidateAndUnprefixedAlias(
        currentCandidates,
        normalizeTargetForAccountBinding(provider, currentTarget),
      );
    }
  }

  const explicitCandidates = new Set<string>();
  addCandidateAndUnprefixedAlias(explicitCandidates, explicitTarget);
  if (provider) {
    addCandidateAndUnprefixedAlias(
      explicitCandidates,
      normalizeTargetForAccountBinding(provider, explicitTarget),
    );
  }
  return Array.from(explicitCandidates).some((candidate) => currentCandidates.has(candidate));
}

function hasExplicitNonCurrentChannelParam(
  input: MessageActionInput,
  params: Record<string, unknown>,
): boolean {
  const explicitChannel = normalizeOptionalLowercaseString(params.channel);
  if (!explicitChannel) {
    return false;
  }
  const currentChannelProvider = normalizeOptionalLowercaseString(
    input.toolContext?.currentChannelProvider,
  );
  return !currentChannelProvider || explicitChannel !== currentChannelProvider;
}

function applyImplicitSourceReplySendPolicy(
  input: MessageActionInput,
  params: Record<string, unknown>,
) {
  if (input.action !== "send" || input.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  if (hasExplicitNonCurrentChannelParam(input, params)) {
    return;
  }
  if (hasExplicitTargetParam(params) && !isCurrentSourceTargetParam(input, params)) {
    return;
  }
  params.bestEffort = true;
}

type PreparedMessageRoute = {
  params: Record<string, unknown>;
  channel: ChannelId;
  channelPlugin: ChannelPlugin;
  accountId?: string | null;
  dryRun: boolean;
  defersExternalTargetResolution: boolean;
};

export async function prepareMessageRoute(params: {
  input: MessageActionInput;
  actionParams: Record<string, unknown>;
  agentId?: string;
}): Promise<PreparedMessageRoute> {
  const { input, agentId } = params;
  const cfg = input.cfg;
  const action = input.action;
  let actionParams = params.actionParams;

  applyImplicitSourceReplySendPolicy(input, actionParams);
  // Missing targets must fail before channel discovery, which can bootstrap or
  // probe configured plugins. Non-standard params may still be owner aliases.
  if (actionRequiresTarget(action) && !hasPotentialActionTargetInput(input, actionParams)) {
    throw missingMessageActionTargetError(action);
  }

  const selection = await resolveChannel(cfg, actionParams, input.toolContext, action, agentId);
  const { channel, plugin: channelPlugin } = selection;
  actionParams.channel = channel;
  const explicitAccountId = validateExplicitMessageAccountSelection({
    cfg,
    channel,
    accountId: readToolStringParam(actionParams, "accountId"),
    plugin: channelPlugin,
  });
  const pluginOwnedAction = action !== "send" && action !== "poll";
  if (
    pluginOwnedAction &&
    channelPlugin?.actions?.supportsAction &&
    !channelPlugin.actions.supportsAction({ action })
  ) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  actionParams = normalizeMessageActionInput({
    action,
    args: actionParams,
    toolContext: input.toolContext,
    targetAliasSpec: channelPlugin?.actions?.messageActionTargetAliases?.[action],
    // Trusted direct operators retain opaque resource-id workflows. Native conversation
    // aliases still normalize above and remain subject to the shared cross-context policy.
    allowResourceOnly: input.conversationReadOrigin === "direct-operator",
  });
  let accountId = explicitAccountId ?? input.defaultAccountId;
  if (!accountId && agentId) {
    accountId = resolveTargetBoundAccountId({
      cfg,
      channel,
      channelPlugin,
      args: actionParams,
      agentId,
    });
  }
  const delegatesActionToGateway =
    Boolean(input.gateway) &&
    channelPlugin?.actions?.resolveExecutionMode?.({ action }) === "gateway";
  // Resolve once for locally owned sends so formatting and delivery share an
  // identity. Remote calls must retain omitted input for the Gateway to resolve.
  if (
    !accountId &&
    action === "send" &&
    !delegatesActionToGateway &&
    (channelPlugin.outbound?.deliveryMode !== "gateway" || input.gatewayOwnedDelivery === true)
  ) {
    accountId = resolveChannelDefaultAccountId({ plugin: channelPlugin, cfg });
  }
  if (accountId) {
    actionParams.accountId = accountId;
  }
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(actionParams, "dryRun"));
  enforceCrossProviderEgressPolicyBeforeTargetResolution({
    channel,
    action,
    args: actionParams,
    toolContext: input.toolContext,
    cfg,
    agentId,
  });
  const defersExternalTargetResolution =
    delegatesActionToGateway &&
    !dryRun &&
    shouldDeferExternalMessageActionTargetResolution({
      channel,
      action,
      cfg,
      params: actionParams,
      accountId: accountId ?? undefined,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
    });
  if (!delegatesActionToGateway || dryRun) {
    const authorization = input.messageActionAuthorization;
    actionParams = prepareExternalMessageActionTargetForResolution({
      channel,
      action,
      cfg,
      params: actionParams,
      accountId: accountId ?? undefined,
      requesterAccountId:
        authorization !== undefined
          ? authorization.requesterAccountId
          : (input.requesterAccountId ?? undefined),
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        input.conversationReadOrigin,
      ),
      toolContext: authorization !== undefined ? authorization.toolContext : input.toolContext,
    });
  }

  return {
    params: actionParams,
    channel,
    channelPlugin,
    accountId,
    dryRun,
    defersExternalTargetResolution,
  };
}

export async function resolveMessageTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
  toolContext?: ChannelThreadingToolContext;
  agentId?: string | null;
  deferExternalTargetResolution?: boolean;
  plugin?: ChannelPlugin;
}): Promise<ResolvedMessagingTarget | undefined> {
  const resolvedTarget = params.deferExternalTargetResolution
    ? undefined
    : await resolveActionTarget({
        cfg: params.cfg,
        channel: params.channel,
        action: params.action,
        args: params.args,
        accountId: params.accountId,
        plugin: params.plugin,
      });

  enforceCrossContextPolicy({
    channel: params.channel,
    action: params.action,
    args: params.args,
    toolContext: params.toolContext,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return resolvedTarget;
}
