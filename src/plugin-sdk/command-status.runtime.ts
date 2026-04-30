import { listAgentEntries, resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { buildStatusReply } from "../auto-reply/reply/commands-status.js";
import type { CommandContext } from "../auto-reply/reply/commands-types.js";
import { resolveDefaultModel } from "../auto-reply/reply/directive-handling.defaults.js";
import { resolveCurrentDirectiveLevels } from "../auto-reply/reply/directive-handling.levels.js";
import { createModelSelectionState } from "../auto-reply/reply/model-selection.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadSessionEntry } from "../gateway/session-utils.js";

export type ResolveDirectStatusReplyForSessionParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  channel: string;
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
};

export async function resolveDirectStatusReplyForSession(
  params: ResolveDirectStatusReplyForSessionParams,
): Promise<ReplyPayload | undefined> {
  const requestedSessionKey = params.sessionKey.trim();
  if (!requestedSessionKey) {
    return undefined;
  }

  const statusLoaded = loadSessionEntry(requestedSessionKey);
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
  const selectedProvider =
    statusEntry?.providerOverride?.trim() ||
    statusEntry?.modelProvider?.trim() ||
    statusModel.provider;
  const selectedModel =
    statusEntry?.modelOverride?.trim() || statusEntry?.model?.trim() || statusModel.model;
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
  let resolvedReasoningLevel = currentReasoningLevel;
  const hasAgentReasoningDefault =
    (agentEntry?.reasoningDefault !== undefined && agentEntry.reasoningDefault !== null) ||
    (agentCfg?.reasoningDefault !== undefined && agentCfg.reasoningDefault !== null);
  const sessionReasoningExplicitlySet =
    statusEntry?.reasoningLevel !== undefined && statusEntry.reasoningLevel !== null;
  const canUseReasoningState = params.senderIsOwner || params.isAuthorizedSender;
  if (!canUseReasoningState && (sessionReasoningExplicitlySet || hasAgentReasoningDefault)) {
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
