// Command status runtime helpers collect agent/session state for plugin command status output.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, resolveSessionAgentId } from "../agents/agent-scope.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { buildStatusReply } from "../auto-reply/reply/commands-status.js";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import { resolveDefaultModel } from "../auto-reply/reply/directive-handling.defaults.js";
import { resolveCurrentDirectiveLevels } from "../auto-reply/reply/directive-handling.levels.js";
import { createModelSelectionState } from "../auto-reply/reply/model-selection.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadSessionEntryReadOnly } from "../gateway/session-utils.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";

/** Inputs for rendering direct-session status replies outside the active channel turn. */
export type ResolveDirectStatusReplyForSessionParams = {
  /** Caller config used when the target session cannot load a config snapshot. */
  cfg: OpenClawConfig;
  /** Requested session key; whitespace-only keys produce no status reply. */
  sessionKey: string;
  /** Channel/surface name used when rendering the status command context. */
  channel: string;
  /** Optional sender id for command-context rendering and audit output. */
  senderId?: string;
  /** Whether the requester is an owner and may see owner-only session state. */
  senderIsOwner: boolean;
  /** Whether the requester passed channel allowlist/authorization checks. */
  isAuthorizedSender: boolean;
  /** Whether the status reply is being rendered for a group conversation. */
  isGroup: boolean;
  /** Channel default activation mode used by the status renderer for groups. */
  defaultGroupActivation: () => "always" | "mention";
};

/**
 * Builds a direct `/status` reply for an arbitrary session key.
 * Unauthorized requesters may see the session exists, but configured reasoning
 * state is masked so private agent/session defaults are not leaked.
 */
