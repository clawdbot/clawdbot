import os from "node:os";
import { isAcpRuntimeSpawnAvailable } from "../../../acp/runtime/availability.js";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../../../infra/os-summary.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../../plugins/command-registry-state.js";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import {
  resolveProviderSystemPromptContribution,
  transformProviderSystemPrompt,
} from "../../../plugins/provider-runtime.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveProcessToolScopeKey } from "../../agent-tools.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import {
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
} from "../../bootstrap-budget.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../../channel-tools.js";
import { resolveOpenClawReferencePaths } from "../../docs-path.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../../heartbeat-system-prompt.js";
import { prepareAgentMemoryPrompt } from "../../memory-prompt-prepare.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../../prompt-surface.js";
import { collectRuntimeChannelCapabilities } from "../../runtime-capabilities.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { detectRuntimeShell } from "../../shell-utils.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import { buildToolSchemaDirectoryPrompt } from "../../tool-search.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "../message-action-discovery-input.js";
import { buildEmbeddedSandboxInfo, resolveEmbeddedSandboxInfoExecPolicy } from "../sandbox-info.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";
import type { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { buildAttemptSystemPrompt } from "./attempt-system-prompt.js";
import {
  resolvePromptModeForSession,
  shouldInjectHeartbeatPrompt,
} from "./attempt.prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedBootstrap = Awaited<ReturnType<typeof prepareEmbeddedAttemptBootstrap>>;
type PromptTools = Parameters<typeof buildEmbeddedSystemPrompt>[0]["tools"];

export async function prepareEmbeddedAttemptSystemPrompt(params: {
  activeContextEngine: EmbeddedRunAttemptParams["contextEngine"];
  attempt: EmbeddedRunAttemptParams;
  bootstrap: PreparedBootstrap;
  capabilityToolNames: Set<string>;
  defaultAgentId: string;
  deferredDirectoryToolsCallable: boolean;
  effectiveCwd: string;
  effectiveTools: PromptTools;
  effectiveWorkspace: string;
  getProviderRuntimeHandle: () => ProviderRuntimePluginHandle;
  isRawModelRun: boolean;
  markStage: (name: string) => void;
  proactiveSubagentOrchestration: boolean;
  sandbox?: SandboxContext;
  sandboxSessionKey: string;
  sessionAgentId: string;
  skillsPrompt: string;
  toolSearchCatalogRef?: ToolSearchCatalogRef;
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
  const machineName = await getMachineDisplayName();
  const runtimeChannel = normalizeMessageChannel(attempt.messageChannel ?? attempt.messageProvider);
  const runtimeCapabilities = collectRuntimeChannelCapabilities({
    cfg: attempt.config,
    channel: runtimeChannel,
    accountId: attempt.agentAccountId,
  });
  const reactionGuidance =
    runtimeChannel && attempt.config
      ? resolveChannelReactionGuidance({
          cfg: attempt.config,
          channel: runtimeChannel,
          accountId: attempt.agentAccountId,
        })
      : undefined;
  const sandboxInfoExecPolicy = resolveEmbeddedSandboxInfoExecPolicy({
    config: attempt.config,
    agentId: params.sessionAgentId,
    sessionKey: attempt.sessionKey,
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
  const channelActions = runtimeChannel
    ? listChannelSupportedActions(
        buildEmbeddedMessageActionDiscoveryInput({
          cfg: attempt.config,
          channel: runtimeChannel,
          currentChannelId: attempt.currentChannelId,
          currentThreadTs: attempt.currentThreadTs,
          currentMessageId: attempt.currentMessageId,
          accountId: attempt.agentAccountId,
          sessionKey: attempt.sessionKey,
          sessionId: attempt.sessionId,
          agentId: params.sessionAgentId,
          senderId: attempt.senderId,
          senderIsOwner: attempt.senderIsOwner,
        }),
      )
    : undefined;
  const messageToolHints = runtimeChannel
    ? resolveChannelMessageToolHints({
        cfg: attempt.config,
        channel: runtimeChannel,
        accountId: attempt.agentAccountId,
      })
    : undefined;
  const toolSchemaDirectoryPrompt = params.deferredDirectoryToolsCallable
    ? buildToolSchemaDirectoryPrompt({
        config: attempt.config,
        runtimeConfig: attempt.config,
        agentId: params.sessionAgentId,
        sessionKey: params.sandboxSessionKey,
        sessionId: attempt.sessionId,
        runId: attempt.runId,
        catalogRef: params.toolSearchCatalogRef,
      })
    : undefined;

  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: attempt.config ?? {},
    agentId: params.sessionAgentId,
  });
  const activeProcessSessions = listActiveProcessSessionReferences({
    scopeKey: resolveProcessToolScopeKey({
      sessionKey: params.sandboxSessionKey,
      agentId: params.sessionAgentId,
    }),
  });
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: attempt.config,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    cwd: params.effectiveCwd,
    ...(attempt.preparedModelRuntime && Object.hasOwn(attempt.preparedModelRuntime, "repoRoot")
      ? { preparedRepoRoot: attempt.preparedModelRuntime.repoRoot }
      : {}),
    runtime: {
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      host: machineName,
      os: resolveRuntimeOsLabel(),
      arch: os.arch(),
      node: process.version,
      model: `${attempt.provider}/${attempt.modelId}`,
      defaultModel: `${defaultModelRef.provider}/${defaultModelRef.model}`,
      shell: detectRuntimeShell(),
      channel: runtimeChannel,
      chatType: attempt.chatType,
      capabilities: runtimeCapabilities,
      channelActions,
      activeProcessSessions,
    },
  });
  const isDefaultAgent = params.sessionAgentId === params.defaultAgentId;
  const promptMode =
    attempt.promptMode ??
    (params.isRawModelRun ? "none" : resolvePromptModeForSession(attempt.sessionKey));
  const promptSurface = resolveAgentPromptSurfaceForSessionKey(attempt.sessionKey);
  const effectivePromptMode = attempt.toolsAllow?.length ? ("minimal" as const) : promptMode;
  const effectiveSkillsPrompt = attempt.toolsAllow?.length ? undefined : params.skillsPrompt;
  const openClawReferences = await resolveOpenClawReferencePaths({
    workspaceDir: params.effectiveWorkspace,
    argv1: process.argv[1],
    cwd: params.effectiveCwd,
    moduleUrl: import.meta.url,
  });
  const heartbeatPrompt = shouldInjectHeartbeatPrompt({
    config: attempt.config,
    agentId: params.sessionAgentId,
    defaultAgentId: params.defaultAgentId,
    isDefaultAgent,
    trigger: attempt.trigger,
    bootstrapContextRunKind: attempt.bootstrapContextRunKind,
  })
    ? resolveHeartbeatPromptForSystemPrompt({
        config: attempt.config,
        agentId: params.sessionAgentId,
        defaultAgentId: params.defaultAgentId,
      })
    : undefined;
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
    trigger: attempt.bootstrapContextRunKind === "commitment-only" ? undefined : attempt.trigger,
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
      extraSystemPrompt: attempt.extraSystemPrompt,
      ownerNumbers: attempt.ownerNumbers,
      reasoningTagHint,
      heartbeatPrompt,
      skillsPrompt: effectiveSkillsPrompt,
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
      userTime,
      userTimeFormat,
      contextFiles: params.bootstrap.contextFiles,
      bootstrapMode: params.bootstrap.bootstrapMode,
      bootstrapTruncationNotice: buildBootstrapPromptWarningNotice(
        params.bootstrap.bootstrapPromptWarning.lines,
      ),
      includeMemorySection,
      preparedMemoryPrompt,
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
