/**
 * Builds the skills, tools, capability profile, and system prompt used by one
 * prepared direct compaction attempt.
 */
import os from "node:os";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import {
  formatActiveNodeContextLabel,
  getCurrentActiveNodeContext,
} from "../../infra/active-node-context.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../../infra/os-summary.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../plugins/command-registry-state.js";
import { extractModelCompat } from "../../plugins/provider-model-compat.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { transformProviderSystemPrompt } from "../../plugins/provider-runtime.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../skills/runtime/env-overrides.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { createBundleLspToolRuntime } from "../agent-bundle-lsp-runtime.js";
import { createBundleMcpToolRuntime } from "../agent-bundle-mcp-tools.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import { listActiveProcessSessionReferences } from "../bash-process-references.js";
import { resolveProcessToolScopeKey } from "../bash-process-scope.js";
import {
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveContextInjectionMode,
} from "../bootstrap-files.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../channel-tools.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { formatDateStamp, resolveUserTimezone } from "../date-time.js";
import { resolveOpenClawReferencePaths } from "../docs-path.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import { prepareAgentMemoryPrompt } from "../memory-prompt-prepare.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  resolveModelAuthMode,
} from "../model-auth.js";
import { supportsModelTools } from "../model-tool-support.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../prompt-surface.js";
import { collectRuntimeChannelCapabilities } from "../runtime-capabilities.js";
import { buildAgentRuntimePlan } from "../runtime-plan/build.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";
import { detectRuntimeShell } from "../shell-utils.js";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
} from "../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../tool-schema-quarantine.js";
import { prepareWatchedSessionsPrompt } from "../watched-sessions-prompt.js";
import { resolveCompactionContextTokenBudget } from "./compaction-runtime-context.js";
import type { DirectCompactionPreparation } from "./direct-compaction-preparation.js";
import { applyFinalEffectiveToolPolicy } from "./effective-tool-policy.js";
import { log } from "./logger.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "./message-action-discovery-input.js";
import { resolveAttemptSpawnWorkspaceDir } from "./run/attempt-thread-helpers.js";
import { buildEmbeddedSandboxInfo, resolveEmbeddedSandboxInfoExecPolicy } from "./sandbox-info.js";
import {
  createSandboxPromptEntryLoader,
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";
import { buildEmbeddedSystemPrompt } from "./system-prompt.js";
import { collectAllowedToolNames } from "./tool-name-allowlist.js";
import { mapThinkingLevelForProvider } from "./utils.js";

export async function buildPreparedCompactionRuntime(prepared: DirectCompactionPreparation) {
  const {
    params,
    runId,
    agentDir,
    provider,
    contextConfigProvider,
    modelId,
    preparedHarnessRuntime,
    thinkLevel,
    runtimeModel,
    apiKeyInfo,
    resolvedRuntimeAuthPlan,
    hasRuntimeAuthExchange,
    resolvedWorkspace,
    sandboxSessionKey,
    sandbox,
    effectiveWorkspace,
    effectiveCwd,
    effectiveSkillAgentId,
  } = prepared;
  let restoreSkillEnv: (() => void) | undefined;
  let bundleMcpRuntime: Awaited<ReturnType<typeof createBundleMcpToolRuntime>> | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  let toolRuntimesDisposed = false;
  let skillEnvironmentRestored = false;
  const disposeToolRuntimes = async () => {
    if (toolRuntimesDisposed) {
      return;
    }
    toolRuntimesDisposed = true;
    try {
      await bundleMcpRuntime?.dispose();
    } catch {
      /* best-effort */
    }
    try {
      await bundleLspRuntime?.dispose();
    } catch {
      /* best-effort */
    }
  };
  const restoreSkillEnvironment = () => {
    if (skillEnvironmentRestored) {
      return;
    }
    skillEnvironmentRestored = true;
    restoreSkillEnv?.();
  };
  const dispose = async () => {
    await disposeToolRuntimes();
    restoreSkillEnvironment();
  };

  try {
    const {
      skillsEligibility,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
      skillsSnapshot: skillsSnapshotForRun,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      workspaceOnly: loadSkillsWorkspaceOnly,
    } = resolveSandboxSkillRuntimeInputs({
      sandbox,
      skillsAnchorWorkspace: params.bootstrapWorkspaceDir ?? effectiveWorkspace,
      skillsSnapshot: params.skillsSnapshot,
    });
    const { shouldLoadSkillEntries, skillEntries, loadSkillEntries } =
      resolveEmbeddedRunSkillEntries({
        workspaceDir: effectiveSkillsWorkspace,
        config: params.config,
        agentId: effectiveSkillAgentId,
        eligibility: skillsEligibility,
        skillsSnapshot: skillsSnapshotForRun,
        workspaceOnly: loadSkillsWorkspaceOnly,
      });
    restoreSkillEnv = skillsSnapshotForRun
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: skillsSnapshotForRun,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });
    const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
    });
    const skillUsagePaths = mapSandboxSkillUsagePaths({
      paths: sandbox?.skillUsagePaths,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
    });
    const skillsPrompt = resolveSkillsPrompt({
      skillsSnapshot: skillsSnapshotForRun,
      entries: promptSkillEntries,
      loadEntries: createSandboxPromptEntryLoader({
        loadEntries: loadSkillEntries,
        skillsWorkspaceDir: effectiveSkillsWorkspace,
        skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
      }),
      config: params.config,
      workspaceDir: effectiveSkillsPromptWorkspace,
      agentId: effectiveSkillAgentId,
      eligibility: skillsEligibility,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
    const contextInjectionMode = resolveContextInjectionMode(params.config, effectiveSkillAgentId);
    const { contextFiles } =
      contextInjectionMode === "never"
        ? { contextFiles: [] }
        : await resolveBootstrapContextForRun({
            workspaceDir: effectiveWorkspace,
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            chatType: params.chatType,
            agentId: effectiveSkillAgentId,
            warn: makeBootstrapWarn({
              sessionLabel,
              warn: (message) => log.warn(message),
            }),
          });
    // Apply contextTokens cap to model so session runtime's auto-compaction
    // threshold uses the effective limit, not the native context window.
    const runtimeModelWithContext = runtimeModel as ProviderRuntimeModel;
    const contextTokenBudget = resolveCompactionContextTokenBudget({
      config: params.config,
      provider: contextConfigProvider,
      modelId,
      model: runtimeModelWithContext,
      agentId: effectiveSkillAgentId,
      requestedTokenBudget: params.contextTokenBudget,
      fallbackTokenBudget: params.tokenBudget,
    });
    const effectiveModel = applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(
        contextTokenBudget < (runtimeModelWithContext.contextWindow ?? Infinity)
          ? { ...runtimeModelWithContext, contextWindow: contextTokenBudget }
          : runtimeModelWithContext,
        apiKeyInfo,
      ),
      // Skip header injection when runtime auth exchange produced a
      // different credential — the SDK reads the exchanged token from
      // authStorage automatically.
      hasRuntimeAuthExchange ? null : apiKeyInfo,
      params.config,
    );
    const reuseFullRuntimePlan = params.runtimePlan?.auth === resolvedRuntimeAuthPlan;
    const preparedRuntimePlan =
      (reuseFullRuntimePlan ? params.runtimePlan : undefined) ??
      buildAgentRuntimePlan({
        provider,
        modelId,
        model: effectiveModel,
        modelApi: effectiveModel.api,
        harnessId: preparedHarnessRuntime,
        harnessRuntime: preparedHarnessRuntime,
        authProfileMode: resolvedRuntimeAuthPlan.selectedAuthMode,
        sessionAuthProfileId: resolvedRuntimeAuthPlan.forwardedAuthProfileId,
        sessionAuthProfileSource: resolvedRuntimeAuthPlan.forwardedAuthProfileSource,
        sessionAuthProfileCandidateIds: resolvedRuntimeAuthPlan.forwardedAuthProfileCandidateIds,
        modelRoute: resolvedRuntimeAuthPlan.modelRoute,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        agentDir,
        agentId: effectiveSkillAgentId,
        thinkingLevel: mapThinkingLevelForProvider(thinkLevel),
      });
    const runtimePlan = reuseFullRuntimePlan
      ? preparedRuntimePlan
      : { ...preparedRuntimePlan, auth: resolvedRuntimeAuthPlan };

    const runAbortController = new AbortController();
    const spawnWorkspaceDir =
      effectiveCwd !== effectiveWorkspace
        ? resolvedWorkspace
        : resolveAttemptSpawnWorkspaceDir({
            sandbox,
            resolvedWorkspace,
          });
    const runtimeCapabilityProfile = resolveConversationCapabilityProfile({
      config: params.config,
      sessionKey: sandboxSessionKey,
      runSessionKey:
        params.sessionKey && params.sessionKey !== sandboxSessionKey
          ? params.sessionKey
          : undefined,
      sessionId: params.sessionId,
      runId: params.runId,
      agentDir,
      agentAccountId: params.agentAccountId,
      messageProvider: resolvedMessageProvider,
      chatType: params.chatType,
      conversationToolPolicy: params.conversationToolPolicy,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      senderIsOwner: params.senderIsOwner,
      modelProvider: effectiveModel.provider,
      modelId,
      modelApi: effectiveModel.api,
      modelContextWindowTokens: contextTokenBudget,
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      spawnWorkspaceDir,
      skillsSnapshot: skillsSnapshotForRun,
      sandboxToolPolicy: sandbox?.tools,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
      pluginMetadataSnapshot: params.preparedModelRuntime.metadataSnapshot,
    });
    const toolsEnabled = supportsModelTools(effectiveModel);
    const toolsRaw = toolsEnabled
      ? createOpenClawCodingTools({
          exec: {
            ...params.execOverrides,
            config: params.config,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: resolvedMessageProvider,
          clientCaps: params.clientCaps,
          chatType: params.chatType,
          agentAccountId: params.agentAccountId,
          sessionKey: sandboxSessionKey,
          runSessionKey:
            params.sessionKey && params.sessionKey !== sandboxSessionKey
              ? params.sessionKey
              : undefined,
          sessionId: params.sessionId,
          runId: params.runId,
          oneShotCliRun: params.oneShotCliRun,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
          agentDir,
          cwd: effectiveCwd,
          workspaceDir: effectiveWorkspace,
          spawnWorkspaceDir,
          config: params.config,
          webSearchEnabled: params.toolOverrides?.webSearch !== false,
          abortSignal: runAbortController.signal,
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          modelProvider: effectiveModel.provider,
          modelId,
          modelHasVision: effectiveModel.input?.includes("image") ?? false,
          modelCompat: extractModelCompat(effectiveModel),
          modelApi: effectiveModel.api,
          modelContextWindowTokens: contextTokenBudget,
          skillsSnapshot: skillsSnapshotForRun,
          skillUsagePaths,
          conversationCapabilityProfile: runtimeCapabilityProfile,
          preparedModelRuntime: params.preparedModelRuntime,
          modelAuthMode: resolveModelAuthMode(effectiveModel.provider, params.config, undefined, {
            workspaceDir: effectiveWorkspace,
          }),
        })
      : [];
    const runtimePlanModelContext = {
      workspaceDir: effectiveWorkspace,
      modelApi: effectiveModel.api,
      model: effectiveModel,
    };
    const normalizableToolProjection = filterProviderNormalizableTools(
      toolsEnabled ? toolsRaw : [],
    );
    logRuntimeToolSchemaQuarantine({
      diagnostics: normalizableToolProjection.diagnostics,
      tools: toolsEnabled ? toolsRaw : [],
      runId,
      agentId: effectiveSkillAgentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    const tools = runtimePlan.tools.normalize(
      [...normalizableToolProjection.tools],
      runtimePlanModelContext,
    );
    bundleMcpRuntime = toolsEnabled
      ? await createBundleMcpToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: tools.map((tool) => tool.name),
        })
      : undefined;
    bundleLspRuntime = toolsEnabled
      ? await createBundleLspToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
        })
      : undefined;
    const filteredBundledTools = applyFinalEffectiveToolPolicy({
      bundledTools: [...(bundleMcpRuntime?.tools ?? []), ...(bundleLspRuntime?.tools ?? [])],
      config: params.config,
      // The same profile constructed the core tool set above, so core and
      // bundled tools cannot disagree about policy inputs (agentId included:
      // both resolve it from the session key inside the profile).
      conversationCapabilityProfile: runtimeCapabilityProfile,
      warn: (message) => log.warn(message),
    });
    const normalizableBundledToolProjection = filterProviderNormalizableTools(filteredBundledTools);
    if (normalizableBundledToolProjection.diagnostics.length > 0) {
      logRuntimeToolSchemaQuarantine({
        diagnostics: normalizableBundledToolProjection.diagnostics,
        tools: filteredBundledTools,
        runId,
        agentId: effectiveSkillAgentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
      });
    }
    const normalizedBundledTools =
      filteredBundledTools.length > 0
        ? runtimePlan.tools.normalize(
            [...normalizableBundledToolProjection.tools],
            runtimePlanModelContext,
          )
        : filteredBundledTools;
    const projectedEffectiveTools = [...tools, ...normalizedBundledTools];
    const toolSchemaProjection = filterRuntimeCompatibleTools(projectedEffectiveTools);
    logRuntimeToolSchemaQuarantine({
      diagnostics: toolSchemaProjection.diagnostics,
      tools: projectedEffectiveTools,
      runId,
      agentId: effectiveSkillAgentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    const effectiveTools = [...toolSchemaProjection.tools];
    const allowedToolNames = collectAllowedToolNames({ tools: effectiveTools });
    runtimePlan.tools.logDiagnostics(effectiveTools, runtimePlanModelContext);
    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    const runtimeCapabilities = collectRuntimeChannelCapabilities({
      cfg: params.config,
      channel: runtimeChannel,
      accountId: params.agentAccountId,
    });
    const reactionGuidance =
      runtimeChannel && params.config
        ? resolveChannelReactionGuidance({
            cfg: params.config,
            channel: runtimeChannel,
            accountId: params.agentAccountId,
          })
        : undefined;
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions(
          buildEmbeddedMessageActionDiscoveryInput({
            cfg: params.config,
            channel: runtimeChannel,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            accountId: params.agentAccountId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            senderId: params.senderId,
          }),
        )
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const runtimeInfo = {
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      host: machineName,
      os: resolveRuntimeOsLabel(),
      arch: os.arch(),
      node: process.version,
      model: `${provider}/${modelId}`,
      shell: detectRuntimeShell(),
      channel: runtimeChannel,
      chatType: params.chatType,
      capabilities: runtimeCapabilities,
      channelActions,
      activeProcessSessions: listActiveProcessSessionReferences({
        scopeKey: resolveProcessToolScopeKey({
          sessionKey: sandboxSessionKey,
          agentId: sessionAgentId,
        }),
      }),
      activeNode: formatActiveNodeContextLabel(getCurrentActiveNodeContext()),
    };
    const sandboxInfoExecPolicy = resolveEmbeddedSandboxInfoExecPolicy({
      config: params.config,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      sandboxAvailable: sandbox?.enabled === true,
      execOverrides: params.execOverrides,
    });
    const sandboxInfo = buildEmbeddedSandboxInfo(
      sandbox,
      params.bashElevated,
      sandboxInfoExecPolicy,
    );
    const reasoningTagHint = isReasoningTagProvider(provider, {
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId,
      modelApi: effectiveModel.api,
      model: effectiveModel,
    });
    const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
    const userDate = formatDateStamp(Date.now(), userTimezone);
    const promptSurface = resolveAgentPromptSurfaceForSessionKey(params.sessionKey);
    const promptMode =
      isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
        ? "minimal"
        : "full";
    const nativeCommandGuidanceLines = listRegisteredPluginAgentPromptGuidance({
      surface: promptSurface,
    });
    const openClawReferences = await resolveOpenClawReferencePaths({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: effectiveCwd,
      moduleUrl: import.meta.url,
    });
    const promptContributionContext: Parameters<
      AgentRuntimePlan["prompt"]["resolveSystemPromptContribution"]
    >[0] = {
      config: params.config,
      agentDir,
      workspaceDir: effectiveWorkspace,
      provider,
      modelId,
      promptMode,
      runtimeChannel,
      runtimeCapabilities,
      agentId: sessionAgentId,
    };
    const promptContribution =
      runtimePlan.prompt.resolveSystemPromptContribution(promptContributionContext);
    const preparedMemoryPrompt = await prepareAgentMemoryPrompt({
      enabled: promptMode === "full",
      toolNames: effectiveTools.map((tool) => tool.name),
      citationsMode: params.config?.memory?.citations,
      agentId: runtimeInfo.agentId,
      agentSessionKey: runtimeInfo.sessionKey,
      sandboxed: sandboxInfo?.enabled === true,
    });
    // Compaction must build byte-identical prompt sections to live turns, or
    // the compaction run misses the transcript's cached prompt prefix. The
    // allowlist doubles as the capability set so a session-read tool reachable
    // only through capability names gates the section the same way live turns do.
    const preparedWatchedSessions = prepareWatchedSessionsPrompt({
      enabled: promptMode === "full",
      config: params.config,
      sessionKey: params.sessionKey,
      sandboxed: sandboxInfo?.enabled === true,
      toolNames: effectiveTools.map((tool) => tool.name),
      capabilityToolNames: allowedToolNames,
    });
    const activeProjectKeys = params.preparedModelRuntime?.activeProjectKeys ?? [];
    const buildSystemPromptText = (defaultThinkLevel: ThinkLevel) => {
      const builtSystemPrompt = buildEmbeddedSystemPrompt({
        config: params.config,
        agentId: sessionAgentId,
        workspaceDir: effectiveWorkspace,
        defaultThinkLevel,
        reasoningLevel: params.reasoningLevel ?? "off",
        extraSystemPrompt: params.extraSystemPrompt,
        ownerNumbers: params.ownerNumbers,
        reasoningTagHint,
        heartbeatPrompt: resolveHeartbeatPromptForSystemPrompt({
          config: params.config,
          agentId: sessionAgentId,
          defaultAgentId,
        }),
        skillsPrompt,
        docsPath: openClawReferences.docsPath ?? undefined,
        sourcePath: openClawReferences.sourcePath ?? undefined,
        promptMode,
        promptSurface,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        acpEnabled: isAcpRuntimeSpawnAvailable({
          config: params.config,
          sandboxed: sandboxInfo?.enabled === true,
        }),
        runtimeInfo,
        reactionGuidance,
        messageToolHints,
        sandboxInfo,
        tools: effectiveTools,
        userTimezone,
        userDate,
        contextFiles,
        activeProjectKeys,
        preparedMemoryPrompt,
        preparedWatchedSessions,
        promptContribution,
        nativeCommandGuidanceLines,
      });
      return transformProviderSystemPrompt({
        provider,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        context: {
          config: params.config,
          agentDir,
          workspaceDir: effectiveWorkspace,
          provider,
          modelId,
          promptMode,
          runtimeChannel,
          runtimeCapabilities,
          agentId: sessionAgentId,
          systemPrompt: builtSystemPrompt,
        },
      });
    };

    return {
      ...prepared,
      contextTokenBudget,
      effectiveModel,
      runtimePlan,
      runtimePlanModelContext,
      runAbortController,
      effectiveTools,
      allowedToolNames,
      buildSystemPromptText,
      resolvedMessageProvider,
      sessionAgentId,
      disposeToolRuntimes,
      restoreSkillEnvironment,
      dispose,
    };
  } catch (err) {
    await dispose();
    throw err;
  }
}

export type PreparedCompactionRuntime = Awaited<ReturnType<typeof buildPreparedCompactionRuntime>>;
