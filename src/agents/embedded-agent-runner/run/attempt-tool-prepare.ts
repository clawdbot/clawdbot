/**
 * Plans and prepares the core tool surface for one embedded attempt.
 * It may assume workspace, model, and runtime policy inputs are resolved.
 */
import { messageToolOwnsVisibleReply } from "../../../auto-reply/source-reply-delivery-mode.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { extractModelCompat } from "../../../plugins/provider-model-compat.js";
import { getPluginToolMeta } from "../../../plugins/tools.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import { createOpenClawCodingTools } from "../../agent-tools.js";
import { getChannelAgentToolMeta } from "../../channel-tools.js";
import type { CodeModeSkill } from "../../code-mode-skills.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import {
  type CoreToolFactoryFamily,
  type OpenClawCodingToolConstructionPlan,
  resolveCoreToolFactoryFamily,
} from "../../core-tool-factory-descriptors.js";
import {
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
} from "../../local-model-lean.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { supportsModelTools } from "../../model-tool-support.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { isToolAllowedByPolicyName } from "../../tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandToolGroups,
  normalizeToolList,
  normalizeToolName,
  readToolAllowlistIntersection,
} from "../../tool-policy.js";
import { isAgentToolRestartSafe } from "../../tool-replay-safety.js";
import {
  createToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
  type ToolSearchTargetTranscriptProjection,
} from "../../tool-search.js";
import { resolveAgentToolSurfacePlan } from "../../tool-surface-plan.js";
import type { ComputerContextEpoch } from "../../tools/computer-tool.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../../tools/cron-tool.js";
import { log } from "../logger.js";
import {
  buildEmbeddedAttemptToolRunContext,
  TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES,
} from "./attempt-tool-catalog.js";
import { resolveAttemptToolPolicyMessageProvider } from "./attempt.run-decisions.js";
import { resolveAttemptSpawnWorkspaceDir } from "./attempt.thread-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type OpenClawCodingToolsOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
type SkillUsagePaths = OpenClawCodingToolsOptions["skillUsagePaths"];