export async function resolveDirectStatusReplyForSession(
  params: ResolveDirectStatusReplyForSessionParams,
): Promise<ReplyPayload | undefined> {
  const requestedSessionKey = params.sessionKey.trim();
  if (!requestedSessionKey) {
    return undefined;
  }

  const statusLoaded = loadSessionEntryReadOnly(requestedSessionKey);
  const statusCfg = statusLoaded.cfg ?? params.cfg;
  const statusSessionKey = statusLoaded.canonicalKey;
  const statusEntry = statusLoaded.entry;
  const statusAgentId = resolveSessionAgentId({
    sessionKey: statusSessionKey,
    config: statusCfg,
  });
  const agentCfg = statusCfg.agents?.defaults;
  const agentEntry = listAgentEntries(statusCfg).find(
    (entry) => entry.id?.trim().toLowerCase() === statusAgentId,
  );
  const statusModel = resolveDefaultModelForAgent({
    cfg: statusCfg,
    agentId: statusAgentId,
  });
  const { defaultProvider, defaultModel } = resolveDefaultModel({
    cfg: statusCfg,
    agentId: statusAgentId,
  });
  // Native status returns before the ordinary reply pipeline reaches
  // channel-model routing, so resolve the effective channel model here before
  // preparing model-bound thinking, runtime, auth, context, and fast-mode facts.
  const canApplyChannelModel =
    statusCfg.channels?.modelByChannel != null &&
    !isModelSelectionLocked(statusEntry) &&
    !normalizeOptionalString(statusEntry?.modelOverride) &&
    !normalizeOptionalString(statusEntry?.providerOverride) &&
    statusModel.provider === defaultProvider &&
    statusModel.model === defaultModel;
  const deliveryChannel = normalizeMessageChannel(sessionDeliveryChannel(statusEntry));
  // Shared sessions can retain another channel's peer; never let that stale
  // identity outrank the authorized current command's live sender.
  const deliveryOrigin =
    deliveryChannel && deliveryChannel === normalizeMessageChannel(params.channel)
      ? sessionDeliveryOrigin(statusEntry)
      : undefined;
  const channelModelOverride = canApplyChannelModel
    ? resolveChannelModelOverride({
        cfg: statusCfg,
        channel: params.channel,
        groupId: statusEntry?.groupId,
        groupChatType: statusEntry?.chatType,
        groupChannel: statusEntry?.groupChannel,
        groupSubject: statusEntry?.subject,
        parentSessionKey: statusEntry?.parentSessionKey,
        directUserIds: [
          deliveryOrigin?.nativeDirectUserId,
          deliveryOrigin?.from,
          deliveryOrigin?.to,
          params.senderId,
        ],
      })
    : null;
  const resolvedChannelModel = channelModelOverride
    ? resolveModelRefFromString({
        cfg: statusCfg,
        raw: channelModelOverride.model,
        defaultProvider,
        aliasIndex: buildModelAliasIndex({
          cfg: statusCfg,
          agentId: statusAgentId,
          defaultProvider,
        }),
      })
    : null;
  const effectiveProvider = resolvedChannelModel?.ref.provider ?? statusModel.provider;
  const effectiveModel = resolvedChannelModel?.ref.model ?? statusModel.model;
  const selectedProvider =
    statusEntry?.providerOverride?.trim() ||
    statusEntry?.modelProvider?.trim() ||
    effectiveProvider;
  const selectedModel =
    statusEntry?.modelOverride?.trim() || statusEntry?.model?.trim() || effectiveModel;
  const modelState = await createModelSelectionState({
    cfg: statusCfg,
    agentId: statusAgentId,
    agentCfg,
    sessionEntry: statusEntry,
    sessionStore: statusLoaded.store,
    sessionKey: statusSessionKey,
    parentSessionKey: statusEntry?.parentSessionKey,
    storePath: statusLoaded.storePath,
    defaultProvider,
    defaultModel,
    provider: selectedProvider,
    model: selectedModel,
    hasModelDirective: false,
  });
  const {
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = await resolveCurrentDirectiveLevels({
    sessionEntry: statusEntry,
    agentEntry,
    agentCfg,
    resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
  });
  const thinkingCatalog = await modelState.resolveThinkingCatalog();
  let resolvedReasoningLevel = currentReasoningLevel;
  const hasAgentReasoningDefault =
    (agentEntry?.reasoningDefault !== undefined && agentEntry.reasoningDefault !== null) ||
    (agentCfg?.reasoningDefault !== undefined && agentCfg.reasoningDefault !== null);
  const sessionReasoningExplicitlySet =
    statusEntry?.reasoningLevel !== undefined && statusEntry.reasoningLevel !== null;
  const canUseReasoningState = params.senderIsOwner || params.isAuthorizedSender;
  if (!canUseReasoningState && (sessionReasoningExplicitlySet || hasAgentReasoningDefault)) {
    // Reasoning defaults can reveal agent/session configuration; unauthenticated
    // direct status callers get the conservative display value instead.
    resolvedReasoningLevel = "off";
  }
  const reasoningExplicitlySet = sessionReasoningExplicitlySet || hasAgentReasoningDefault;
  if (!reasoningExplicitlySet && resolvedReasoningLevel === "off" && currentThinkLevel === "off") {
    resolvedReasoningLevel = await modelState.resolveDefaultReasoningLevel();
  }

  const command: CommandContext = {
    surface: params.channel,
    channel: params.channel,
    ownerList: [],
    senderIsOwner: params.senderIsOwner,
    isAuthorizedSender: params.isAuthorizedSender,
    senderId: params.senderId,
    rawBodyNormalized: "/status",
    commandBodyNormalized: "/status",
  };

  return await buildStatusReply({
    cfg: statusCfg,
    command,
    sessionEntry: statusEntry,
    sessionKey: statusSessionKey,
    parentSessionKey: statusEntry?.parentSessionKey,
    sessionScope: statusCfg.session?.scope,
    storePath: statusLoaded.storePath,
    provider: selectedProvider,
    model: selectedModel,
    contextTokens: statusEntry?.contextTokens ?? 0,
    thinkingCatalog,
    resolvedThinkLevel: currentThinkLevel,
    resolvedFastMode: currentFastMode,
    resolvedVerboseLevel: currentVerboseLevel ?? "off",
    resolvedReasoningLevel,
    resolvedElevatedLevel: currentElevatedLevel,
    resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
    isGroup: params.isGroup,
    defaultGroupActivation: params.defaultGroupActivation,
  });
}
