import type { SessionPermissionMode } from "../../../../packages/gateway-protocol/src/schema/sessions-row.js";
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
import { resolveStagedInputMediaPaths } from "../../../media/staged-inputs.js";
import { extractModelCompat } from "../../../plugins/provider-model-compat.js";
import { getPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createOpenClawCodingTools } from "../../agent-tools.js";
import { createSkillInstructionDeliveryCache } from "../../agent-tools.read.js";
import { getChannelAgentToolMeta } from "../../channel-tools.js";
import { createCodeModePermissionChangeReason } from "../../code-mode-permission-change.js";
import type { CodeModeSkill } from "../../code-mode-skills.js";
import { resolveConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import {
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
} from "../../local-model-lean.js";
import { resolveModelAuthMode } from "../../model-auth.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { recordAgentCleanupFailure } from "../../run-cleanup-timeout.js";
import {
  resolveSessionPermissionExecMode,
  type PreparedSessionPermissionPolicy,
} from "../../tool-fs-policy.js";
import { toolPolicyRestrictsTools } from "../../tool-policy.js";
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
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
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
  setup: EmbeddedAttemptSetup;
  markCoreToolStage: (name: string) => void;
  onYield: NonNullable<OpenClawCodingToolsOptions["onYield"]>;
  runAbortController: AbortController;
  runTrace: DiagnosticTraceContext;
  skillUsagePaths: SkillUsagePaths;
  skillsSnapshot: EmbeddedRunAttemptParams["skillsSnapshot"];
  codeModeSkills: readonly CodeModeSkill[];
  toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor;
}) {
  const { attempt } = params;
  const requireExplicitMessageTarget =
    attempt.requireExplicitMessageTarget ?? isSubagentSessionKey(attempt.sessionKey);
  const forceDirectMessageTool = messageToolOwnsVisibleReply(attempt);
  const toolRunContext = buildEmbeddedAttemptToolRunContext({
    ...attempt,
    forceMessageTool: forceDirectMessageTool,
    trace: params.runTrace,
  });
  const toolsAllowWithForcedRuntimeTools = toolRunContext.runtimeToolAllowlist;
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
    agentId: params.setup.sessionAgentId,
    sessionKey: params.setup.sandboxSessionKey,
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
  const generationCleanups: Array<(reason: string) => Promise<void>> = [];
  const retiringGenerations = new Set<Promise<void>>();
  let retiredCleanupFailed = false;
  const retireToolGeneration = (reason: string) => {
    const cleanups = generationCleanups.splice(0);
    const settled = Promise.allSettled(cleanups.map(async (cleanup) => await cleanup(reason))).then(
      (results) => {
        if (results.some((result) => result.status === "rejected")) {
          retiredCleanupFailed = true;
        }
      },
    );
    retiringGenerations.add(settled);
    void settled.then(() => retiringGenerations.delete(settled));
  };
  const spawnWorkspaceDir =
    params.setup.effectiveCwd !== params.setup.effectiveWorkspace
      ? params.setup.resolvedWorkspace
      : resolveAttemptSpawnWorkspaceDir({
          sandbox: params.setup.sandbox,
          resolvedWorkspace: params.setup.resolvedWorkspace,
        });
  // Rebuild at each call: permission refresh observes the current attempt fields.
  const buildConversationContext = () => ({
    ...toolRunContext,
    requireExplicitMessageTarget,
    config: toolSearchRuntimeConfig,
    sessionKey: params.setup.sandboxSessionKey,
    runSessionKey: attempt.sessionKey?.trim() || attempt.sessionId,
    sessionId: attempt.sessionId,
    runId: attempt.runId,
    agentDir: params.agentDir,
    messageProvider: resolveAttemptToolPolicyMessageProvider(attempt),
    messageChannel: attempt.messageChannel,
    modelProvider: attempt.provider,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    modelContextWindowTokens: attempt.contextTokenBudget ?? attempt.model.contextWindow,
    modelHasVision: attempt.model.input?.includes("image") ?? false,
    workspaceDir: params.setup.effectiveWorkspace,
    cwd: params.setup.effectiveCwd,
    spawnWorkspaceDir,
    skillsSnapshot: params.skillsSnapshot,
    runtimeToolAllowlist: effectiveToolsAllow,
  });
  const runtimeCapabilityProfile = resolveConversationCapabilityProfile({
    ...buildConversationContext(),
    agentId: attempt.sandboxAgentId ?? params.setup.sessionAgentId,
    conversationToolPolicy: attempt.conversationToolPolicy,
    isCanonicalWorkspace: attempt.isCanonicalWorkspace,
    promptMode: attempt.promptMode,
    sandboxToolPolicy: params.setup.sandbox?.tools,
    inheritRuntimeToolAllowlist: true,
    runtimePluginToolGrant: attempt.runtimePluginToolGrant,
    inputProvenance: attempt.inputProvenance,
    trustedInternalHandoff: attempt.trustedInternalHandoff,
    pluginMetadataSnapshot: attempt.preparedModelRuntime?.metadataSnapshot,
  });
  const localModelLeanEnabled = isLocalModelLeanEnabled({
    config: attempt.config,
    agentId: params.setup.sessionAgentId,
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
  const constructTools = (
    sessionPermissionPolicy: PreparedSessionPermissionPolicy | undefined,
    abortSignal: AbortSignal,
  ) => {
    const constructedToolsRaw = !shouldConstructTools
      ? []
      : (() => {
          const allTools = createOpenClawCodingTools({
            agentId: params.setup.sessionAgentId,
            ...buildConversationContext(),
            exec: {
              ...attempt.execOverrides,
              ...(sessionPermissionPolicy
                ? { mode: resolveSessionPermissionExecMode(sessionPermissionPolicy) }
                : {}),
              config: attempt.config,
              elevated: attempt.bashElevated,
            },
            sandbox: params.setup.sandbox,
            stagedMediaPaths: resolveStagedInputMediaPaths(attempt.media),
            sessionPermissionPolicy,
            channelContext: attempt.channelContext,
            allowGatewaySubagentBinding: attempt.allowGatewaySubagentBinding,
            operationalRunInstance: attempt.admittedRunContext.operationalRunInstance,
            conversationRecall: attempt.conversationRecall,
            oneShotCliRun: attempt.oneShotCliRun,
            toolSearchCatalogRef,
            codeModeSkills,
            preparedModelRuntime: attempt.preparedModelRuntime,
            requireWorkspaceOnly: attempt.requireWorkspaceOnly,
            sessionConfigSource: attempt.oneShotCliRun ? "pinned" : "runtime",
            webSearchEnabled: attempt.toolOverrides?.webSearch !== false,
            githubPublicationAvailable: attempt.githubPublicationAvailable,
            abortSignal,
            skillWorkshop: {
              env: attempt.skillWorkshopProposalEnv,
              proposalOnly: attempt.skillWorkshopProposalOnly,
              ...(attempt.skillWorkshopUpdateProposals ? { updateProposals: true } : {}),
              ...(attempt.skillWorkshopAutonomousCapture ? { autonomousCapture: true } : {}),
              origin: attempt.skillWorkshopOrigin,
              proposalMutationBudget: attempt.skillWorkshopProposalMutationBudget,
              proposalReviewCompletion: attempt.skillWorkshopProposalReviewCompletion,
              proposalRevision: attempt.skillWorkshopProposalRevision,
              libraryAuthoring: attempt.skillLibraryAuthoring,
            },
            modelCompat: extractModelCompat(attempt.model),
            delegationCapability: attempt.delegationCapability,
            modelAuthMode: resolveModelAuthMode(attempt.model.provider, attempt.config, undefined, {
              workspaceDir: params.setup.effectiveWorkspace,
            }),
            includeCoreTools: toolConstructionPlan.includeCoreTools,
            includeToolSearchControls: toolSearchControlsEnabledForRun,
            toolSearchCatalogExecutor: params.toolSearchCatalogExecutor,
            toolConstructionPlan: toolConstructionPlan.codingToolConstructionPlan,
            computerContextEpoch,
            skillInstructionDeliveryCache,
            registerRunCleanup: (cleanup) => generationCleanups.push(cleanup),
            inboundEventKind: attempt.currentInboundEventKind,
            disableMessageTool: attempt.disableMessageTool,
            forceMessageTool: attempt.forceMessageTool,
            enableHeartbeatTool: attempt.enableHeartbeatTool,
            forceHeartbeatTool: attempt.forceHeartbeatTool,
            inheritedToolAllowlistRef: inheritedToolAllowlist,
            cronCreatorToolAllowlistRef: cronCreatorToolAllowlist,
            cronCreatorToolAllowlistCaptureRef,
            authProfileStore: attempt.authProfileStore,
            recordToolPrepStage: params.markCoreToolStage,
            onToolOutcome: attempt.onToolOutcome,
            isTurnTainted: attempt.isTurnTainted,
            allocateToolOutcomeOrdinal: attempt.allocateToolOutcomeOrdinal,
            skillUsagePaths: params.skillUsagePaths,
            conversationCapabilityProfile: runtimeCapabilityProfile,
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
    const toolsRaw = attempt.forceRestartSafeTools
      ? constructedToolsRaw.filter((tool) => isAgentToolRestartSafe(tool, restartSafetyOptions))
      : constructedToolsRaw;
    if (attempt.forceRestartSafeTools) {
      log.info(
        `restart-safe recovery tool policy retained ${toolsRaw.length}/${constructedToolsRaw.length} concrete tools`,
      );
    }
    return toolsRaw;
  };
  let toolAbortController = new AbortController();
  let toolAbortSignal = AbortSignal.any([
    params.runAbortController.signal,
    toolAbortController.signal,
  ]);
  const baseExecOverrides = {
    ...(attempt.permissionChange?.baseExecOverrides ?? attempt.execOverrides),
  };
  const toolsRaw = constructTools(params.setup.sessionPermissionPolicy, toolAbortSignal);
  runCleanups.push(async (reason) => {
    toolAbortController.abort();
    retireToolGeneration(reason);
    await Promise.all(retiringGenerations);
    if (retiredCleanupFailed) {
      recordAgentCleanupFailure();
    }
  });

  return {
    get toolAbortSignal() {
      return toolAbortSignal;
    },
    refreshPermissionMode: (mode: SessionPermissionMode | null, revokeApprovals: () => void) => {
      // Revoke prepared calls before resolving approval waiters; their old
      // signal must already be closed when an allowed decision wakes them.
      toolAbortController.abort(createCodeModePermissionChangeReason());
      revokeApprovals();
      retireToolGeneration("cancel");
      params.runAbortController.signal.throwIfAborted();
      toolAbortController = new AbortController();
      toolAbortSignal = AbortSignal.any([
        params.runAbortController.signal,
        toolAbortController.signal,
      ]);
      attempt.permissionMode = mode ?? undefined;
      attempt.execOverrides = { ...baseExecOverrides };
      const policy = mode ? { root: params.setup.sessionPermissionRoot, mode } : undefined;
      const nextTools = constructTools(policy, toolAbortSignal);
      toolsRaw.splice(0, toolsRaw.length, ...nextTools);
    },
    codeModeControlsEnabledForRun,
    codeModeSkills,
    computerContextEpoch,
    skillInstructionDeliveryCache,
    cronCreatorToolAllowlist,
    cronCreatorToolAllowlistCaptureRef,
    effectiveToolsAllow,
    forceDirectMessageTool,
    requireExplicitMessageTarget,
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