export function prepareEmbeddedAttemptToolBase(params: {
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  effectiveCwd: string;
  effectiveWorkspace: string;
  markCoreToolStage: (name: string) => void;
  onYield: NonNullable<OpenClawCodingToolsOptions["onYield"]>;
  resolvedWorkspace: string;
  runAbortController: AbortController;
  runTrace: DiagnosticTraceContext;
  sandbox?: SandboxContext | null;
  sandboxSessionKey: string;
  sessionAgentId: string;
  skillUsagePaths: SkillUsagePaths;
  skillsSnapshot: EmbeddedRunAttemptParams["skillsSnapshot"];
  codeModeSkills: readonly CodeModeSkill[];
  toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor;
}) {
  const { attempt } = params;
  const forceDirectMessageTool = messageToolOwnsVisibleReply(attempt);
  const toolsAllowWithForcedRuntimeTools = mergeForcedEmbeddedAttemptToolsAllow(
    attempt.toolsAllow,
    {
      forceMessageTool: forceDirectMessageTool,
      forceToolNames:
        attempt.swarmCollector && attempt.swarmOutputSchema ? ["structured_output"] : undefined,
    },
  );
  const toolsEnabled = supportsModelTools(attempt.model);
  const isRawModelRun = attempt.modelRun === true || attempt.promptMode === "none";
  const toolConstructionPlan = resolveEmbeddedAttemptToolConstructionPlan({
    disableTools: attempt.disableTools,
    isRawModelRun,
    toolsEnabled,
    toolsAllow: toolsAllowWithForcedRuntimeTools,
  });
  const {
    codeModeControlsEnabled: codeModeControlsEnabledForRun,
    toolSearchConfig,
    toolSearchControlsEnabled: toolSearchControlsEnabledForRun,
    toolSearchRuntimeConfig,
  } = resolveAgentToolSurfacePlan({
    config: attempt.config,
    agentId: params.sessionAgentId,
    sessionKey: params.sandboxSessionKey,
    forceDirectMessageTool,
    model: attempt.model,
    toolsEnabled,
    disableTools: attempt.disableTools,
    isRawModelRun,
    skillWorkshopProposalOnly: attempt.skillWorkshopProposalOnly,
    toolsAllow: attempt.toolsAllow,
    forceCodeModeControls: attempt.forceCodeModeTools,
  });
  const effectiveToolsAllow =
    toolSearchControlsEnabledForRun && toolsAllowWithForcedRuntimeTools
      ? [...new Set([...toolsAllowWithForcedRuntimeTools, ...TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES])]
      : toolsAllowWithForcedRuntimeTools;
  const shouldConstructTools =
    toolConstructionPlan.constructTools ||
    toolSearchControlsEnabledForRun ||
    codeModeControlsEnabledForRun;
  // Compaction summaries omit screenshot image blocks. Frames are bound to this
  // generation so retained tool-result text cannot authorize stale coordinates.
  const computerContextEpoch: ComputerContextEpoch = { value: 0 };
  const toolSearchCatalogRef =
    toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun
      ? createToolSearchCatalogRef()
      : undefined;
  const toolSearchTargetTranscriptProjections: ToolSearchTargetTranscriptProjection[] = [];
  const codeModeSkills = attempt.toolsAllow?.length ? [] : params.codeModeSkills;
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
  const cronCreatorToolAllowlistCaptureRef: CronToolsAllowCaptureRef = {};
  const inheritedToolAllowlist: string[] = [];
  const spawnWorkspaceDir =
    params.effectiveCwd !== params.effectiveWorkspace
      ? params.resolvedWorkspace
      : resolveAttemptSpawnWorkspaceDir({
          sandbox: params.sandbox,
          resolvedWorkspace: params.resolvedWorkspace,
        });
  const runtimeCapabilityProfile = resolveConversationCapabilityProfile({
    config: toolSearchRuntimeConfig,
    sessionKey: params.sandboxSessionKey,
    runSessionKey:
      attempt.sessionKey && attempt.sessionKey !== params.sandboxSessionKey
        ? attempt.sessionKey
        : undefined,
    sessionId: attempt.sessionId,
    runId: attempt.runId,
    agentId: params.sessionAgentId,
    agentDir: params.agentDir,
    agentAccountId: attempt.agentAccountId,
    messageProvider: resolveAttemptToolPolicyMessageProvider(attempt),
    messageChannel: attempt.messageChannel,
    chatType: attempt.chatType,
    messageTo: attempt.messageTo,
    messageThreadId: attempt.messageThreadId,
    conversationToolPolicy: attempt.conversationToolPolicy,
    currentChannelId: attempt.currentChannelId,
    currentMessagingTarget: attempt.currentMessagingTarget,
    currentThreadTs: attempt.currentThreadTs,
    currentMessageId: attempt.currentMessageId,
    groupId: attempt.groupId,
    groupChannel: attempt.groupChannel,
    groupSpace: attempt.groupSpace,
    memberRoleIds: attempt.memberRoleIds,
    spawnedBy: attempt.spawnedBy,
    senderId: attempt.senderId,
    senderName: attempt.senderName,
    senderUsername: attempt.senderUsername,
    senderE164: attempt.senderE164,
    senderIsOwner: attempt.senderIsOwner,
    modelProvider: attempt.provider,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    modelContextWindowTokens: attempt.model.contextWindow,
    modelHasVision: attempt.model.input?.includes("image") ?? false,
    workspaceDir: params.effectiveWorkspace,
    cwd: params.effectiveCwd,
    spawnWorkspaceDir,
    isCanonicalWorkspace: attempt.isCanonicalWorkspace,
    promptMode: attempt.promptMode,
    skillsSnapshot: params.skillsSnapshot,
    sandboxToolPolicy: params.sandbox?.tools,
    runtimeToolAllowlist: effectiveToolsAllow,
    inheritRuntimeToolAllowlist: true,
    runtimePluginToolGrant: attempt.runtimePluginToolGrant,
    inputProvenance: attempt.inputProvenance,
    trustedInternalHandoff: attempt.trustedInternalHandoff,
    scheduledToolPolicy: attempt.scheduledToolPolicy,
  });
  const localModelLeanEnabled = isLocalModelLeanEnabled({
    config: attempt.config,
    agentId: params.sessionAgentId,
    sessionKey: attempt.sessionKey,
  });
  const localModelLeanPreserveToolNames = resolveLocalModelLeanPreserveToolNames({
    toolNames: runtimeCapabilityProfile.policy.explicitToolOverrideAllowlist,
    forceMessageTool: attempt.forceMessageTool,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
  });
  const replaySafetyOptions = {
    declaredReplaySafe: (candidate: { name?: string }) => {
      const pluginMeta = getPluginToolMeta(candidate as Parameters<typeof getPluginToolMeta>[0]);
      if (pluginMeta) {
        return pluginMeta.replaySafe === true;
      }
      return getChannelAgentToolMeta(candidate as never) ? false : undefined;
    },
  };
  const restartSafetyOptions = {
    declaredReplaySafe: (candidate: { name?: string }) => {
      const pluginMeta = getPluginToolMeta(candidate as Parameters<typeof getPluginToolMeta>[0]);
      if (pluginMeta?.mcp) {
        return false;
      }
      return replaySafetyOptions.declaredReplaySafe(candidate);
    },
  };
  const constructedToolsRaw = !shouldConstructTools
    ? []
    : (() => {
        const allTools = createOpenClawCodingTools({
          agentId: params.sessionAgentId,
          ...buildEmbeddedAttemptToolRunContext({ ...attempt, trace: params.runTrace }),
          messageChannel: attempt.messageChannel,
          clientCaps: attempt.clientCaps,
          toolBindings: attempt.toolBindings,
          chatType: attempt.chatType,
          exec: {
            ...attempt.execOverrides,
            config: attempt.config,
            elevated: attempt.bashElevated,
          },
          sandbox: params.sandbox,
          messageProvider: resolveAttemptToolPolicyMessageProvider(attempt),
          agentAccountId: attempt.agentAccountId,
          messageTo: attempt.messageTo,
          messageThreadId: attempt.messageThreadId,
          nativeChannelId: attempt.chatId,
          messageActionTurnCapability: attempt.messageActionTurnCapability,
          groupId: attempt.groupId,
          groupChannel: attempt.groupChannel,
          groupSpace: attempt.groupSpace,
          memberRoleIds: attempt.memberRoleIds,
          spawnedBy: attempt.spawnedBy,
          senderId: attempt.senderId,
          channelContext: attempt.channelContext,
          senderName: attempt.senderName,
          senderUsername: attempt.senderUsername,
          senderE164: attempt.senderE164,
          senderIsOwner: attempt.senderIsOwner,
          allowGatewaySubagentBinding: attempt.allowGatewaySubagentBinding,
          sessionKey: params.sandboxSessionKey,
          runSessionKey:
            attempt.sessionKey && attempt.sessionKey !== params.sandboxSessionKey
              ? attempt.sessionKey
              : undefined,
          sessionId: attempt.sessionId,
          runId: attempt.runId,
          conversationRecall: attempt.conversationRecall,
          approvalReviewerDeviceId: attempt.approvalReviewerDeviceId,
          oneShotCliRun: attempt.oneShotCliRun,
          toolSearchCatalogRef,
          agentDir: params.agentDir,
          preparedModelRuntime: attempt.preparedModelRuntime,
          cwd: params.effectiveCwd,
          workspaceDir: params.effectiveWorkspace,
          spawnWorkspaceDir,
          config: toolSearchRuntimeConfig,
          webSearchEnabled: attempt.toolOverrides?.webSearch !== false,
          abortSignal: params.runAbortController.signal,
          modelProvider: attempt.provider,
          modelId: attempt.modelId,
          skillWorkshop: {
            env: attempt.skillWorkshopProposalEnv,
            proposalOnly: attempt.skillWorkshopProposalOnly,
            ...(attempt.skillWorkshopUpdateProposals ? { updateProposals: true } : {}),
            ...(attempt.skillWorkshopAutonomousCapture ? { autonomousCapture: true } : {}),
            origin: attempt.skillWorkshopOrigin,
            proposalMutationBudget: attempt.skillWorkshopProposalMutationBudget,
            proposalReviewCompletion: attempt.skillWorkshopProposalReviewCompletion,
          },
          modelCompat: extractModelCompat(attempt.model),
          modelApi: attempt.model.api,
          modelContextWindowTokens: attempt.model.contextWindow,
          delegationCapability: attempt.delegationCapability,
          modelAuthMode: resolveModelAuthMode(attempt.model.provider, attempt.config, undefined, {
            workspaceDir: params.effectiveWorkspace,
          }),
          currentChannelId: attempt.currentChannelId,
          currentMessagingTarget: attempt.currentMessagingTarget,
          currentThreadTs: attempt.currentThreadTs,
          currentMessageId: attempt.currentMessageId,
          currentInboundAudio: attempt.currentInboundAudio,
          ...(attempt.replyOperation
            ? {
                hasCurrentInboundAudio: () =>
                  attempt.currentInboundAudio === true ||
                  attempt.replyOperation?.acceptedSteeredInboundAudio === true,
              }
            : {}),
          includeCoreTools: toolConstructionPlan.includeCoreTools,
          includeToolSearchControls: toolSearchControlsEnabledForRun,
          toolSearchCatalogExecutor: params.toolSearchCatalogExecutor,
          toolConstructionPlan: toolConstructionPlan.codingToolConstructionPlan,
          replyToMode: attempt.replyToMode,
          hasRepliedRef: attempt.hasRepliedRef,
          modelHasVision: attempt.model.input?.includes("image") ?? false,
          computerContextEpoch,
          requireExplicitMessageTarget:
            attempt.requireExplicitMessageTarget ?? isSubagentSessionKey(attempt.sessionKey),
          sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
          taskSuggestionDeliveryMode: attempt.taskSuggestionDeliveryMode,
          inboundEventKind: attempt.currentInboundEventKind,
          disableMessageTool: attempt.disableMessageTool,
          swarmCollector: attempt.swarmCollector,
          swarmOutputSchema: attempt.swarmOutputSchema,
          forceMessageTool: attempt.forceMessageTool,
          enableHeartbeatTool: attempt.enableHeartbeatTool,
          forceHeartbeatTool: attempt.forceHeartbeatTool,
          runtimeToolAllowlist: effectiveToolsAllow,
          inheritedToolAllowlistRef: inheritedToolAllowlist,
          cronCreatorToolAllowlistRef: cronCreatorToolAllowlist,
          cronCreatorToolAllowlistCaptureRef,
          authProfileStore: attempt.authProfileStore,
          recordToolPrepStage: params.markCoreToolStage,
          onToolOutcome: attempt.onToolOutcome,
          isTurnTainted: attempt.isTurnTainted,
          allocateToolOutcomeOrdinal: attempt.allocateToolOutcomeOrdinal,
          skillsSnapshot: params.skillsSnapshot,
          skillUsagePaths: params.skillUsagePaths,
          conversationCapabilityProfile: runtimeCapabilityProfile,
          scheduledToolPolicy: attempt.scheduledToolPolicy,
          onYield: params.onYield,
        });
        params.markCoreToolStage("attempt:create-openclaw-coding-tools");
        const filteredTools = applyEmbeddedAttemptToolsAllow(allTools, effectiveToolsAllow, {
          toolMeta: (tool) => getPluginToolMeta(tool),
        });
        params.markCoreToolStage("attempt:tools-allow");
        return filteredTools;
      })();
  const toolsRaw = attempt.forceRestartSafeTools
    ? constructedToolsRaw.filter((tool) => isAgentToolRestartSafe(tool, restartSafetyOptions))
    : constructedToolsRaw;
  if (attempt.forceRestartSafeTools) {
    log.info(
      `restart-safe recovery tool policy retained ${toolsRaw.length}/${constructedToolsRaw.length} concrete tools`,
    );
  }

  return {
    codeModeControlsEnabledForRun,
    codeModeSkills,
    computerContextEpoch,
    cronCreatorToolAllowlist,
    cronCreatorToolAllowlistCaptureRef,
    effectiveToolsAllow,
    forceDirectMessageTool,
    inheritedToolAllowlist,
    localModelLeanEnabled,
    localModelLeanPreserveToolNames,
    replaySafetyOptions,
    runtimeCapabilityProfile,
    toolSearchCatalogRef,
    toolSearchConfig,
    toolSearchControlsEnabledForRun,
    toolSearchRuntimeConfig,
    toolSearchTargetTranscriptProjections,
    toolsEnabled,
    toolsRaw,
  };
}

