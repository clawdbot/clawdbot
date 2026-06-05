/**
 * Builds runtime context for context-engine backed embedded compaction.
 */
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  listActiveProcessSessionReferences,
  type ActiveProcessSessionReference,
} from "../bash-process-references.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import {
  openAIProviderUsesCodexRuntimeByDefault,
  resolveSelectedOpenAIRuntimeProvider,
} from "../openai-routing.js";

export type EmbeddedCompactionRuntimeContext = {
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  authProfileId?: string;
  agentHarnessId?: string;
  workspaceDir: string;
  cwd?: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string;
  provider?: string;
  runtimeProvider?: string;
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
  harnessRuntime?: string | null;
  defaultProvider?: string;
  defaultModel?: string;
}): {
  provider: string | undefined;
  runtimeProvider?: string;
  contextProvider?: string;
  model: string | undefined;
  authProfileId: string | undefined;
} {
  const provider = params.provider?.trim() || params.defaultProvider;
  const model = params.modelId?.trim() || params.defaultModel;
  const override = params.config?.agents?.defaults?.compaction?.model?.trim();
  const resolveTargetProviders = (
    targetProvider: string | undefined,
    authProfileId: string | undefined,
  ) => {
    if (!targetProvider) {
      return {};
    }
    const useCodexHarnessRuntime = shouldUseCodexRuntimeProviderForCompaction({
      config: params.config,
      provider: targetProvider,
      harnessRuntime: params.harnessRuntime,
    });
    const harnessRuntime = useCodexHarnessRuntime ? params.harnessRuntime : "openclaw";
    const runtimeProvider = resolveSelectedOpenAIRuntimeProvider({
      provider: targetProvider,
      harnessRuntime: harnessRuntime ?? undefined,
      authProfileId,
      config: params.config,
    });
    const routedRuntimeProvider = runtimeProvider === targetProvider ? undefined : runtimeProvider;
    return {
      runtimeProvider: routedRuntimeProvider,
      contextProvider: useCodexHarnessRuntime ? routedRuntimeProvider : undefined,
    };
  };
  if (!override) {
    const authProfileId = params.authProfileId ?? undefined;
    return {
      provider,
      ...resolveTargetProviders(provider, authProfileId),
      model,
      authProfileId,
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
    return {
      provider: overrideProvider,
      ...resolveTargetProviders(overrideProvider, authProfileId),
      model: overrideModel,
      authProfileId,
    };
  }
  const authProfileId = params.authProfileId ?? undefined;
  return {
    provider,
    ...resolveTargetProviders(provider, authProfileId),
    model: override,
    authProfileId,
  };
}

function shouldUseCodexRuntimeProviderForCompaction(params: {
  config?: OpenClawConfig;
  provider: string;
  harnessRuntime?: string | null;
}): boolean {
  if (normalizeOptionalAgentRuntimeId(params.harnessRuntime) !== "codex") {
    return false;
  }
  if (!openAIProviderUsesCodexRuntimeByDefault(params)) {
    return false;
  }
  return true;
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
  cwd?: string | null;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  harnessRuntime?: string | null;
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
    harnessRuntime: params.harnessRuntime,
  });
  const agentHarnessId = params.harnessRuntime?.trim() || undefined;
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
    agentHarnessId,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd ?? undefined,
    agentDir: params.agentDir,
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    runtimeProvider: resolved.runtimeProvider,
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
