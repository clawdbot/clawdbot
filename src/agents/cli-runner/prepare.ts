import { getRuntimeConfig } from "../../config/config.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
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
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../pi-embedded-helpers.js";
import { resolvePromptBuildHookResult } from "../pi-embedded-runner/run/attempt.prompt-helpers.js";
import { resolveAttemptPrependSystemContext } from "../pi-embedded-runner/run/attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "../pi-embedded-runner/run/attempt.thread-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveSkillsPromptForRun } from "../skills.js";
import { resolveSystemPromptOverride } from "../system-prompt-override.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { buildSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import {
  buildCliSessionHistoryPrompt,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
} from "./session-history.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const prepareDeps = {
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  resolveOpenClawReferencePaths: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawReferencePaths>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawReferencePaths(params),
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
  const agentDir = resolveOpenClawAgentDir();
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  const effectiveAuthProfileId =
    requestedAuthProfileId ?? backendResolved.defaultAuthProfileId?.trim() ?? undefined;
  let authCredential: AuthProfileCredential | undefined;
  if (effectiveAuthProfileId) {
    const authStore = loadAuthProfileStoreForRuntime(agentDir, {
      readOnly: true,
      allowKeychainPrompt: false,
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
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  let mcpLoopbackRuntime = backendResolved.bundleMcp
    ? prepareDeps.getActiveMcpLoopbackRuntime()
    : undefined;
  if (backendResolved.bundleMcp && !mcpLoopbackRuntime) {
    try {
      await prepareDeps.ensureMcpLoopbackServer();
    } catch (error) {
      cliBackendLog.warn(`mcp loopback server failed to start: ${String(error)}`);
    }
    mcpLoopbackRuntime = prepareDeps.getActiveMcpLoopbackRuntime();
  }
  const preparedBackend = await prepareCliBundleMcpConfig({
    enabled: backendResolved.bundleMcp,
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
  const reusableCliSession = params.cliSessionBinding
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
  const loadOpenClawHistoryMessages = () => {
    openClawHistoryMessages ??= loadCliSessionHistoryMessages({
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
    buildSystemPrompt({
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
      messages: loadOpenClawHistoryMessages(),
      hookCtx: {
        runId: params.runId,
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspaceDir,
        modelProviderId: params.provider,
        modelId,
        messageProvider: params.messageProvider,
        trigger: params.trigger,
        channelId: params.messageChannel ?? params.messageProvider,
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
  preparedPrompt = annotateInterSessionPromptText(preparedPrompt, params.inputProvenance);
  const openClawHistoryPrompt = reusableCliSession.sessionId
    ? undefined
    : buildCliSessionHistoryPrompt({
        messages: loadCliSessionReseedMessages({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          config: params.config,
        }),
        prompt: preparedPrompt,
      });
  systemPrompt = applyPluginTextReplacements(systemPrompt, backendResolved.textTransforms?.input);
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