/**
 * Plans which core, bundle MCP, and bundle LSP tools an attempt should build.
 */

const ALL_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: true,
  includeShellTools: true,
  includeChannelTools: true,
  includeOpenClawTools: true,
  includePluginTools: true,
};

const NO_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: false,
  includePluginTools: false,
};

function cloneCodingToolConstructionPlan(
  plan: OpenClawCodingToolConstructionPlan,
): OpenClawCodingToolConstructionPlan {
  return { ...plan };
}

function isBundleMcpAllowlistName(normalized: string): boolean {
  // Bundle MCP tools use the synthetic bundle name or `bundle__tool` separator form.
  return normalized === "bundle-mcp" || normalized.includes(TOOL_NAME_SEPARATOR);
}

function isPluginGroupAllowlistName(normalized: string): boolean {
  return normalized === "group:plugins";
}

function hasWildcardToolAllowlist(toolsAllow: string[]): boolean {
  return toolsAllow.some((entry) => normalizeToolName(entry) === "*");
}

/**
 * Applies a runtime allowlist to a concrete tool list after expanding tool and
 * plugin groups. Undefined allowlists keep all tools; an explicit empty list
 * intentionally disables all runtime tools.
 */
export function applyEmbeddedAttemptToolsAllow<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
  options?: {
    toolMeta?: (tool: T) => { pluginId: string } | undefined;
  },
): T[] {
  if (!toolsAllow) {
    return tools;
  }
  const restrictions = readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow];
  return restrictions.reduce<T[]>((currentTools, restriction) => {
    if (restriction.length === 0) {
      return [];
    }
    if (hasWildcardToolAllowlist(restriction)) {
      return currentTools;
    }
    const pluginGroups = options?.toolMeta
      ? buildPluginToolGroups({ tools: currentTools, toolMeta: options.toolMeta })
      : undefined;
    const policy = pluginGroups
      ? expandPolicyWithPluginGroups({ allow: restriction }, pluginGroups)
      : { allow: restriction };
    return currentTools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
  }, tools);
}

