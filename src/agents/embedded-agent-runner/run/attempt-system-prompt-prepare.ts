import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import {
  resolveProviderSystemPromptContribution,
  transformProviderSystemPrompt,
} from "../../../plugins/provider-runtime.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { resolveProcessToolScopeKey } from "../../bash-process-scope.js";
import {
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
} from "../../bootstrap-budget.js";
import { resolveOpenClawReferencePaths } from "../../docs-path.js";
import { prepareAgentMemoryPrompt } from "../../memory-prompt-prepare.js";
import { buildModelToolsUnavailablePrompt } from "../../model-tool-support.js";
import {
  buildProjectMemoryWriteInstruction,
  prepareProjectMemoryBootstrap,
} from "../../project-memory-bootstrap.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../../prompt-surface.js";
import { resolveAgentRuntimePrompt } from "../../runtime-prompt.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { toolPolicyRestrictsTools } from "../../tool-policy.js";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import { buildToolSchemaDirectoryPrompt } from "../../tool-search.js";
import { prepareWatchedSessionsPrompt } from "../../watched-sessions-prompt.js";
import { buildEmbeddedSandboxInfo, resolveEmbeddedSandboxInfoExecPolicy } from "../sandbox-info.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";
import type { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { resolvePromptModeForSession } from "./attempt-prompt-helpers.js";
import { buildAttemptSystemPrompt } from "./attempt-system-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedBootstrap = Awaited<ReturnType<typeof prepareEmbeddedAttemptBootstrap>>;
type PromptTools = Parameters<typeof buildEmbeddedSystemPrompt>[0]["tools"];

export async function prepareEmbeddedAttemptSystemPrompt(params: {
  activeContextEngine: EmbeddedRunAttemptParams["contextEngine"];
  attempt: EmbeddedRunAttemptParams;
  bootstrap: PreparedBootstrap;
  capabilityToolNames: Set<string>;
  effectiveCwd: string;
  effectiveTools: PromptTools;
  effectiveWorkspace: string;
  getProviderRuntimeHandle: () => ProviderRuntimePluginHandle;
  isRawModelRun: boolean;
  markStage: (name: string) => void;
  modelToolsEnabled: boolean;
  proactiveSubagentOrchestration: boolean;
  sandbox?: SandboxContext;
  sandboxSessionKey: string;
  sessionAgentId: string;
  skillsPrompt: string;
  codeModeActive?: boolean;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
  toolSearchDirectoryEnabled: boolean;
  toolSearchRuntimeConfig: EmbeddedRunAttemptParams["config"];
}) {
  const { attempt } = params;
  if (attempt.operation === "settled-tool-finalization") {
    // Finalization resumes the settled transcript with only the host prompt.
    // Do not invoke provider/plugin contributors or assemble ambient context.
    params.markStage("system-prompt");
    return {
      runtimeChannel: undefined,
      runtimeInfo: { model: `${attempt.provider}/${attempt.modelId}` },
      systemPromptReport: undefined,
      systemPromptText: "",
    };
  }
  const sandboxInfoExecPolicy = resolveEmbeddedSandboxInfoExecPolicy({
    config: attempt.config,
    agentId: params.sessionAgentId,
    sessionKey: attempt.sessionKey,
    permissionMode: attempt.permissionMode,
    sandboxAvailable: params.sandbox?.enabled === true,
    execOverrides: attempt.execOverrides,
  });
  const sandboxInfo = buildEmbeddedSandboxInfo(
    params.sandbox,
    attempt.bashElevated,
    sandboxInfoExecPolicy,
  );
  const reasoningTagHint = isReasoningTagProvider(attempt.provider, {
    config: attempt.config,
    workspaceDir: params.effectiveWorkspace,
    env: process.env,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    model: attempt.model,
    runtimeHandle: params.getProviderRuntimeHandle(),
  });
  const toolSchemaDirectoryPrompt = params.toolSearchDirectoryEnabled
    ? buildToolSchemaDirectoryPrompt({
        config: attempt.config,
        runtimeConfig: params.toolSearchRuntimeConfig,
        agentId: params.sessionAgentId,
        sessionKey: params.sandboxSessionKey,
        sessionId: attempt.sessionId,
        runId: attempt.runId,
        catalogRef: params.toolSearchCatalogRef,
      })
    : undefined;

  const activeProcessSessions = listActiveProcessSessionReferences({
    scopeKey: resolveProcessToolScopeKey({
      sessionKey: params.sandboxSessionKey,
      agentId: params.sessionAgentId,
    }),
  });
  const {
    runtimeChannel,
    runtimeCapabilities,
    reactionGuidance,
    messageToolHints,
    runtimeInfo,
    userTimezone,
    userDate,
  } = await resolveAgentRuntimePrompt({
    config: attempt.config,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    cwd: params.effectiveCwd,
    ...(attempt.preparedModelRuntime && Object.hasOwn(attempt.preparedModelRuntime, "repoRoot")
      ? { preparedRepoRoot: attempt.preparedModelRuntime.repoRoot }
      : {}),
    sessionKey: attempt.sessionKey,
    sessionId: attempt.sessionId,
    model: `${attempt.provider}/${attempt.modelId}`,
    channel: attempt.messageChannel ?? attempt.messageProvider,
    accountId: attempt.agentAccountId,
    chatType: attempt.chatType,
    currentChannelId: attempt.currentChannelId,
    currentThreadTs: attempt.currentThreadTs,
    currentMessageId: attempt.currentMessageId,
    senderId: attempt.senderId,
    senderIsOwner: attempt.senderIsOwner,
    activeProcessSessions,
  });
  const promptMode =
    attempt.promptMode ??
    (params.isRawModelRun ? "none" : resolvePromptModeForSession(attempt.sessionKey));
  const promptSurface = resolveAgentPromptSurfaceForSessionKey(attempt.sessionKey);
  const toolPolicyRestricted = toolPolicyRestrictsTools({ allow: attempt.toolsAllow });
  const effectivePromptMode = toolPolicyRestricted ? ("minimal" as const) : promptMode;
  const effectiveSkillsPrompt = toolPolicyRestricted ? undefined : params.skillsPrompt;
  const openClawReferences = await resolveOpenClawReferencePaths({
    workspaceDir: params.effectiveWorkspace,
    argv1: process.argv[1],
    cwd: params.effectiveCwd,
    moduleUrl: import.meta.url,
  });
  const promptContributionContext = {
    config: attempt.config,
    agentDir: attempt.agentDir,
    workspaceDir: params.effectiveWorkspace,
    provider: attempt.provider,
    modelId: attempt.modelId,
    promptMode: effectivePromptMode,
    runtimeChannel,
    runtimeCapabilities,
    agentId: params.sessionAgentId,
    trigger: attempt.trigger,
  };
  const promptContribution =
    attempt.runtimePlan?.prompt.resolveSystemPromptContribution(promptContributionContext) ??
    resolveProviderSystemPromptContribution({
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: params.effectiveWorkspace,
      runtimeHandle: params.getProviderRuntimeHandle(),
      context: promptContributionContext,
    });
  const includeMemorySection =
    !params.activeContextEngine || params.activeContextEngine.info.id === "legacy";
  const preparedMemoryPrompt = await prepareAgentMemoryPrompt({
    enabled: effectivePromptMode === "full" && includeMemorySection,
    toolNames: params.effectiveTools.map((tool) => tool.name),
    capabilityToolNames: params.capabilityToolNames,
    citationsMode: attempt.config?.memory?.citations,
    agentId: runtimeInfo.agentId,
    agentSessionKey: runtimeInfo.sessionKey,
    sandboxed: sandboxInfo?.enabled === true,
  });
  const preparedWatchedSessions = prepareWatchedSessionsPrompt({
    enabled: effectivePromptMode === "full",
    config: attempt.config,
    sessionKey: attempt.sessionKey,
    sandboxed: sandboxInfo?.enabled === true,
    toolNames: params.effectiveTools.map((tool) => tool.name),
    capabilityToolNames: params.capabilityToolNames,
  });
  const activeProjectKeys = attempt.preparedModelRuntime?.activeProjectKeys ?? [];
  const projectMemoryBootstrap =
    effectivePromptMode === "full" && activeProjectKeys.length > 0
      ? await prepareProjectMemoryBootstrap({
          cfg: attempt.config ?? {},
          agentId: params.sessionAgentId,
          activeProjectKeys,
        })
      : [];
  const projectMemoryWriteInstruction = buildProjectMemoryWriteInstruction(
    attempt.preparedModelRuntime?.projectKey,
  );
  const extraSystemPrompt =
    [
      attempt.extraSystemPrompt,
      projectMemoryWriteInstruction,
      buildModelToolsUnavailablePrompt(params.modelToolsEnabled),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n") || undefined;

  const attemptSystemPrompt = buildAttemptSystemPrompt({
    isRawModelRun: params.isRawModelRun,
    transformProviderSystemPrompt: (transformParams) =>
      transformProviderSystemPrompt({
        ...transformParams,
        runtimeHandle: params.getProviderRuntimeHandle(),
      }),
    embeddedSystemPrompt: {
      config: attempt.config,
      agentId: params.sessionAgentId,
      workspaceDir: params.effectiveWorkspace,
      defaultThinkLevel: attempt.thinkLevel,
      reasoningLevel: attempt.reasoningLevel ?? "off",
      extraSystemPrompt,
      ownerNumbers: attempt.ownerNumbers,
      reasoningTagHint,
      skillsPrompt: effectiveSkillsPrompt,
      codeModeActive: params.codeModeActive,
      docsPath: openClawReferences.docsPath ?? undefined,
      sourcePath: openClawReferences.sourcePath ?? undefined,
      workspaceNotes: params.bootstrap.workspaceNotes.length
        ? params.bootstrap.workspaceNotes
        : undefined,
      reactionGuidance,
      promptMode: effectivePromptMode,
      sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
      silentReplyPromptMode: attempt.silentReplyPromptMode,
      proactiveSubagentOrchestration: params.proactiveSubagentOrchestration,
      acpEnabled: isAcpRuntimeSpawnAvailable({
        config: attempt.config,
        sandboxed: sandboxInfo?.enabled === true,
      }),
      promptSurface,
      nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
        surface: promptSurface,
      }),
      runtimeInfo,
      messageToolHints,
      toolSchemaDirectoryPrompt,
      sandboxInfo,
      capabilityToolNames: [...params.capabilityToolNames].toSorted(),
      tools: params.effectiveTools,
      userTimezone,
      userDate,
      contextFiles: params.bootstrap.contextFiles,
      bootstrapMode: params.bootstrap.bootstrapMode,
      bootstrapTruncationNotice: buildBootstrapPromptWarningNotice(
        params.bootstrap.bootstrapPromptWarning.lines,
      ),
      includeMemorySection,
      preparedMemoryPrompt,
      preparedWatchedSessions,
      projectMemoryBootstrap,
      activeProjectKeys,
      promptContribution,
    },
    providerTransform: {
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: params.effectiveWorkspace,
      context: {
        config: attempt.config,
        agentDir: attempt.agentDir,
        workspaceDir: params.effectiveWorkspace,
        provider: attempt.provider,
        modelId: attempt.modelId,
        promptMode: effectivePromptMode,
        runtimeChannel,
        runtimeCapabilities,
        agentId: params.sessionAgentId,
      },
    },
  });
  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    provider: attempt.provider,
    model: attempt.modelId,
    workspaceDir: params.effectiveWorkspace,
    bootstrapMaxChars: params.bootstrap.bootstrapMaxChars,
    bootstrapTotalMaxChars: params.bootstrap.bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: params.bootstrap.bootstrapAnalysis,
      warningMode: params.bootstrap.bootstrapPromptWarningMode,
      warning: params.bootstrap.bootstrapPromptWarning,
    }),
    sandbox: (() => {
      const runtime = resolveSandboxRuntimeStatus({
        cfg: attempt.config,
        sessionKey: params.sandboxSessionKey,
      });
      return { mode: runtime.mode, sandboxed: runtime.sandboxed };
    })(),
    systemPrompt: attemptSystemPrompt.systemPrompt,
    bootstrapFiles: params.bootstrap.hookAdjustedBootstrapFiles,
    injectedFiles: params.bootstrap.contextFiles,
    skillsPrompt: params.skillsPrompt,
    tools: params.effectiveTools,
  });
  params.markStage("system-prompt");

  return {
    runtimeChannel,
    runtimeInfo,
    systemPromptReport,
    systemPromptText: attemptSystemPrompt.systemPrompt,
  };
}
