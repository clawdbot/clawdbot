import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listActiveProcessSessionReferences,
  type ActiveProcessSessionReference,
} from "../bash-process-references.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { SkillSnapshot } from "../skills.js";

export type EmbeddedCompactionRuntimeContext = {
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  authProfileId?: string;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string;
  provider?: string;
  model?: string;
  modelFallbacksOverride?: string[];
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  ownerNumbers?: string[];
  activeProcessSessions?: ActiveProcessSessionReference[];
};

/**
 * Resolve the effective compaction target from config, falling back to the
 * caller-supplied provider/model and optionally applying runtime defaults.
 */
export function resolveEmbeddedCompactionTarget(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
  defaultProvider?: string;
  defaultModel?: string;
}): { provider: string | undefined; model: string | undefined; authProfileId: string | undefined } {
  const provider = params.provider?.trim() || params.defaultProvider;
  const model = params.modelId?.trim() || params.defaultModel;
  const override = params.config?.agents?.defaults?.compaction?.model?.trim();
  if (!override) {
    return {
      provider,
      model,
      authProfileId: params.authProfileId ?? undefined,
    };
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim() || params.defaultModel;
    // When switching provider via override, drop the primary auth profile to
    // avoid sending the wrong credentials.
    const authProfileId =
      overrideProvider !== (params.provider ?? "")?.trim()
        ? undefined
        : (params.authProfileId ?? undefined);
    return { provider: overrideProvider, model: overrideModel, authProfileId };
  }
  return {
    provider,
    model: override,
    authProfileId: params.authProfileId ?? undefined,
  };
}

export function buildEmbeddedCompactionRuntimeContext(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  modelFallbacksOverride?: string[];
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  ownerNumbers?: string[];
  activeProcessSessions?: ActiveProcessSessionReference[];
}): EmbeddedCompactionRuntimeContext {
  const resolved = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
  });
  const processScopeKey = params.sessionKey?.trim();
  const activeProcessSessions =
    params.activeProcessSessions ??
    listActiveProcessSessionReferences({
      scopeKey: processScopeKey,
    });
  return {
    sessionKey: params.sessionKey ?? undefined,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    agentAccountId: params.agentAccountId ?? undefined,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    authProfileId: resolved.authProfileId,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    model: resolved.model,
    modelFallbacksOverride: params.modelFallbacksOverride,
    thinkLevel: params.thinkLevel,
    reasoningLevel: params.reasoningLevel,
    bashElevated: params.bashElevated,
    extraSystemPrompt: params.extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    ownerNumbers: params.ownerNumbers,
    ...(activeProcessSessions.length > 0 ? { activeProcessSessions } : {}),
  };
}