/**
 * Adds host-required tools to a narrowed runtime allowlist. Wildcard and
 * undefined allowlists already cover every required tool.
 */
export function mergeForcedEmbeddedAttemptToolsAllow(
  toolsAllow: string[] | undefined,
  params: { forceMessageTool?: boolean; forceToolNames?: readonly string[] },
): string[] | undefined {
  if (toolsAllow === undefined || hasWildcardToolAllowlist(toolsAllow)) {
    return toolsAllow;
  }
  const required = [
    ...(params.forceMessageTool ? ["message"] : []),
    ...(params.forceToolNames ?? []),
  ];
  if (required.length === 0) {
    return toolsAllow;
  }
  const normalized = new Set(toolsAllow.map((entry) => normalizeToolName(entry)));
  const missing = required.filter((name) => !normalized.has(normalizeToolName(name)));
  if (missing.length === 0) {
    return toolsAllow;
  }
  const restrictions = readToolAllowlistIntersection(toolsAllow);
  const merged = [...toolsAllow, ...missing];
  return restrictions
    ? attachToolAllowlistIntersection(
        merged,
        restrictions.map((restriction) => restriction.concat(missing)),
      )
    : merged;
}

function resolveCodingToolConstructionPlanForAllowlist(
  toolsAllow?: string[],
): OpenClawCodingToolConstructionPlan {
  if (!toolsAllow) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (toolsAllow.length === 0) {
    return cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (hasWildcardToolAllowlist(toolsAllow)) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  const expanded = expandToolGroups(toolsAllow);
  const normalized = normalizeToolList(expanded);
  const coreFamilies = new Set<CoreToolFactoryFamily>();
  let includePluginTools = false;
  for (const name of normalized) {
    const family = resolveCoreToolFactoryFamily(name);
    if (family) {
      coreFamilies.add(family);
      continue;
    }
    // Plugin ids/tool names are not known to the local factory catalog.
    if (!isBundleMcpAllowlistName(name)) {
      includePluginTools = true;
    }
  }
  const includeBaseCodingTools = coreFamilies.has("base-coding");
  const includeShellTools = coreFamilies.has("shell");
  const includeOpenClawTools = coreFamilies.has("openclaw");
  // Channel delivery tools are constructed through plugin-capable runtime setup.
  const includeChannelTools = includePluginTools;

  return {
    includeBaseCodingTools,
    includeShellTools,
    includeChannelTools,
    includeOpenClawTools,
    includePluginTools,
  };
}

/**
 * Decides which tool families need to be constructed for an embedded attempt.
 * This keeps allowlisted plugin/channel tools available without forcing every
 * local core tool factory to run for narrow plugin-only configurations.
 */
export function resolveEmbeddedAttemptToolConstructionPlan(params: {
  disableTools?: boolean;
  isRawModelRun?: boolean;
  toolsEnabled?: boolean;
  toolsAllow?: string[];
  forceMessageTool?: boolean;
}): {
  constructTools: boolean;
  includeCoreTools: boolean;
  runtimeToolAllowlist?: string[];
  codingToolConstructionPlan: OpenClawCodingToolConstructionPlan;
} {
  // Model capability is authoritative: forced delivery cannot materialize a
  // tool the selected model cannot call.
  if (
    params.disableTools === true ||
    params.isRawModelRun === true ||
    params.toolsEnabled === false
  ) {
    return {
      constructTools: false,
      includeCoreTools: false,
      codingToolConstructionPlan: cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN),
    };
  }
  const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceMessageTool: params.forceMessageTool,
  });
  const codingToolConstructionPlan = resolveCodingToolConstructionPlanForAllowlist(toolsAllow);
  const includeCoreTools =
    codingToolConstructionPlan.includeBaseCodingTools ||
    codingToolConstructionPlan.includeShellTools ||
    codingToolConstructionPlan.includeOpenClawTools;
  const constructTools =
    includeCoreTools ||
    codingToolConstructionPlan.includeChannelTools ||
    codingToolConstructionPlan.includePluginTools;

  return {
    constructTools,
    includeCoreTools,
    ...(toolsAllow ? { runtimeToolAllowlist: toolsAllow } : {}),
    codingToolConstructionPlan,
  };
}

