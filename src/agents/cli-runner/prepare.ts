import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../../config/config.js";
import {
  assertContextEngineHostSupport,
  buildGenericCliContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  resolveMcpLoopbackBearerToken,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import { isClaudeCliProvider } from "../../plugin-sdk/anthropic-cli.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { externalCliDiscoveryForProviderAuth } from "../auth-profiles/external-cli-discovery.js";
import { loadAuthProfileStoreForRuntime } from "../auth-profiles/store.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import {
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  buildBootstrapTruncationReportMeta,
  analyzeBootstrapBudget,
} from "../bootstrap-budget.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { CLI_AUTH_EPOCH_VERSION, resolveCliAuthEpoch } from "../cli-auth-epoch.js";
import { resolveCliBackendConfig } from "../cli-backends.js";
import { hashCliSessionText, resolveCliSessionReuse } from "../cli-session.js";
import {
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
} from "../command/attempt-execution.helpers.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { resolveContextTokensForModel } from "../context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../embedded-agent-helpers.js";
import { resolvePromptBuildHookResult } from "../embedded-agent-runner/run/attempt.prompt-helpers.js";
import { resolveAttemptPrependSystemContext } from "../embedded-agent-runner/run/attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "../embedded-agent-runner/run/attempt.thread-helpers.js";
import { buildCurrentInboundPrompt } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { appendModelIdentitySystemPrompt } from "../system-prompt.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import { buildCliAgentSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";
import type { CliReusableSession, PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  resolveMcpLoopbackBearerToken,
  resolveMcpLoopbackScopedTools,
  resolveOpenClawReferencePaths: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawReferencePaths>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawReferencePaths(params),
  prepareClaudeCliSkillsPlugin,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
};

const CLAUDE_CLI_CONTEXT_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  "opus-4.8": "claude-opus-4-8",
  "opus-4-8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4-7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "opus-4-6": "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4-6": "claude-sonnet-4-6",
};

function resolveClaudeCliContextModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  return CLAUDE_CLI_CONTEXT_MODEL_ALIASES[lower] ?? trimmed;
}

export function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

export function shouldSkipLocalCliCredentialEpoch(params: {
  authEpochMode?: CliBackendAuthEpochMode;
  authProfileId?: string;
  authCredential?: AuthProfileCredential;
  preparedExecution?: CliBackendPreparedExecution | null;
}): boolean {
  return Boolean(
    params.authEpochMode === "profile-only" &&
    params.authProfileId &&
    params.authCredential &&
    params.preparedExecution,
  );
}

