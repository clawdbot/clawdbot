import { getRuntimeConfig } from "../../config/config.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { isClaudeCliProvider } from "../../plugin-sdk/anthropic-cli.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
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
import { claudeCliSessionTranscriptHasContent } from "../command/attempt-execution.helpers.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../pi-embedded-helpers.js";
import { resolvePromptBuildHookResult } from "../pi-embedded-runner/run/attempt.prompt-helpers.js";
import { resolveAttemptPrependSystemContext } from "../pi-embedded-runner/run/attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "../pi-embedded-runner/run/attempt.thread-helpers.js";
import { buildCurrentTurnPrompt } from "../pi-embedded-runner/run/runtime-context-prompt.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveSkillsPromptForRun } from "../skills.js";
import { resolveSystemPromptOverride } from "../system-prompt-override.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { appendModelIdentitySystemPrompt } from "../system-prompt.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { buildCliAgentSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import {
  buildCliSessionHistoryPrompt,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
} from "./session-history.js";
import type { CliReusableSession, PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  resolveOpenClawReferencePaths: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawReferencePaths>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawReferencePaths(params),
  // Surfaced as a dep so tests can stub the on-disk Claude CLI transcript probe
  // without touching ~/.claude/projects.
  claudeCliSessionTranscriptHasContent,
};

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

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles } = await prepareDeps.resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: prepareDeps.makeBootstrapWarn({
      sessionLabel,
      workspaceDir,
      warn: (message) => cliBackendLog.warn(message),
    }),
  });
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config);
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
          OPENCLAW_MCP_TOKEN:
            params.senderIsOwner === true
              ? mcpLoopbackRuntime.ownerToken
              : mcpLoopbackRuntime.nonOwnerToken,
          OPENCLAW_MCP_AGENT_ID: sessionAgentId ?? "",
          OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
          OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
          OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageChannel ?? params.messageProvider ?? "",
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
  const preparedBackendClearEnv = [
    ...(preparedBackend.backend.clearEnv ?? []),
    ...(preparedExecution?.clearEnv ?? []),
  ];
  const preparedBackendFinal = {
    ...preparedBackend,
    backend: {
      ...preparedBackend.backend,
      ...(preparedBackendClearEnv.length > 0
        ? { clearEnv: Array.from(new Set(preparedBackendClearEnv)) }
        : {}),
    },
    ...(preparedBackendEnv ? { env: preparedBackendEnv } : {}),
    ...(preparedBackendCleanup ? { cleanup: preparedBackendCleanup } : {}),
  };
  // Pre-flight: if a saved Claude CLI sessionId points at a transcript that no
  // longer exists on disk (e.g. update.run aborted mid-swap, Claude CLI was
  // reinstalled, or the projects tree was manually pruned), `claude --resume`
  // hangs or fails outside the cli-runner session_expired path. The persisted
  // binding then never gets refreshed, causing every subsequent turn to retry
  // the same dead sessionId. Drop the binding here so this turn starts fresh
  // and the post-run flow writes the new sessionId back via setCliSessionBinding.
  const candidateClaudeCliSessionId =
    params.cliSessionBinding?.sessionId?.trim() || params.cliSessionId?.trim() || undefined;
  const claudeCliTranscriptMissing =
    candidateClaudeCliSessionId !== undefined &&
    isClaudeCliProvider(params.provider) &&
    !(await prepareDeps.claudeCliSessionTranscriptHasContent({
      sessionId: candidateClaudeCliSessionId,
    }));
  const reusableCliSession: CliReusableSession = claudeCliTranscriptMissing
    ? { invalidatedReason: "missing-transcript" }
    : params.cliSessionBinding
      ? resolveCliSessionReuse({
          binding: params.cliSessionBinding,
          authProfileId: effectiveAuthProfileId,
          authEpoch,
          authEpochVersion: CLI_AUTH_EPOCH_VERSION,
          extraSystemPromptHash,
          mcpConfigHash: preparedBackendFinal.mcpConfigHash,
          mcpResumeHash: preparedBackendFinal.mcpResumeHash,
        })
      : params.cliSessionId
        ? { sessionId: params.cliSessionId }
        : {};
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
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const skillsPrompt = resolveSkillsPromptForRun({
    skillsSnapshot: params.skillsSnapshot,
    workspaceDir,
    config: params.config,
    agentId: sessionAgentId,
  });
  const builtSystemPrompt =
    resolveSystemPromptOverride({
      config: params.config,
      agentId: sessionAgentId,
    }) ??
    buildCliAgentSystemPrompt({
      workspaceDir,
      config: params.config,
      defaultThinkLevel: params.thinkLevel,
      extraSystemPrompt,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      silentReplyPromptMode: params.silentReplyPromptMode,
      ownerNumbers: params.ownerNumbers,
      heartbeatPrompt,
      docsPath: openClawReferences.docsPath ?? undefined,
      sourcePath: openClawReferences.sourcePath ?? undefined,
      skillsPrompt,
      tools: [],
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
  preparedPrompt = buildCurrentTurnPrompt({
    context: params.currentTurnContext,
    prompt: preparedPrompt,
  });
  preparedPrompt = annotateInterSessionPromptText(preparedPrompt, params.inputProvenance);
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
        prompt: preparedPrompt,
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
    skillsPrompt,
    tools: [],
  });

  return {
    params: preparedPrompt === params.prompt ? params : { ...params, prompt: preparedPrompt },
    effectiveAuthProfileId,
    started,
    workspaceDir,
    backendResolved,
    preparedBackend: preparedBackendFinal,
    reusableCliSession,
    modelId,
    normalizedModel,
    systemPrompt,
    systemPromptReport,
    bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
    ...(openClawHistoryPrompt ? { openClawHistoryPrompt } : {}),
    heartbeatPrompt,
    authEpoch,
    authEpochVersion: CLI_AUTH_EPOCH_VERSION,
    extraSystemPromptHash,
  };
}