function shouldCreateBundleRuntimeForAttempt(
  params: {
    toolsEnabled: boolean;
    disableTools?: boolean;
    toolsAllow?: string[];
  },
  matchesAllowlist: (normalizedToolName: string) => boolean,
): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow) {
    return true;
  }
  if (params.toolsAllow.length === 0) {
    return false;
  }
  if (hasWildcardToolAllowlist(params.toolsAllow)) {
    return true;
  }
  return params.toolsAllow.some((toolName) => matchesAllowlist(normalizeToolName(toolName)));
}

/**
 * Decides whether the bundled MCP runtime is needed for this attempt. Bundle
 * runtime creation follows explicit bundle/plugin allowlist names rather than
 * generic local tool names.
 */
export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  return shouldCreateBundleRuntimeForAttempt(params, (normalized) => {
    return isBundleMcpAllowlistName(normalized) || isPluginGroupAllowlistName(normalized);
  });
}

/**
 * Decides whether the bundled LSP runtime is needed for this attempt. LSP tools
 * are enabled by default/wildcard and by allowlist entries with the `lsp_`
 * prefix.
 */
export function shouldCreateBundleLspRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  return shouldCreateBundleRuntimeForAttempt(params, (normalized) => {
    return normalized.startsWith("lsp_");
  });
}
