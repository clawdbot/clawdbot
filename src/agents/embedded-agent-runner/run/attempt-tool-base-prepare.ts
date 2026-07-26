import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { extractModelCompat } from "../../../plugins/provider-model-compat.js";
import { getPluginToolMeta } from "../../../plugins/tools.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { createOpenClawCodingTools } from "../../agent-tools.js";
import { getActiveAgentRingZeroTools } from "../../agent-tools.ring-zero-context.js";
import { getChannelAgentToolMeta } from "../../channel-tools.js";
import { resolveCodeModeConfig } from "../../code-mode.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import {
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
} from "../../local-model-lean.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { supportsModelTools } from "../../model-tool-support.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { isAgentToolRestartSafe } from "../../tool-replay-safety.js";
import { resolveAgentToolSearchRuntimeConfig } from "../../tool-search-runtime-config.js";
import {
  createToolSearchCatalogRef,
  resolveToolSearchConfig,
  type ToolSearchCatalogToolExecutor,
  type ToolSearchTargetTranscriptProjection,
} from "../../tool-search.js";
import type { ComputerContextEpoch } from "../../tools/computer-tool.js";
import type { CronCreatorToolAllowlistEntry } from "../../tools/cron-tool.js";
import { log } from "../logger.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "./attempt-tool-construction-plan.js";
import { resolveAttemptToolPolicyMessageProvider } from "./attempt.run-decisions.js";
import { resolveAttemptSpawnWorkspaceDir } from "./attempt.thread-helpers.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt.tool-run-context.js";
import { TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES } from "./attempt.tool-search-run-plan.js";
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
  toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor;
}) {
  const { attempt } = params;
  const forceDirectMessageTool =
    attempt.forceMessageTool === true || attempt.sourceReplyDeliveryMode === "message_tool_only";
  const toolsAllowWithForcedRuntimeTools = mergeForcedEmbeddedAttemptToolsAllow(
    attempt.toolsAllow,
    {
      forceMessageTool: forceDirectMessageTool,
      forceToolNames:
        attempt.swarmCollector && attempt.swarmOutputSchema ? ["structured_output"] : undefined,
    },
  );
  const toolsEnabled = supportsModelTools(attempt.model);
  const ringZeroToolRun = getActiveAgentRingZeroTools().length > 0;
  const isRawModelRun = attempt.modelRun === true || attempt.promptMode === "none";
  const toolConstructionPlan = resolveEmbeddedAttemptToolConstructionPlan({
    disableTools: attempt.disableTools,
    isRawModelRun,
    toolsEnabled,
    toolsAllow: toolsAllowWithForcedRuntimeTools,
  });
  const codeModeConfig = resolveCodeModeConfig(attempt.config, params.sessionAgentId);
  const toolSearchRuntimeConfig = resolveAgentToolSearchRuntimeConfig({
    config: attempt.config,
    agentId: params.sessionAgentId,
    sessionKey: params.sandboxSessionKey,
    forceDirectMessageTool,
  });
  const toolSearchConfig = resolveToolSearchConfig(toolSearchRuntimeConfig);
  const codeModeControlsEnabledForRun =
    toolsEnabled &&
    !ringZeroToolRun &&
    attempt.disableTools !== true &&
    !isRawModelRun &&
    attempt.skillWorkshopProposalOnly !== true &&
    attempt.toolsAllow?.length !== 0 &&
    codeModeConfig.enabled;
  const toolSearchControlsEnabledForRun =
    toolsEnabled &&
    !ringZeroToolRun &&
    attempt.disableTools !== true &&
    !isRawModelRun &&
    attempt.skillWorkshopProposalOnly !== true &&
    attempt.toolsAllow?.length !== 0 &&
    !codeModeControlsEnabledForRun &&
    toolSearchConfig.enabled;
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
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
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
          abortSignal: params.runAbortController.signal,
          modelProvider: attempt.provider,
          modelId: attempt.modelId,
          skillWorkshop: {
            env: attempt.skillWorkshopProposalEnv,
            proposalOnly: attempt.skillWorkshopProposalOnly,
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
          cronCreatorToolAllowlistRef: cronCreatorToolAllowlist,
          authProfileStore: attempt.authProfileStore,
          recordToolPrepStage: params.markCoreToolStage,
          onToolOutcome: attempt.onToolOutcome,
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
    computerContextEpoch,
    cronCreatorToolAllowlist,
    effectiveToolsAllow,
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
