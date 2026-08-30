/**
 * Prepares the core tool surface for one embedded attempt.
 * It may assume workspace, model, and runtime policy inputs are resolved.
 */
import { messageToolOwnsVisibleReply } from "../../../auto-reply/source-reply-delivery-mode.js";
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  isCodeModeDiagnosticEnabled,
  logCodeModeDiagnostic,
} from "../../../logging/code-mode-diagnostic.js";
import { extractModelCompat } from "../../../plugins/provider-model-compat.js";
import { getPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createOpenClawCodingTools } from "../../agent-tools.js";
import { createSkillInstructionDeliveryCache } from "../../agent-tools.read.js";
import { getChannelAgentToolMeta } from "../../channel-tools.js";
import type { CodeModeSkill } from "../../code-mode-skills.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import {
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
} from "../../local-model-lean.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { supportsModelTools } from "../../model-tool-support.js";
import type { SandboxContext } from "../../sandbox/types.js";
import {
  resolveSessionPermissionExecMode,
  type PreparedSessionPermissionPolicy,
} from "../../tool-fs-policy.js";
import { normalizeToolPolicyName, toolPolicyRestrictsTools } from "../../tool-policy.js";
import { isAgentToolRestartSafe } from "../../tool-replay-safety.js";
import {
  createToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import { resolveAgentToolSurfacePlan } from "../../tool-surface-plan.js";
import type { ComputerContextEpoch } from "../../tools/computer-tool.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../../tools/cron-tool.js";
import { log } from "../logger.js";
import { resolveAttemptToolPolicyMessageProvider } from "./attempt-run-decisions.js";
import { resolveAttemptSpawnWorkspaceDir } from "./attempt-thread-helpers.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "./attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "./attempt-tool-run-context.js";
import { TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES } from "./attempt-tool-search-run-plan.js";
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
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
  sessionAgentId: string;
  skillUsagePaths: SkillUsagePaths;
  skillsSnapshot: EmbeddedRunAttemptParams["skillsSnapshot"];
  codeModeSkills: readonly CodeModeSkill[];
  toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor;
}) {
  const { attempt } = params;
  const inspectingCodeModeRecovery = attempt.codeModeRecovery?.kind === "inspect";
  const forceDirectMessageTool = inspectingCodeModeRecovery
    ? false
    : messageToolOwnsVisibleReply(attempt);
  const toolRunContext = buildEmbeddedAttemptToolRunContext({
    ...attempt,
    forceMessageTool: forceDirectMessageTool,
    trace: params.runTrace,
  });
  const toolsAllowWithForcedRuntimeTools = inspectingCodeModeRecovery
    ? ["read"]
    : toolRunContext.runtimeToolAllowlist;
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
    modelProvider: attempt.provider,
    modelId: attempt.modelId,
    codeModeOverride: attempt.codeModeOverride,
    toolsEnabled,
    disableTools: attempt.disableTools,
    isRawModelRun,
    toolsAllow: attempt.toolsAllow,
    forceCodeModeControls: attempt.forceCodeModeTools,
    forceDirectTools: inspectingCodeModeRecovery,
  });
  if (isCodeModeDiagnosticEnabled()) {
    logCodeModeDiagnostic(log, "activation", {
      runId: attempt.runId,
      active: codeModeControlsEnabledForRun,
      toolsEnabled,
      rawRun: isRawModelRun,
      toolsDisabled: attempt.disableTools === true,
      fallbackActive: attempt.fallbackActive === true,
      allowlist:
        attempt.toolsAllow === undefined
          ? "unset"
          : attempt.toolsAllow.length === 0
            ? "empty"
            : "nonempty",
    });
  }
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
  const skillInstructionDeliveryCache = createSkillInstructionDeliveryCache();
  const toolSearchCatalogRef =
    toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun
      ? createToolSearchCatalogRef()
      : undefined;
  const nestedToolActivities: NestedToolActivity[] = [];
  const codeModeSkills = toolPolicyRestrictsTools({ allow: attempt.toolsAllow })
    ? []
    : params.codeModeSkills;
  const cronCreatorToolAllowlist: CronCreatorToolAllowlistEntry[] = [];
  const cronCreatorToolAllowlistCaptureRef: CronToolsAllowCaptureRef = {};
  const inheritedToolAllowlist: string[] = [];
  const runCleanups: Array<(reason: string) => Promise<void>> = [];
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
    modelContextWindowTokens: attempt.contextTokenBudget ?? attempt.model.contextWindow,
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
    pluginMetadataSnapshot: attempt.preparedModelRuntime?.metadataSnapshot,
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
          ...toolRunContext,
          messageChannel: attempt.messageChannel,
          clientCaps: attempt.clientCaps,
          toolBindings: attempt.toolBindings,
          chatType: attempt.chatType,
          exec: {
            ...attempt.execOverrides,
            ...(params.sessionPermissionPolicy
              ? { mode: resolveSessionPermissionExecMode(params.sessionPermissionPolicy) }
              : {}),
            config: attempt.config,
            elevated: attempt.bashElevated,
          },
          sandbox: params.sandbox,
          sessionPermissionPolicy: params.sessionPermissionPolicy,
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
          operationalRunInstance: attempt.admittedRunContext.operationalRunInstance,
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
          sessionConfigSource: attempt.oneShotCliRun ? "pinned" : "runtime",
          webSearchEnabled: attempt.toolOverrides?.webSearch !== false,
          githubPublicationAvailable: attempt.githubPublicationAvailable,
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
            collectionReconcile: attempt.skillWorkshopCollectionReconcile,
            proposalRevision: attempt.skillWorkshopProposalRevision,
          },
          modelCompat: extractModelCompat(attempt.model),
          modelApi: attempt.model.api,
          modelContextWindowTokens: attempt.contextTokenBudget ?? attempt.model.contextWindow,
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
          skillInstructionDeliveryCache,
          registerRunCleanup: (cleanup) => runCleanups.push(cleanup),
          requireExplicitMessageTarget:
            attempt.requireExplicitMessageTarget ?? isSubagentSessionKey(attempt.sessionKey),
          sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
          taskSuggestionDeliveryMode: attempt.taskSuggestionDeliveryMode,
          inboundEventKind: attempt.currentInboundEventKind,
          disableMessageTool: attempt.disableMessageTool,
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
        // The built-in harness retains its existing authoritative wrappers.
        // Only plugin harnesses receive and require the projected host capability.
        const boundTools = attempt.hostCapabilities
          ? attempt.hostCapabilities.bindToolSurface(allTools)
          : allTools;
        params.markCoreToolStage("attempt:create-openclaw-coding-tools");
        const filteredTools = applyEmbeddedAttemptToolsAllow(boundTools, effectiveToolsAllow, {
          toolMeta: (tool) => getPluginToolMeta(tool),
        });
        params.markCoreToolStage("attempt:tools-allow");
        return filteredTools;
      })();
  const toolsRaw = inspectingCodeModeRecovery
    ? constructedToolsRaw.filter((tool) => normalizeToolPolicyName(tool.name) === "read")
    : attempt.forceRestartSafeTools
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
    skillInstructionDeliveryCache,
    cronCreatorToolAllowlist,
    cronCreatorToolAllowlistCaptureRef,
    effectiveToolsAllow,
    forceDirectMessageTool,
    inheritedToolAllowlist,
    localModelLeanEnabled,
    localModelLeanPreserveToolNames,
    replaySafetyOptions,
    runtimeCapabilityProfile,
    runCleanups,
    toolSearchCatalogRef,
    toolSearchConfig,
    toolSearchControlsEnabledForRun,
    toolSearchRuntimeConfig,
    nestedToolActivities,
    toolsEnabled,
    toolsRaw,
  };
}
