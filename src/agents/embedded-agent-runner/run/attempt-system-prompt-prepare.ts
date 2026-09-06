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
  const resolveSandboxInfo = () => {
    const sandboxInfoExecPolicy = resolveEmbeddedSandboxInfoExecPolicy({
      config: attempt.config,
      agentId: params.sessionAgentId,
      sessionKey: attempt.sessionKey,
      permissionMode: attempt.permissionMode,
      sandboxAvailable: params.sandbox?.enabled === true,
      execOverrides: attempt.execOverrides,
    });
    return buildEmbeddedSandboxInfo(params.sandbox, attempt.bashElevated, sandboxInfoExecPolicy);
  };
  const sandboxInfo = resolveSandboxInfo();
  const reasoningTagHint = isReasoningTagProvider(attempt.provider, {
    config: attempt.config,
    workspaceDir: params.effectiveWorkspace,
    env: process.env,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    model: attempt.model,
    runtimeHandle: params.getProviderRuntimeHandle(),
  });
  const resolveToolSchemaDirectoryPrompt = () =>
    params.toolSearchDirectoryEnabled
      ? buildToolSchemaDirectoryPrompt(
          {
            config: attempt.config,
            runtimeConfig: params.toolSearchRuntimeConfig,
            agentId: params.sessionAgentId,
            sessionKey: params.sandboxSessionKey,
            sessionId: attempt.sessionId,
            runId: attempt.runId,
            catalogRef: params.toolSearchCatalogRef,
          },
          { contextTokenBudget: attempt.contextTokenBudget },
        )
      : undefined;

  const toolSchemaDirectoryPrompt = resolveToolSchemaDirectoryPrompt();

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
  const prepareToolContextSections = async (
    tools: PromptTools,
    capabilityToolNames: Iterable<string>,
    sandboxed: boolean,
  ) => {
    const toolContext = {
      toolNames: tools.map((tool) => tool.name),
      capabilityToolNames,
      sandboxed,
    };
    return {
      preparedMemoryPrompt: await prepareAgentMemoryPrompt({
        ...toolContext,
        enabled: effectivePromptMode === "full" && includeMemorySection,
        citationsMode: attempt.config?.memory?.citations,
        agentId: runtimeInfo.agentId,
        agentSessionKey: runtimeInfo.sessionKey,
      }),
      preparedWatchedSessions: prepareWatchedSessionsPrompt({
        ...toolContext,
        enabled: effectivePromptMode === "full",
        config: attempt.config,
        sessionKey: attempt.sessionKey,
      }),
    };
  };
  const { preparedMemoryPrompt, preparedWatchedSessions } = await prepareToolContextSections(
    params.effectiveTools,
    params.capabilityToolNames,
    sandboxInfo?.enabled === true,
  );
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

  const promptInputs: Parameters<typeof buildAttemptSystemPrompt>[0] = {
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
      runtimeCwd: params.effectiveCwd,
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
  };
  const attemptSystemPrompt = buildAttemptSystemPrompt(promptInputs);
  const reportInputs: Parameters<typeof buildSystemPromptReport>[0] = {
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
        agentId:
          attempt.sandboxAgentId ??
          (params.sandboxSessionKey === (attempt.sessionKey?.trim() || attempt.sessionId)
            ? params.sessionAgentId
            : undefined),
        sessionKey: params.sandboxSessionKey,
      });
      return { mode: runtime.mode, sandboxed: runtime.sandboxed };
    })(),
    systemPrompt: attemptSystemPrompt.systemPrompt,
    injectedWorkspaceFiles: params.bootstrap.bootstrapInjectionStats,
    skillsPrompt: params.skillsPrompt,
    tools: params.effectiveTools,
  };
  const systemPromptReport = buildSystemPromptReport(reportInputs);
  params.markStage("system-prompt");

  let permissionPromptPreparation:
    | {
        mode: EmbeddedRunAttemptParams["permissionMode"];
        tools: PromptTools;
        capabilities: string[];
        promise: Promise<(currentSystemPrompt: string) => string>;
      }
    | undefined;

  return {
    runtimeChannel,
    runtimeInfo,
    systemPromptReport,
    systemPromptText: attemptSystemPrompt.systemPrompt,
    preparePermissionPrompt: (effectiveTools: PromptTools = params.effectiveTools) => {
      const mode = attempt.permissionMode;
      const capabilities = [...params.capabilityToolNames].toSorted();
      if (
        permissionPromptPreparation &&
        permissionPromptPreparation.mode === mode &&
        permissionPromptPreparation.tools === effectiveTools &&
        permissionPromptPreparation.capabilities.length === capabilities.length &&
        permissionPromptPreparation.capabilities.every(
          (name, index) => name === capabilities[index],
        )
      ) {
        return permissionPromptPreparation.promise;
      }
      // Prepare once per tool/policy generation. Memory supplements may await;
      // keep their immutable context separate until the model boundary accepts it.
      const tools = [...effectiveTools];
      const refreshedSandboxInfo = resolveSandboxInfo();
      const embeddedSystemPrompt = {
        ...promptInputs.embeddedSystemPrompt,
        tools,
        capabilityToolNames: capabilities,
        toolSchemaDirectoryPrompt: resolveToolSchemaDirectoryPrompt(),
        sandboxInfo: refreshedSandboxInfo,
      };
      const promise = (async () => {
        Object.assign(
          embeddedSystemPrompt,
          await prepareToolContextSections(
            tools,
            capabilities,
            refreshedSandboxInfo?.enabled === true,
          ),
        );
        const nextSystemPrompt = buildAttemptSystemPrompt({
          ...promptInputs,
          embeddedSystemPrompt,
        });
        const permissionNotice = `## Permission change\nThe operator changed workspace permissions to ${mode ?? "configured defaults"}. Continue the current task with the updated tools and permissions. Inspect interrupted actions before retrying; do not repeat completed actions.`;
        return (currentSystemPrompt: string) => {
          if (params.isRawModelRun) {
            return currentSystemPrompt;
          }
          const systemPrompt = nextSystemPrompt.refreshSystemPrompt(
            currentSystemPrompt,
            permissionNotice,
          );
          Object.assign(
            systemPromptReport,
            buildSystemPromptReport({
              ...reportInputs,
              generatedAt: Date.now(),
              systemPrompt,
              tools,
            }),
          );
          return systemPrompt;
        };
      })();
      permissionPromptPreparation = { mode, tools: effectiveTools, capabilities, promise };
      return promise;
    },
  };
}