export async function prepareCliRunContext(
  params: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    cliBackendLog.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;
  const cwd = params.cwd ? resolveUserPath(params.cwd) : workspaceDir;
  const cwdHash = hashCliSessionText(cwd);

  const backendResolved = resolveCliBackendConfig(params.provider, params.config, {
    agentId: params.agentId,
  });
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  if (params.toolsAllow !== undefined) {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot enforce runtime toolsAllow; use an embedded runtime for restricted tool policy`,
    );
  }
  if (params.disableTools === true && backendResolved.nativeToolMode === "always-on") {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot run with tools disabled because it exposes native tools`,
    );
  }
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir = resolveAgentDir(params.config ?? {}, sessionAgentId);
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  const effectiveAuthProfileId =
    requestedAuthProfileId ?? backendResolved.defaultAuthProfileId?.trim() ?? undefined;
  let authCredential: AuthProfileCredential | undefined;
  if (effectiveAuthProfileId) {
    const authStore = loadAuthProfileStoreForRuntime(agentDir, {
      readOnly: true,
      externalCli: externalCliDiscoveryForProviderAuth({
        provider: params.provider,
        profileId: effectiveAuthProfileId,
      }),
    });
    authCredential = authStore.profiles[effectiveAuthProfileId];
  }
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  // Use the static portion (excluding per-message inbound metadata) for session reuse hashing.
  // Per-message metadata (timestamps, message IDs) changes every turn and must not trigger session resets.
  const extraSystemPromptHash =
    params.extraSystemPromptStatic !== undefined
      ? hashCliSessionText(params.extraSystemPromptStatic.trim() || undefined)
      : hashCliSessionText(extraSystemPrompt);

  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backendResolved.config);
  const modelDisplay = `${params.provider}/${modelId}`;
  const isClaudeCli = isClaudeCliProvider(params.provider);
  const modelContextTokens = isClaudeCli
    ? resolveContextTokensForModel({
        cfg: params.config,
        provider: params.provider,
        model: resolveClaudeCliContextModelId(modelId),
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      })
    : undefined;
  const contextWindowInfo = resolveContextWindowInfo({
    cfg: params.config,
    provider: params.provider,
    modelId,
    modelContextTokens,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  const autoReseedHistoryChars = isClaudeCli
    ? resolveAutoCliSessionReseedHistoryChars(contextWindowInfo.tokens)
    : undefined;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await prepareDeps.resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: sessionAgentId,
    contextMode: params.bootstrapContextMode,
    runKind: params.bootstrapContextRunKind,
    warn: prepareDeps.makeBootstrapWarn({
      sessionLabel,
      workspaceDir,
      warn: (message) => cliBackendLog.warn(message),
    }),
  });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config, sessionAgentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, sessionAgentId);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(params.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const bundleMcpEnabled = backendResolved.bundleMcp && params.disableTools !== true;
  let mcpLoopbackRuntime = bundleMcpEnabled ? prepareDeps.getActiveMcpLoopbackRuntime() : undefined;
  if (bundleMcpEnabled && !mcpLoopbackRuntime) {
    try {
      await prepareDeps.ensureMcpLoopbackServer();
    } catch (error) {
      cliBackendLog.warn(`mcp loopback server failed to start: ${String(error)}`);
    }
    mcpLoopbackRuntime = prepareDeps.getActiveMcpLoopbackRuntime();
  }
  const preparedBackend = await prepareCliBundleMcpConfig({
    enabled: bundleMcpEnabled,
    mode: backendResolved.bundleMcpMode,
    backend: backendResolved.config,
    workspaceDir,
    config: params.config,
    additionalConfig: mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined,
    env: mcpLoopbackRuntime
      ? {
          OPENCLAW_MCP_TOKEN: prepareDeps.resolveMcpLoopbackBearerToken(
            mcpLoopbackRuntime,
            params.senderIsOwner === true,
          ),
          OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
          OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
          OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
          OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageChannel ?? params.messageProvider ?? "",
          OPENCLAW_MCP_CURRENT_CHANNEL_ID: params.currentChannelId ?? "",
          OPENCLAW_MCP_CURRENT_THREAD_TS: params.currentThreadTs ?? "",
          OPENCLAW_MCP_CURRENT_MESSAGE_ID:
            params.currentMessageId != null ? String(params.currentMessageId) : "",
          OPENCLAW_MCP_INBOUND_EVENT_KIND: params.currentInboundEventKind ?? "",
          OPENCLAW_MCP_SOURCE_REPLY_DELIVERY_MODE: params.sourceReplyDeliveryMode ?? "",
        }
      : undefined,
    warn: (message) => cliBackendLog.warn(message),
  });
  const preparedExecution = await backendResolved.prepareExecution?.({
    config: params.config,
    workspaceDir,
    agentDir,
    provider: params.provider,
    modelId,
    authProfileId: effectiveAuthProfileId,
  });
  const skipLocalCredentialEpoch = shouldSkipLocalCliCredentialEpoch({
    authEpochMode: backendResolved.authEpochMode,
    authProfileId: effectiveAuthProfileId,
    authCredential,
    preparedExecution,
  });
  const authEpoch = await resolveCliAuthEpoch({
    provider: params.provider,
    authProfileId: effectiveAuthProfileId,
    skipLocalCredential: skipLocalCredentialEpoch,
  });
  const preparedBackendEnv =
    preparedExecution?.env && Object.keys(preparedExecution.env).length > 0
      ? { ...preparedBackend.env, ...preparedExecution.env }
      : preparedBackend.env;
  const preparedBackendCleanup =
    preparedBackend.cleanup || preparedExecution?.cleanup
      ? async () => {
          try {
            await preparedExecution?.cleanup?.();
          } finally {
            await preparedBackend.cleanup?.();
          }
        }
      : undefined;
  const claudeSkillsPlugin = await prepareDeps.prepareClaudeCliSkillsPlugin({
    backendId: backendResolved.id,
    skillsSnapshot: params.skillsSnapshot,
  });
  const preparedCleanup =
    preparedBackendCleanup || claudeSkillsPlugin.args.length > 0
      ? async () => {
          try {
            await claudeSkillsPlugin.cleanup();
          } finally {
            await preparedBackendCleanup?.();
          }
        }
      : undefined;
  const preparedBackendClearEnv = [
    ...(preparedBackend.backend.clearEnv ?? []),
    ...(preparedExecution?.clearEnv ?? []),
  ];
  const preparedBackendFinal = {
    ...preparedBackend,
    backend: {
      ...preparedBackend.backend,
      ...(preparedBackendClearEnv.length > 0
        ? { clearEnv: uniqueStrings(preparedBackendClearEnv) }
        : {}),
    },
    ...(preparedBackendEnv ? { env: preparedBackendEnv } : {}),
    ...(preparedCleanup ? { cleanup: preparedCleanup } : {}),
  };
  const promptTools =
    bundleMcpEnabled && mcpLoopbackRuntime
      ? prepareDeps.resolveMcpLoopbackScopedTools({
          cfg: params.config ?? getRuntimeConfig(),
          sessionKey: params.sessionKey ?? "",
          messageProvider: params.messageChannel ?? params.messageProvider,
          currentChannelId: params.currentChannelId,
          currentThreadTs: params.currentThreadTs,
          currentMessageId: params.currentMessageId,
          accountId: params.agentAccountId,
          inboundEventKind: params.currentInboundEventKind,
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          senderIsOwner: params.senderIsOwner,
        }).tools
      : [];
  const promptToolNamesHash =
    bundleMcpEnabled && mcpLoopbackRuntime
      ? hashCliSessionText(JSON.stringify(promptTools.map((tool) => tool.name).toSorted()))
      : undefined;
  const reusableCliSessionCandidate: CliReusableSession = params.cliSessionBinding
    ? resolveCliSessionReuse({
        binding: params.cliSessionBinding,
        authProfileId: effectiveAuthProfileId,
        authEpoch,
        authEpochVersion: CLI_AUTH_EPOCH_VERSION,
        extraSystemPromptHash,
        promptToolNamesHash,
        cwdHash,
        mcpConfigHash: preparedBackendFinal.mcpConfigHash,
        mcpResumeHash: preparedBackendFinal.mcpResumeHash,
      })
    : params.cliSessionId
      ? { sessionId: params.cliSessionId }
      : {};
  const candidateClaudeCliSessionId = reusableCliSessionCandidate.sessionId?.trim() || undefined;
  const hasClaudeCliCandidate =
    candidateClaudeCliSessionId !== undefined && isClaudeCliProvider(params.provider);
  const claudeCliTranscriptMissing =
    hasClaudeCliCandidate &&
    !(await prepareDeps.claudeCliSessionTranscriptHasContent({
      sessionId: candidateClaudeCliSessionId,
      workspaceDir: cwd,
    }));
  const claudeCliTranscriptOrphanedToolUse =
    hasClaudeCliCandidate &&
    !claudeCliTranscriptMissing &&
    (await prepareDeps.claudeCliSessionTranscriptHasOrphanedToolUse({
      sessionId: candidateClaudeCliSessionId,
      workspaceDir: cwd,
    }));
  const claudeCliInvalidatedReason: CliReusableSession["invalidatedReason"] | undefined =
    claudeCliTranscriptMissing
      ? "missing-transcript"
      : claudeCliTranscriptOrphanedToolUse
        ? "orphaned-tool-use"
        : undefined;
  const reusableCliSession: CliReusableSession = claudeCliInvalidatedReason
    ? { invalidatedReason: claudeCliInvalidatedReason }
    : reusableCliSessionCandidate;
  if (reusableCliSession.invalidatedReason) {
    cliBackendLog.info(
      `cli session reset: provider=${params.provider} reason=${reusableCliSession.invalidatedReason}`,
    );
  }
  let openClawHistoryMessages: unknown[] | undefined;
  const loadOpenClawHistoryMessages = async () => {
    openClawHistoryMessages ??= await loadCliSessionHistoryMessages({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: params.config,
    });
    return openClawHistoryMessages;
  };
  const heartbeatPrompt = resolveHeartbeatPromptForSystemPrompt({
    config: params.config,
    agentId: sessionAgentId,
    defaultAgentId,
  });
  const openClawReferences = await prepareDeps.resolveOpenClawReferencePaths({
    workspaceDir,
    argv1: process.argv[1],
    cwd,
    moduleUrl: import.meta.url,
  });
  const skillsPrompt = resolveSkillsPromptForRun({
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir,
    config: params.config,
    agentId: sessionAgentId,
  });
  const systemPromptSkillsPrompt = claudeSkillsPlugin.args.length > 0 ? "" : skillsPrompt;
  const builtSystemPrompt = buildCliAgentSystemPrompt({
    workspaceDir,
    cwd,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    silentReplyPromptMode: params.silentReplyPromptMode,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: openClawReferences.docsPath ?? undefined,
    sourcePath: openClawReferences.sourcePath ?? undefined,
    skillsPrompt: systemPromptSkillsPrompt,
    tools: promptTools,
    contextFiles,
    modelDisplay,
    agentId: sessionAgentId,
  });
  const transformedSystemPrompt =
    backendResolved.transformSystemPrompt?.({
      config: params.config,
      workspaceDir,
      provider: params.provider,
      modelId,
      modelDisplay,
      agentId: sessionAgentId,
      systemPrompt: builtSystemPrompt,
    }) ?? builtSystemPrompt;
  let systemPrompt = transformedSystemPrompt;
  let preparedPrompt = params.prompt;
  const hookRunner = getGlobalHookRunner();
  try {
    const hookResult = await resolvePromptBuildHookResult({
      config: params.config ?? getRuntimeConfig(),
      prompt: params.prompt,
      messages: await loadOpenClawHistoryMessages(),
      hookCtx: {
        runId: params.runId,
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspaceDir,
        modelProviderId: params.provider,
        modelId,
        trigger: params.trigger,
        ...buildAgentHookContextChannelFields(params),
      },
      hookRunner,
    });
    if (hookResult.prependContext) {
      preparedPrompt = `${hookResult.prependContext}\n\n${preparedPrompt}`;
    }
    if (hookResult.appendContext) {
      preparedPrompt = `${preparedPrompt}\n\n${hookResult.appendContext}`;
    }
    const hookSystemPrompt = hookResult.systemPrompt?.trim();
    if (hookSystemPrompt) {
      systemPrompt = hookSystemPrompt;
    }
    systemPrompt =
      composeSystemPromptWithHookContext({
        baseSystemPrompt: systemPrompt,
        prependSystemContext: resolveAttemptPrependSystemContext({
          sessionKey: params.sessionKey,
          trigger: params.trigger,
          hookPrependSystemContext: hookResult.prependSystemContext,
        }),
        appendSystemContext: hookResult.appendSystemContext,
      }) ?? systemPrompt;
  } catch (error) {
    cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
  }
  const fullCurrentInboundPrompt = buildCurrentInboundPrompt({
    context: params.currentInboundContext,
    prompt: preparedPrompt,
  });
  const runCurrentInboundPrompt = buildCurrentInboundPrompt({
    context: params.currentInboundContext,
    prompt: preparedPrompt,
    preferResumableText:
      params.currentInboundEventKind === "room_event" && Boolean(reusableCliSession.sessionId),
  });
  const historyPromptCurrentTurn = annotateInterSessionPromptText(
    fullCurrentInboundPrompt,
    params.inputProvenance,
  );
  preparedPrompt = annotateInterSessionPromptText(runCurrentInboundPrompt, params.inputProvenance);
  const allowRawTranscriptReseed =
    backendResolved.config.reseedFromRawTranscriptWhenUncompacted === true;
  const rawTranscriptReseedReason = reusableCliSession.sessionId
    ? "session-expired"
    : reusableCliSession.invalidatedReason;
  const shouldPrepareOpenClawHistoryPrompt =
    !reusableCliSession.sessionId || allowRawTranscriptReseed;
  const openClawHistoryPrompt = shouldPrepareOpenClawHistoryPrompt
    ? buildCliSessionHistoryPrompt({
        messages: await loadCliSessionReseedMessages({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          config: params.config,
          allowRawTranscriptReseed,
          rawTranscriptReseedReason,
        }),
        prompt: historyPromptCurrentTurn,
        maxHistoryChars: autoReseedHistoryChars,
      })
    : undefined;
  systemPrompt = appendModelIdentitySystemPrompt({
    systemPrompt: applyPluginTextReplacements(systemPrompt, backendResolved.textTransforms?.input),
    model: modelDisplay,
  });
  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: modelId,
    workspaceDir,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    bootstrapTruncation: buildBootstrapTruncationReportMeta({
      analysis: bootstrapAnalysis,
      warningMode: bootstrapPromptWarningMode,
      warning: bootstrapPromptWarning,
    }),
    sandbox: { mode: "off", sandboxed: false },
    systemPrompt,
    bootstrapFiles,
    injectedFiles: contextFiles,
    skillsPrompt: systemPromptSkillsPrompt,
    tools: promptTools,
    currentTurn: {
      ...(params.currentInboundEventKind ? { kind: params.currentInboundEventKind } : {}),
      promptChars: preparedPrompt.length,
      runtimeContextChars: 0,
    },
  });
  const contextEngineConfig = params.config ?? getRuntimeConfig();
  try {
    ensureContextEnginesInitialized();
    const { sessionAgentId: contextEngineSessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: contextEngineConfig,
      agentId: params.agentId,
    });
    const contextEngineAgentDir = resolveAgentDir(contextEngineConfig, contextEngineSessionAgentId);
    const resolvedContextEngine = await resolveContextEngine(contextEngineConfig, {
      agentDir: contextEngineAgentDir,
      workspaceDir,
    });
    const contextEngine =
      resolvedContextEngine.info.id !== "legacy" ? resolvedContextEngine : undefined;
    if (contextEngine) {
      assertContextEngineHostSupport({
        contextEngine,
        operation: "agent-run",
        host: buildGenericCliContextEngineHostSupport({
          backendId: backendResolved.id,
          capabilities: backendResolved.contextEngineHostCapabilities,
        }),
      });
    }
    const hadSessionFile = await hasCliSessionTranscript({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      config: contextEngineConfig,
    });
    const contextEngineTurnPrompt = params.transcriptPrompt ?? params.prompt;
    const preparedParams: RunCliAgentParams = {
      ...params,
      config: contextEngineConfig,
      prompt: preparedPrompt,
    };

    return {
      params: preparedParams,
      effectiveAuthProfileId,
      started,
      workspaceDir,
      cwd,
      backendResolved,
      preparedBackend: preparedBackendFinal,
      reusableCliSession,
      hadSessionFile,
      contextEngineConfig,
      contextEngine,
      contextEngineTurnPrompt,
      modelId,
      normalizedModel,
      contextWindowInfo,
      systemPrompt,
      systemPromptReport,
      claudeSkillsPluginArgs: claudeSkillsPlugin.args,
      bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
      ...(openClawHistoryPrompt ? { openClawHistoryPrompt } : {}),
      heartbeatPrompt,
      authEpoch,
      authEpochVersion: CLI_AUTH_EPOCH_VERSION,
      extraSystemPromptHash,
      promptToolNamesHash,
      cwdHash,
    };
  } catch (err) {
    try {
      await preparedBackendFinal.cleanup?.();
    } catch (cleanupErr) {
      cliBackendLog.warn(`cli backend cleanup after prepare failure failed: ${String(cleanupErr)}`);
    }
    throw err;
  }
}
