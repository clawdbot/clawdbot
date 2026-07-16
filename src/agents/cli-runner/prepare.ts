import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
/**
 * Prepares CLI backend run context: backend config, prompts, bootstrap context,
 * MCP, auth epoch, and reusable session metadata.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../../config/config.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { CliBackendConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertContextEngineHostSupport,
  buildGenericCliContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  type McpLoopbackRequestContext,
} from "../../gateway/mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import { buildSystemAgentToolsMcpServerConfig } from "../../mcp/openclaw-tools-serve-config.js";
import { isClaudeCliProvider } from "../../plugin-sdk/anthropic-cli.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { resolveAgentConfig, resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { externalCliDiscoveryForProviderAuth } from "../auth-profiles/external-cli-discovery.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { loadAuthProfileStoreForRuntime } from "../auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
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
import { isPrimaryBootstrapRun, resolveWorkspaceBootstrapRouting } from "../bootstrap-routing.js";
import {
  CLI_AUTH_EPOCH_VERSION,
  resolveCliAuthBindingFingerprint,
  resolveCliAuthEpoch,
} from "../cli-auth-epoch.js";
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
import {
  prependSystemPromptAddition,
  resolveAttemptMediaTaskSystemPromptAddition,
} from "../embedded-agent-runner/run/attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "../embedded-agent-runner/run/attempt.thread-helpers.js";
import { buildCurrentInboundPrompt } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "../embedded-agent-runner/sandbox-skills.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import type { ResolvedProviderAuth } from "../model-auth-runtime-shared.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { collectRuntimeChannelCapabilities } from "../runtime-capabilities.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { appendModelIdentitySystemPrompt, buildModelIdentityPromptLine } from "../system-prompt.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceBootstrapPending as isWorkspaceBootstrapPendingImpl,
} from "../workspace.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { getClaudeLiveSessionGenerationForOwner } from "./claude-live-session.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import { buildCliAgentSystemPrompt, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import { CLAUDE_CLI_CONTEXT_MODEL_ALIASES, resolveNodeClaudePlacement } from "./prepare-claude.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";
import type { CliReusableSession, PreparedCliRunContext, RunCliAgentParams } from "./types.js";

function resolveClaudeCliContextModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  return CLAUDE_CLI_CONTEXT_MODEL_ALIASES[lower] ?? trimmed;
}
type RunCliAgentPrepareParams = RunCliAgentParams & {
  /** Ring-zero tool transport supplied only by the OpenClaw orchestrator. */
  systemAgentTool?: import("../tools/system-agent-tool.js").SystemAgentToolOptions;
};

const prepareDeps = {
  isWorkspaceBootstrapPending: isWorkspaceBootstrapPendingImpl,
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  resolveMcpLoopbackScopedTools,
  resolveOpenClawReferencePaths: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawReferencePaths>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawReferencePaths(params),
  prepareClaudeCliSkillsPlugin,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
  getClaudeLiveSessionGenerationForOwner,
  resolveApiKeyForProfile,
};

function resolveReusableCliSessionId(reusableCliSession: CliReusableSession): string | undefined {
  return reusableCliSession.mode === "reuse" || reusableCliSession.mode === "reuse-with-drift"
    ? reusableCliSession.sessionId
    : undefined;
}

function resolveCliSessionInvalidatedReason(
  reusableCliSession: CliReusableSession,
): Extract<CliReusableSession, { mode: "invalidate" }>["invalidatedReason"] | undefined {
  return reusableCliSession.mode === "invalidate"
    ? reusableCliSession.invalidatedReason
    : undefined;
}

function canTransportSystemPrompt(backend: CliBackendConfig): boolean {
  return (
    backend.systemPromptWhen !== "never" &&
    Boolean(
      backend.systemPromptArg || backend.systemPromptFileArg || backend.systemPromptFileConfigKey,
    )
  );
}

function normalizeOptionalMcpContextValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function buildCliMcpExecSession(
  sessionEntry: RunCliAgentParams["sessionEntry"],
): McpLoopbackRequestContext["execSession"] {
  const execSession = {
    execHost: normalizeOptionalMcpContextValue(sessionEntry?.execHost),
    execSecurity: normalizeOptionalMcpContextValue(sessionEntry?.execSecurity),
    execAsk: normalizeOptionalMcpContextValue(sessionEntry?.execAsk),
    execNode: normalizeOptionalMcpContextValue(sessionEntry?.execNode),
  };
  return Object.values(execSession).some(Boolean) ? execSession : undefined;
}

function buildCliMcpExecOverrides(
  execOverrides: RunCliAgentParams["execOverrides"],
): McpLoopbackRequestContext["execOverrides"] {
  if (!execOverrides) {
    return undefined;
  }
  const scopedOverrides = {
    ...(execOverrides.host !== undefined ? { host: execOverrides.host } : {}),
    ...(execOverrides.security !== undefined ? { security: execOverrides.security } : {}),
    ...(execOverrides.ask !== undefined ? { ask: execOverrides.ask } : {}),
    ...(execOverrides.node !== undefined ? { node: execOverrides.node } : {}),
  };
  return Object.keys(scopedOverrides).length > 0 ? scopedOverrides : undefined;
}

function buildCliMcpBashElevated(
  bashElevated: RunCliAgentParams["bashElevated"],
): McpLoopbackRequestContext["bashElevated"] {
  if (!bashElevated) {
    return undefined;
  }
  return {
    enabled: bashElevated.enabled,
    allowed: bashElevated.allowed,
    defaultLevel: bashElevated.defaultLevel,
    ...(bashElevated.fullAccessAvailable !== undefined
      ? { fullAccessAvailable: bashElevated.fullAccessAvailable }
      : {}),
    ...(bashElevated.fullAccessBlockedReason !== undefined
      ? { fullAccessBlockedReason: bashElevated.fullAccessBlockedReason }
      : {}),
  };
}

function buildCliMcpChannelContext(
  channelContext: RunCliAgentParams["channelContext"],
  senderId?: string | null,
): McpLoopbackRequestContext["channelContext"] {
  const resolvedSenderId =
    normalizeOptionalMcpContextValue(senderId ?? undefined) ??
    normalizeOptionalMcpContextValue(channelContext?.sender?.id);
  const chatId = normalizeOptionalMcpContextValue(channelContext?.chat?.id);
  if (!resolvedSenderId && !chatId) {
    return undefined;
  }
  return {
    ...(resolvedSenderId ? { sender: { id: resolvedSenderId } } : {}),
    ...(chatId ? { chat: { id: chatId } } : {}),
  };
}

function resolveCliMcpMessageProvider(
  run: Pick<RunCliAgentParams, "messageProvider" | "messageChannel">,
): string | undefined {
  return normalizeMessageChannel(run.messageProvider ?? run.messageChannel) ?? undefined;
}

function resolveCliMcpSessionKey(
  run: Pick<RunCliAgentParams, "sessionKey">,
  config: OpenClawConfig,
  agentId: string,
): string {
  return canonicalizeMainSessionAlias({
    cfg: config,
    agentId,
    sessionKey: run.sessionKey?.trim() || "main",
  });
}

function buildCliMcpGrantContext(params: {
  run: RunCliAgentParams;
  config: OpenClawConfig;
  requireExplicitMessageTarget: boolean;
  agentId: string;
  modelProvider: string;
  modelId: string;
}): McpLoopbackRequestContext {
  const sessionKey = resolveCliMcpSessionKey(params.run, params.config, params.agentId);
  const clientCaps = uniqueStrings(
    (params.run.clientCaps ?? []).map((cap) => cap.trim()).filter(Boolean),
  );
  const execSession = buildCliMcpExecSession(params.run.sessionEntry);
  const execOverrides = buildCliMcpExecOverrides(params.run.execOverrides);
  const bashElevated = buildCliMcpBashElevated(params.run.bashElevated);
  const channelContext = buildCliMcpChannelContext(params.run.channelContext, params.run.senderId);
  const senderName = normalizeOptionalMcpContextValue(params.run.senderName ?? undefined);
  const senderUsername = normalizeOptionalMcpContextValue(params.run.senderUsername ?? undefined);
  const senderE164 = normalizeOptionalMcpContextValue(params.run.senderE164 ?? undefined);
  const groupId = normalizeOptionalMcpContextValue(params.run.groupId ?? undefined);
  const groupChannel = normalizeOptionalMcpContextValue(params.run.groupChannel ?? undefined);
  const groupSpace = normalizeOptionalMcpContextValue(params.run.groupSpace ?? undefined);
  const spawnedBy = normalizeOptionalMcpContextValue(params.run.spawnedBy ?? undefined);
  return {
    sessionKey,
    runtimePolicySessionKey: normalizeOptionalMcpContextValue(params.run.runtimePolicySessionKey),
    agentId: params.agentId,
    sessionId: normalizeOptionalMcpContextValue(params.run.sessionId),
    runId: normalizeOptionalMcpContextValue(params.run.runId),
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    messageProvider: resolveCliMcpMessageProvider(params.run),
    clientCaps: clientCaps.length > 0 ? clientCaps : undefined,
    currentChannelId: normalizeOptionalMcpContextValue(params.run.currentChannelId),
    currentThreadTs: normalizeOptionalMcpContextValue(params.run.currentThreadTs),
    currentMessageId:
      params.run.currentMessageId == null
        ? undefined
        : normalizeOptionalMcpContextValue(String(params.run.currentMessageId)),
    currentInboundAudio: params.run.currentInboundAudio === true ? true : undefined,
    accountId: normalizeOptionalMcpContextValue(params.run.agentAccountId),
    inboundEventKind: params.run.currentInboundEventKind,
    sourceReplyDeliveryMode: params.run.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: params.run.taskSuggestionDeliveryMode,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget ? true : undefined,
    senderIsOwner: params.run.senderIsOwner === true,
    nodeExecAllowed: true,
    ...(execSession ? { execSession } : {}),
    ...(execOverrides ? { execOverrides } : {}),
    ...(bashElevated ? { bashElevated } : {}),
    ...(params.run.trigger ? { trigger: params.run.trigger } : {}),
    ...(normalizeOptionalMcpContextValue(params.run.approvalReviewerDeviceId)
      ? { approvalReviewerDeviceId: params.run.approvalReviewerDeviceId?.trim() }
      : {}),
    ...(channelContext ? { channelContext } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
    ...(senderE164 ? { senderE164 } : {}),
    ...(groupId ? { groupId } : {}),
    ...(groupChannel ? { groupChannel } : {}),
    ...(groupSpace ? { groupSpace } : {}),
    ...(spawnedBy ? { spawnedBy } : {}),
  };
}

function buildCliSessionDriftUserContext(
  reusableCliSession: CliReusableSession,
): string | undefined {
  if (reusableCliSession.mode !== "reuse-with-drift") {
    return undefined;
  }
  return `OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=${reusableCliSession.drift.reasons.join(",")}.`;
}

function prependCliSessionDriftUserContext(
  context: RunCliAgentParams["currentInboundContext"],
  reusableCliSession: CliReusableSession,
): RunCliAgentParams["currentInboundContext"] {
  const note = buildCliSessionDriftUserContext(reusableCliSession);
  if (!note) {
    return context;
  }
  if (!context) {
    return { text: note };
  }
  return {
    ...context,
    text: [note, context.text].join("\n\n"),
    ...(context.resumableText ? { resumableText: [note, context.resumableText].join("\n\n") } : {}),
  };
}

async function resolveCliSkillsPrompt(params: {
  agentId: string;
  config: RunCliAgentParams["config"];
  sessionKey: string;
  skillsSnapshot: RunCliAgentParams["skillsSnapshot"];
  workspaceDir: string;
}): Promise<string> {
  const sandboxWorkspace = await ensureSandboxWorkspaceForSession({
    config: params.config,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  });
  if (!sandboxWorkspace) {
    return resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      workspaceDir: params.workspaceDir,
      config: params.config,
      agentId: params.agentId,
    });
  }

  const {
    skillsEligibility,
    skillsPromptWorkspaceDir,
    skillsSnapshot: skillsSnapshotForRun,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: {
      enabled: true,
      ...(sandboxWorkspace.containerWorkdir
        ? { containerWorkdir: sandboxWorkspace.containerWorkdir }
        : {}),
      ...(sandboxWorkspace.skillsEligibility
        ? { skillsEligibility: sandboxWorkspace.skillsEligibility }
        : {}),
      ...(sandboxWorkspace.skillsWorkspaceDir
        ? { skillsWorkspaceDir: sandboxWorkspace.skillsWorkspaceDir }
        : {}),
      ...(sandboxWorkspace.workspaceAccess
        ? { workspaceAccess: sandboxWorkspace.workspaceAccess }
        : {}),
    },
    effectiveWorkspace: sandboxWorkspace.workspaceDir,
    skillsSnapshot: params.skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
    workspaceDir: skillsWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    eligibility: skillsEligibility,
    skillsSnapshot: skillsSnapshotForRun,
    workspaceOnly,
  });
  const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
    entries: shouldLoadSkillEntries ? skillEntries : undefined,
    skillsWorkspaceDir,
    skillsPromptWorkspaceDir,
  });
  return resolveSkillsPromptForRun({
    skillsSnapshot: skillsSnapshotForRun,
    entries: promptSkillEntries,
    workspaceDir: skillsPromptWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    eligibility: skillsEligibility,
  });
}

/** Overrides preparation dependencies for CLI runner tests. */
function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

/** Returns whether profile-owned prepared execution should skip local CLI epoch hashing. */
function shouldSkipLocalCliCredentialEpoch(params: {
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

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliRunnerPrepareTestApi")] = {
    setCliRunnerPrepareTestDeps: (overrides: Record<string, unknown>) => {
      setCliRunnerPrepareTestDeps(overrides as Partial<typeof prepareDeps>);
    },
  };
}

function shouldRefreshAuthProfileForExecution(params: {
  backendId: string;
  authProfileId?: string;
  authCredential?: AuthProfileCredential;
}): boolean {
  return Boolean(
    params.backendId === "google-gemini-cli" &&
    params.authProfileId &&
    (params.authCredential?.type === "oauth" ||
      params.authCredential?.type === "api_key" ||
      params.authCredential?.type === "token"),
  );
}

/** Builds the complete context required to execute a CLI-backed agent run. */
export async function prepareCliRunContext(
  params: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  const internalParams = params as RunCliAgentPrepareParams;
  const started = Date.now();
  const executionMode = params.executionMode ?? "agent";
  const isSideQuestion = executionMode === "side-question";
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
  const nodeClaudePlacement = resolveNodeClaudePlacement({
    backendId: backendResolved.id,
    execHost: params.sessionEntry?.execHost,
    execNode: params.sessionEntry?.execNode,
  });
  if (
    params.cliToolAvailability !== undefined &&
    (backendResolved.nativeToolMode !== "selectable" || !backendResolved.resolveExecutionArgs)
  ) {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot enforce exact per-run tool availability`,
    );
  }
  if (params.toolsAllow !== undefined) {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot enforce runtime toolsAllow; use an embedded runtime for restricted tool policy`,
    );
  }
  const sideQuestionDisablesNativeTools =
    isSideQuestion && backendResolved.sideQuestionToolMode === "disabled";
  const requestedNoNativeTools = params.cliToolAvailability?.native.length === 0;
  if (
    params.disableTools === true &&
    (backendResolved.nativeToolMode === "always-on" ||
      (backendResolved.nativeToolMode === "selectable" && !requestedNoNativeTools)) &&
    !sideQuestionDisablesNativeTools
  ) {
    throw new Error(
      `CLI backend ${backendResolved.id} cannot run with tools disabled because it exposes native tools`,
    );
  }
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentContextTokens = resolveAgentConfig(params.config ?? {}, sessionAgentId)?.contextTokens;
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  let effectiveAuthProfileId =
    requestedAuthProfileId ?? backendResolved.defaultAuthProfileId?.trim() ?? undefined;
  let authStore: AuthProfileStore | undefined;
  let authCredential: AuthProfileCredential | undefined;
  let resolvedProfileAuth: ResolvedProviderAuth | undefined;
  const loadScopedAuthStore = (options: { profileId?: string; readOnly?: boolean } = {}) =>
    loadAuthProfileStoreForRuntime(agentDir, {
      readOnly: options.readOnly ?? true,
      externalCli: externalCliDiscoveryForProviderAuth({
        cfg: params.config,
        provider: params.provider,
        ...(options.profileId ? { profileId: options.profileId } : {}),
      }),
    });
  if (effectiveAuthProfileId) {
    authStore = loadScopedAuthStore({ profileId: effectiveAuthProfileId });
    authCredential = authStore.profiles[effectiveAuthProfileId];
  } else if (
    backendResolved.authEpochMode === "profile-only" ||
    (backendResolved.prepareExecution && backendResolved.autoSelectAuthProfile !== false)
  ) {
    authStore = loadScopedAuthStore();
    effectiveAuthProfileId =
      resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider: params.provider,
      })[0]?.trim() || undefined;
    if (effectiveAuthProfileId) {
      authCredential = authStore.profiles[effectiveAuthProfileId];
    }
  }
  if (
    effectiveAuthProfileId &&
    shouldRefreshAuthProfileForExecution({
      backendId: backendResolved.id,
      authProfileId: effectiveAuthProfileId,
      authCredential,
    })
  ) {
    const authProfileId = effectiveAuthProfileId;
    const writableAuthStore = loadScopedAuthStore({ profileId: authProfileId, readOnly: false });
    const resolvedAuth = await prepareDeps.resolveApiKeyForProfile({
      cfg: params.config,
      store: writableAuthStore,
      profileId: authProfileId,
      agentDir,
    });
    const resolvedAuthProfileId = resolvedAuth?.profileId ?? authProfileId;
    const resolvedAuthCredential = resolvedAuth?.credential;
    authStore = loadScopedAuthStore({ profileId: resolvedAuthProfileId });
    authCredential = resolvedAuthCredential ?? authStore.profiles[resolvedAuthProfileId];
    if (resolvedAuth && authCredential) {
      effectiveAuthProfileId = resolvedAuthProfileId;
      resolvedProfileAuth = {
        apiKey: resolvedAuth.apiKey,
        profileId: resolvedAuthProfileId,
        source: `profile:${resolvedAuthProfileId}`,
        mode: resolvedAuth.profileType === "api_key" ? "api-key" : resolvedAuth.profileType,
      };
      // Apply resolved strings only to static credentials with secret refs.
      // OAuth CLI bridges need raw refreshed fields from the reloaded store.
      if (authCredential.type === "api_key") {
        authCredential = { ...authCredential, key: resolvedAuth.apiKey };
      } else if (authCredential.type === "token") {
        authCredential = { ...authCredential, token: resolvedAuth.apiKey };
      }
    }
  }
  const extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  const bindingFacts = params.cliSessionBindingFacts;
  const bindingExtraSystemPromptStatic =
    bindingFacts?.extraSystemPromptStatic ?? params.extraSystemPromptStatic;
  const baseExtraSystemPromptHash =
    bindingExtraSystemPromptStatic !== undefined
      ? hashCliSessionText(bindingExtraSystemPromptStatic.trim() || undefined)
      : hashCliSessionText(extraSystemPrompt);
  const toolBoundExtraSystemPromptHash = params.cliToolAvailability
    ? hashCliSessionText(
        JSON.stringify([
          baseExtraSystemPromptHash ?? null,
          params.cliToolAvailability.native.toSorted(),
          params.cliToolAvailability.mcp.toSorted(),
        ]),
      )
    : baseExtraSystemPromptHash;
  const requireExplicitMessageTarget =
    params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey);
  const hasCliSessionBindingFacts = bindingFacts !== undefined;
  const bindingRequireExplicitMessageTarget =
    bindingFacts?.requireExplicitMessageTarget ?? requireExplicitMessageTarget;
  const bindingSourceReplyDeliveryMode = hasCliSessionBindingFacts
    ? bindingFacts.sourceReplyDeliveryMode
    : params.sourceReplyDeliveryMode;
  const hasBindingMessageToolPolicy =
    bindingSourceReplyDeliveryMode !== undefined ||
    (hasCliSessionBindingFacts
      ? bindingFacts.requireExplicitMessageTarget !== undefined ||
        bindingRequireExplicitMessageTarget
      : params.requireExplicitMessageTarget !== undefined || bindingRequireExplicitMessageTarget);
  const messageToolPolicyHash = hasBindingMessageToolPolicy
    ? hashCliSessionText(
        JSON.stringify({
          sourceReplyDeliveryMode: bindingSourceReplyDeliveryMode,
          requireExplicitMessageTarget: bindingRequireExplicitMessageTarget,
        }),
      )
    : undefined;

  const modelId = (params.model ?? "default").trim() || "default";
  const modelProvider =
    normalizeOptionalMcpContextValue(params.modelProvider) ??
    normalizeOptionalMcpContextValue(params.provider) ??
    params.provider;
  const normalizedModel = normalizeCliModel(modelId, backendResolved.config);
  const modelDisplay = `${params.provider}/${modelId}`;
  const isClaudeCli = isClaudeCliProvider(params.provider);
  const requestedContextModelId = isClaudeCli ? resolveClaudeCliContextModelId(modelId) : modelId;
  const normalizedContextModelId = isClaudeCli
    ? resolveClaudeCliContextModelId(normalizedModel)
    : normalizedModel;
  // Aliases can map a canonical id to a CLI shorthand or a user shorthand to
  // a canonical id. Resolve both identities and keep the safest owned limit.
  const contextModelIds = [
    requestedContextModelId,
    ...(normalizedContextModelId !== requestedContextModelId ? [normalizedContextModelId] : []),
  ];
  const resolveContextModelTokens = (contextModelId: string, allowUnscopedModelLookup: boolean) =>
    resolveContextTokensForModel({
      cfg: params.config,
      provider: params.provider,
      modelProvider: backendResolved.modelProvider,
      model: contextModelId,
      allowAsyncLoad: false,
      allowUnscopedModelLookup,
    });
  let modelContextTokens: number | undefined;
  for (const contextModelId of contextModelIds) {
    const candidateContextTokens = resolveContextModelTokens(contextModelId, false);
    if (candidateContextTokens !== undefined) {
      modelContextTokens =
        modelContextTokens === undefined
          ? candidateContextTokens
          : Math.min(modelContextTokens, candidateContextTokens);
    }
  }
  // A process-wide bare-model cache has no provider provenance. If neither id
  // has owned metadata, prefer the actual CLI target over the requested alias.
  if (modelContextTokens === undefined) {
    for (const contextModelId of contextModelIds.toReversed()) {
      modelContextTokens = resolveContextModelTokens(contextModelId, true);
      if (modelContextTokens !== undefined) {
        break;
      }
    }
  }
  modelContextTokens ??= DEFAULT_CONTEXT_TOKENS;
  const resolvedContextWindowInfo = resolveContextWindowInfo({
    cfg: params.config,
    provider: params.provider,
    modelId,
    modelContextTokens,
    agentContextTokens,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  // The generic guard rechecks the requested id in config. An alias target may
  // have a tighter owned limit, so the alias-aware result remains an upper bound.
  const contextWindowInfo =
    resolvedContextWindowInfo.tokens > modelContextTokens
      ? { tokens: modelContextTokens, source: "model" as const }
      : resolvedContextWindowInfo;
  const autoReseedHistoryChars = isClaudeCli
    ? resolveAutoCliSessionReseedHistoryChars(contextWindowInfo.tokens)
    : undefined;

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { bootstrapFiles, contextFiles: resolvedContextFiles } = isSideQuestion
    ? { bootstrapFiles: [], contextFiles: [] }
    : await prepareDeps.resolveBootstrapContextForRun({
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
  // Mirror the embedded runner's bootstrap routing for backends that transport
  // OpenClaw's system prompt. Only a declared native-tool backend can complete
  // the file-based ritual; other backends receive limited guidance.
  const canonicalWorkspace = resolveUserPath(
    resolveAgentWorkspaceDir(params.config ?? {}, workspaceResolution.agentId),
  );
  const selectedNativeToolsProvideFileAccess =
    params.cliToolAvailability === undefined || params.cliToolAvailability.native.length > 0;
  const hasBootstrapFileAccess =
    (backendResolved.nativeToolMode === "always-on" ||
      backendResolved.nativeToolMode === "selectable") &&
    selectedNativeToolsProvideFileAccess &&
    params.disableTools !== true;
  const bootstrapRouting =
    isSideQuestion || !canTransportSystemPrompt(backendResolved.config)
      ? undefined
      : await resolveWorkspaceBootstrapRouting({
          isWorkspaceBootstrapPending: prepareDeps.isWorkspaceBootstrapPending,
          bootstrapFiles,
          bootstrapFilesProvideAccess: false,
          bootstrapContextRunKind: params.bootstrapContextRunKind,
          trigger: params.trigger,
          sessionKey: params.sessionKey,
          isPrimaryRun: isPrimaryBootstrapRun(params.sessionKey),
          isCanonicalWorkspace: canonicalWorkspace === resolvedWorkspace,
          effectiveWorkspace: workspaceDir,
          resolvedWorkspace,
          hasBootstrapFileAccess,
        });
  const bootstrapMode = bootstrapRouting?.bootstrapMode ?? "none";
  const includeBootstrapInSystemContext = bootstrapRouting?.includeBootstrapInSystemContext ?? true;
  const contextFiles = includeBootstrapInSystemContext
    ? resolvedContextFiles
    : resolvedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()));
  const bootstrapFilesForInjectionStats = includeBootstrapInSystemContext
    ? bootstrapFiles
    : bootstrapFiles.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME);
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config, sessionAgentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, sessionAgentId);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles: bootstrapFilesForInjectionStats,
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
  // Bootstrap guidance changes resumable system context. Hash the pending mode
  // so entering or leaving bootstrap refreshes first-only CLI system prompts.
  const extraSystemPromptHash =
    bootstrapMode === "none"
      ? toolBoundExtraSystemPromptHash
      : hashCliSessionText(JSON.stringify([toolBoundExtraSystemPromptHash ?? null, bootstrapMode]));
  // Ring-zero OpenClaw runs replace the bundle MCP surface entirely: no
  // loopback server, no plugin/user servers. A selectable backend also removes
  // its native tools, leaving only this openclaw stdio server.
  const systemAgentMcpConfig = internalParams.systemAgentTool
    ? buildSystemAgentToolsMcpServerConfig(internalParams.systemAgentTool)
    : undefined;
  const bundleMcpEnabled =
    !nodeClaudePlacement &&
    !isSideQuestion &&
    !systemAgentMcpConfig &&
    backendResolved.bundleMcp &&
    params.disableTools !== true;
  let mcpLoopbackRuntime = bundleMcpEnabled ? prepareDeps.getActiveMcpLoopbackRuntime() : undefined;
  if (bundleMcpEnabled && !mcpLoopbackRuntime) {
    try {
      await prepareDeps.ensureMcpLoopbackServer();
    } catch (error) {
      throw new Error(
        `Bundled MCP is enabled, but the OpenClaw MCP loopback server failed to start: ${String(error)}`,
        { cause: error },
      );
    }
    mcpLoopbackRuntime = prepareDeps.getActiveMcpLoopbackRuntime();
  }
  if (bundleMcpEnabled && !mcpLoopbackRuntime) {
    throw new Error(
      "Bundled MCP is enabled, but the OpenClaw MCP loopback server did not publish a runtime after startup.",
    );
  }
  const mcpDeliveryCaptureEnabled = bundleMcpEnabled && Boolean(mcpLoopbackRuntime);
  let cleanupPreparedResources: (() => Promise<void>) | undefined;
  let preparedExecution: Awaited<ReturnType<NonNullable<typeof backendResolved.prepareExecution>>> =
    undefined;
  try {
    const mcpClientGrant = mcpLoopbackRuntime
      ? prepareDeps.mintMcpLoopbackClientGrant({
          context: buildCliMcpGrantContext({
            run: params,
            config: params.config ?? getRuntimeConfig(),
            requireExplicitMessageTarget,
            agentId: sessionAgentId,
            modelProvider,
            modelId,
          }),
          runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
        })
      : undefined;
    const mcpClientGrantCapture =
      mcpClientGrant && mcpLoopbackRuntime
        ? {
            activate: (captureKey: string) => {
              const activated = prepareDeps.activateMcpLoopbackClientGrantCapture({
                token: mcpClientGrant.token,
                runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                captureKey,
              });
              if (!activated) {
                throw new Error("CLI MCP client grant is no longer valid for this Gateway runtime");
              }
            },
            deactivate: (captureKey: string) => {
              prepareDeps.deactivateMcpLoopbackClientGrantCapture({
                token: mcpClientGrant.token,
                runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                captureKey,
              });
            },
          }
        : undefined;
    let mcpClientGrantRevoked = false;
    const cleanupMcpClientGrant = mcpClientGrant
      ? async () => {
          if (mcpClientGrantRevoked) {
            return;
          }
          mcpClientGrantRevoked = true;
          prepareDeps.revokeMcpLoopbackClientGrant(mcpClientGrant.token);
        }
      : undefined;
    cleanupPreparedResources = cleanupMcpClientGrant;
    const preparedBackend = await prepareCliBundleMcpConfig({
      enabled: bundleMcpEnabled || systemAgentMcpConfig !== undefined,
      mode: backendResolved.bundleMcpMode,
      backend: backendResolved.config,
      workspaceDir,
      config: params.config,
      agentDir,
      ...(systemAgentMcpConfig ? { exclusiveConfig: systemAgentMcpConfig } : {}),
      additionalConfig: mcpLoopbackRuntime
        ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
        : undefined,
      env:
        mcpLoopbackRuntime && mcpClientGrant
          ? {
              OPENCLAW_MCP_TOKEN: mcpClientGrant.token,
              OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
            }
          : undefined,
      warn: (message) => cliBackendLog.warn(message),
    });
    const cleanupPreparedBackend =
      preparedBackend.cleanup || cleanupMcpClientGrant
        ? async () => {
            try {
              await preparedBackend.cleanup?.();
            } finally {
              await cleanupMcpClientGrant?.();
            }
          }
        : undefined;
    cleanupPreparedResources = cleanupPreparedBackend;
    const prepareExecutionContext = {
      config: params.config,
      workspaceDir,
      agentDir,
      provider: params.provider,
      modelId,
      contextTokenBudget: contextWindowInfo.tokens,
      authProfileId: effectiveAuthProfileId,
      executionMode,
      env: preparedBackend.env,
    } as Parameters<NonNullable<typeof backendResolved.prepareExecution>>[0];
    preparedExecution = nodeClaudePlacement
      ? undefined
      : await backendResolved.prepareExecution?.(
          (backendResolved.id === "google-gemini-cli"
            ? {
                ...prepareExecutionContext,
                // Private bridge for bundled Gemini CLI. This is intentionally not
                // part of the public Plugin SDK until a credential-forwarding
                // contract exists.
                authCredential,
              }
            : prepareExecutionContext) as typeof prepareExecutionContext & {
            authCredential?: AuthProfileCredential;
          },
        );
    const preparedBackendCleanup =
      cleanupPreparedBackend || preparedExecution?.cleanup
        ? async () => {
            try {
              await preparedExecution?.cleanup?.();
            } finally {
              await cleanupPreparedBackend?.();
            }
          }
        : undefined;
    cleanupPreparedResources = preparedBackendCleanup;
    const skipLocalCredentialEpoch = shouldSkipLocalCliCredentialEpoch({
      authEpochMode: backendResolved.authEpochMode,
      authProfileId: effectiveAuthProfileId,
      authCredential,
      preparedExecution,
    });
    const authEpoch = await resolveCliAuthEpoch({
      provider: params.provider,
      agentDir,
      authProfileId: effectiveAuthProfileId,
      skipLocalCredential: skipLocalCredentialEpoch,
    });
    const authBindingFingerprint = params.onSuccessfulAuthBinding
      ? resolveCliAuthBindingFingerprint({
          provider: params.provider,
          config: params.config ?? getRuntimeConfig(),
          agentDir,
          ...(effectiveAuthProfileId ? { authProfileId: effectiveAuthProfileId } : {}),
          ...(resolvedProfileAuth ? { resolvedAuth: resolvedProfileAuth } : {}),
          ...(skipLocalCredentialEpoch ? { skipLocalCredential: true } : {}),
        })
      : undefined;
    const preparedBackendEnv =
      preparedExecution?.env && Object.keys(preparedExecution.env).length > 0
        ? { ...preparedBackend.env, ...preparedExecution.env }
        : preparedBackend.env;
    const preparedBackendBeforeExecution =
      preparedBackend.beforeExecution || preparedExecution?.beforeExecution
        ? async () => {
            await preparedBackend.beforeExecution?.();
            await preparedExecution?.beforeExecution?.();
          }
        : undefined;
    const claudeSkillsPlugin =
      isSideQuestion || nodeClaudePlacement
        ? { args: [], cleanup: async () => {} }
        : await prepareDeps.prepareClaudeCliSkillsPlugin({
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
    cleanupPreparedResources = preparedCleanup ?? preparedBackendCleanup;
    const preparedBackendClearEnv = [
      ...(preparedBackend.backend.clearEnv ?? []),
      ...(preparedExecution?.clearEnv ?? []),
    ];
    const sideQuestionBackend = (() => {
      const { liveSession: _liveSession, ...backend } = preparedBackend.backend;
      return {
        ...backend,
        sessionMode: "none" as const,
      };
    })();
    const processPerTurnBackend = (() => {
      const { liveSession: _liveSession, ...backend } = preparedBackend.backend;
      return backend;
    })();
    const preparedBackendFinal = {
      ...preparedBackend,
      backend: {
        ...(isSideQuestion
          ? sideQuestionBackend
          : params.disableCliLiveSession
            ? processPerTurnBackend
            : preparedBackend.backend),
        ...(preparedBackendClearEnv.length > 0
          ? { clearEnv: uniqueStrings(preparedBackendClearEnv) }
          : {}),
      },
      ...(preparedBackendEnv ? { env: preparedBackendEnv } : {}),
      ...(preparedBackendBeforeExecution
        ? { beforeExecution: preparedBackendBeforeExecution }
        : {}),
      ...(mcpClientGrantCapture ? { mcpClientGrantCapture } : {}),
      ...(preparedCleanup ? { cleanup: preparedCleanup } : {}),
    };
    const promptTools =
      bundleMcpEnabled && mcpLoopbackRuntime
        ? prepareDeps.resolveMcpLoopbackScopedTools({
            cfg: params.config ?? getRuntimeConfig(),
            sessionKey: resolveCliMcpSessionKey(
              params,
              params.config ?? getRuntimeConfig(),
              sessionAgentId,
            ),
            runtimePolicySessionKey: normalizeOptionalMcpContextValue(
              params.runtimePolicySessionKey,
            ),
            agentId: sessionAgentId,
            messageProvider: resolveCliMcpMessageProvider(params),
            clientCaps: params.clientCaps,
            currentChannelId: params.currentChannelId,
            // CLI binding hashes omit per-message facts, but identity, owner, and
            // model policy must match the runtime MCP grant's advertised tools.
            currentThreadTs: undefined,
            currentMessageId: undefined,
            currentInboundAudio: undefined,
            accountId: params.agentAccountId,
            inboundEventKind: undefined,
            sourceReplyDeliveryMode: bindingSourceReplyDeliveryMode,
            taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
            requireExplicitMessageTarget: bindingRequireExplicitMessageTarget,
            senderIsOwner: params.senderIsOwner === true,
            nodeExecAllowed: true,
            modelProvider,
            modelId,
            execSession: buildCliMcpExecSession(params.sessionEntry),
            execOverrides: buildCliMcpExecOverrides(params.execOverrides),
            bashElevated: buildCliMcpBashElevated(params.bashElevated),
            trigger: params.trigger,
            approvalReviewerDeviceId: normalizeOptionalMcpContextValue(
              params.approvalReviewerDeviceId,
            ),
            channelContext: buildCliMcpChannelContext(params.channelContext, params.senderId),
            senderName: normalizeOptionalMcpContextValue(params.senderName ?? undefined),
            senderUsername: normalizeOptionalMcpContextValue(params.senderUsername ?? undefined),
            senderE164: normalizeOptionalMcpContextValue(params.senderE164 ?? undefined),
            groupId: normalizeOptionalMcpContextValue(params.groupId ?? undefined),
            groupChannel: normalizeOptionalMcpContextValue(params.groupChannel ?? undefined),
            groupSpace: normalizeOptionalMcpContextValue(params.groupSpace ?? undefined),
            spawnedBy: normalizeOptionalMcpContextValue(params.spawnedBy ?? undefined),
          }).tools
        : [];
    const promptToolNamesHash =
      bundleMcpEnabled && mcpLoopbackRuntime
        ? hashCliSessionText(JSON.stringify(promptTools.map((tool) => tool.name).toSorted()))
        : undefined;
    // `sessionMode: none` may still use a live transport in-process, but neither a
    // returned nor previously stored id is authority for cross-process continuity.
    const ignoreCliSessionCandidate =
      isSideQuestion || preparedBackendFinal.backend.sessionMode === "none";
    const reusableCliSessionCandidate: CliReusableSession = ignoreCliSessionCandidate
      ? { mode: "none" }
      : params.cliSessionBinding
        ? resolveCliSessionReuse({
            binding: params.cliSessionBinding,
            authProfileId: effectiveAuthProfileId,
            authEpoch,
            authEpochVersion: CLI_AUTH_EPOCH_VERSION,
            extraSystemPromptHash,
            messageToolPolicyHash,
            promptToolNamesHash,
            cwdHash,
            mcpConfigHash: preparedBackendFinal.mcpConfigHash,
            mcpResumeHash: preparedBackendFinal.mcpResumeHash,
          })
        : params.cliSessionId
          ? { mode: "reuse", sessionId: params.cliSessionId }
          : { mode: "none" };
    const backendReusableCliSession: CliReusableSession =
      reusableCliSessionCandidate.mode === "reuse-with-drift" &&
      !canTransportSystemPrompt(preparedBackendFinal.backend)
        ? { mode: "invalidate", invalidatedReason: "system-prompt" }
        : reusableCliSessionCandidate;
    const candidateClaudeCliSessionId =
      resolveReusableCliSessionId(backendReusableCliSession)?.trim() || undefined;
    const hasClaudeCliCandidate =
      !nodeClaudePlacement &&
      candidateClaudeCliSessionId !== undefined &&
      isClaudeCliProvider(params.provider);
    const claudeCliTranscriptMissing =
      hasClaudeCliCandidate &&
      !(await prepareDeps.claudeCliSessionTranscriptHasContent({
        sessionId: candidateClaudeCliSessionId,
        workspaceDir: cwd,
      }));
    const managedClaudeLiveSessionGeneration =
      claudeCliTranscriptMissing &&
      backendResolved.id === "claude-cli" &&
      "liveSession" in preparedBackendFinal.backend &&
      preparedBackendFinal.backend.liveSession === "claude-stdio" &&
      preparedBackendFinal.backend.output === "jsonl" &&
      preparedBackendFinal.backend.input === "stdin" &&
      prepareDeps.getClaudeLiveSessionGenerationForOwner({
        backendId: backendResolved.id,
        agentAccountId: params.agentAccountId,
        agentId: params.agentId,
        authProfileId: effectiveAuthProfileId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
    const hasManagedClaudeLiveSession = Boolean(managedClaudeLiveSessionGeneration);
    const claudeCliTranscriptOrphanedToolUse =
      hasClaudeCliCandidate &&
      !claudeCliTranscriptMissing &&
      (await prepareDeps.claudeCliSessionTranscriptHasOrphanedToolUse({
        sessionId: candidateClaudeCliSessionId,
        workspaceDir: cwd,
      }));
    const claudeCliInvalidatedReason: "missing-transcript" | "orphaned-tool-use" | undefined =
      claudeCliTranscriptMissing && !hasManagedClaudeLiveSession
        ? "missing-transcript"
        : claudeCliTranscriptOrphanedToolUse
          ? "orphaned-tool-use"
          : undefined;
    const reusableCliSession: CliReusableSession = claudeCliInvalidatedReason
      ? { mode: "invalidate", invalidatedReason: claudeCliInvalidatedReason }
      : backendReusableCliSession;
    const reusableCliSessionId = resolveReusableCliSessionId(reusableCliSession);
    const invalidatedReason = resolveCliSessionInvalidatedReason(reusableCliSession);
    if (invalidatedReason) {
      cliBackendLog.info(
        `cli session reset: provider=${params.provider} reason=${invalidatedReason}`,
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
    const heartbeatPrompt =
      isSideQuestion || params.bootstrapContextRunKind === "commitment-only"
        ? undefined
        : resolveHeartbeatPromptForSystemPrompt({
            config: params.config,
            agentId: sessionAgentId,
            defaultAgentId,
          });
    const openClawReferences = isSideQuestion
      ? { docsPath: null, sourcePath: null }
      : await prepareDeps.resolveOpenClawReferencePaths({
          workspaceDir,
          argv1: process.argv[1],
          cwd,
          moduleUrl: import.meta.url,
        });
    const systemPromptSkillsPrompt =
      isSideQuestion || nodeClaudePlacement || claudeSkillsPlugin.args.length > 0
        ? ""
        : await resolveCliSkillsPrompt({
            skillsSnapshot: params.skillsSnapshot,
            workspaceDir,
            config: params.config,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey?.trim() || params.sessionId,
          });
    const runtimeChannel = isSideQuestion
      ? undefined
      : normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    const runtimeCapabilities = isSideQuestion
      ? undefined
      : collectRuntimeChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        });
    const builtSystemPrompt = isSideQuestion
      ? extraSystemPrompt
      : buildCliAgentSystemPrompt({
          workspaceDir,
          cwd,
          config: params.config,
          defaultThinkLevel: params.thinkLevel,
          extraSystemPrompt,
          sourceReplyDeliveryMode: bindingSourceReplyDeliveryMode,
          requireExplicitMessageTarget: bindingRequireExplicitMessageTarget,
          silentReplyPromptMode: params.silentReplyPromptMode,
          runtimeChannel,
          runtimeChatType: params.sessionEntry?.chatType,
          runtimeCapabilities,
          ownerNumbers: params.ownerNumbers,
          heartbeatPrompt,
          docsPath: openClawReferences.docsPath ?? undefined,
          sourcePath: openClawReferences.sourcePath ?? undefined,
          skillsPrompt: systemPromptSkillsPrompt,
          tools: promptTools,
          contextFiles,
          bootstrapMode,
          modelDisplay,
          agentId: sessionAgentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
        });
    const transformedSystemPrompt = !isSideQuestion
      ? (backendResolved.transformSystemPrompt?.({
          config: params.config,
          workspaceDir,
          provider: params.provider,
          modelId,
          modelDisplay,
          agentId: sessionAgentId,
          systemPrompt: builtSystemPrompt,
        }) ?? builtSystemPrompt)
      : builtSystemPrompt;
    let systemPrompt = transformedSystemPrompt;
    let preparedPrompt = params.prompt;
    if (!isSideQuestion) {
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
          bootstrapContextRunKind: params.bootstrapContextRunKind,
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
            prependSystemContext: hookResult.prependSystemContext,
            appendSystemContext: hookResult.appendSystemContext,
          }) ?? systemPrompt;
        const mediaTaskSystemPromptAddition = resolveAttemptMediaTaskSystemPromptAddition({
          sessionKey: params.sessionKey,
          trigger: params.trigger,
        });
        if (mediaTaskSystemPromptAddition) {
          systemPrompt = prependSystemPromptAddition({
            systemPrompt: ensureSystemPromptCacheBoundary(systemPrompt),
            systemPromptAddition: mediaTaskSystemPromptAddition,
          });
        }
      } catch (error) {
        cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
      }
    }
    let historyPromptCurrentTurn = preparedPrompt;
    if (!isSideQuestion) {
      const currentInboundContext = prependCliSessionDriftUserContext(
        params.currentInboundContext,
        reusableCliSession,
      );
      const fullCurrentInboundPrompt = buildCurrentInboundPrompt({
        context: currentInboundContext,
        prompt: preparedPrompt,
      });
      const runCurrentInboundPrompt = buildCurrentInboundPrompt({
        context: currentInboundContext,
        prompt: preparedPrompt,
        preferResumableText:
          params.currentInboundEventKind === "room_event" && Boolean(reusableCliSessionId),
      });
      historyPromptCurrentTurn = annotateInterSessionPromptText(
        fullCurrentInboundPrompt,
        params.inputProvenance,
      );
      preparedPrompt = annotateInterSessionPromptText(
        runCurrentInboundPrompt,
        params.inputProvenance,
      );
    }
    const allowRawTranscriptReseed =
      backendResolved.config.reseedFromRawTranscriptWhenUncompacted === true;
    const rawTranscriptReseedReason = reusableCliSessionId ? "session-expired" : invalidatedReason;
    // Node placement keeps this: the history prompt is built from the
    // gateway-side OpenClaw transcript, so a fresh remote CLI session still
    // receives prior conversation context via stdin.
    const shouldPrepareOpenClawHistoryPrompt =
      !isSideQuestion && (!reusableCliSessionId || allowRawTranscriptReseed);
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
    const systemPromptWithReplacements = applyPluginTextReplacements(
      systemPrompt,
      backendResolved.textTransforms?.input,
    );
    // Ensure the cache boundary before appending the model identity so the identity lands in the
    // dynamic suffix, not the cached prefix, for marker-free hook overrides — otherwise an idle
    // turn's prefix (O + identity) diverges from an active media turn's prefix (O) and breaks
    // prompt caching. Skip empty prompts and turns with no identity line, which need no boundary.
    systemPrompt = isSideQuestion
      ? systemPromptWithReplacements
      : appendModelIdentitySystemPrompt({
          systemPrompt:
            buildModelIdentityPromptLine(modelDisplay) &&
            systemPromptWithReplacements.trim().length > 0
              ? ensureSystemPromptCacheBoundary(systemPromptWithReplacements)
              : systemPromptWithReplacements,
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
      bootstrapFiles: bootstrapFilesForInjectionStats,
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
    if (isSideQuestion) {
      const preparedParams: RunCliAgentParams = {
        ...params,
        config: contextEngineConfig,
        prompt: preparedPrompt,
        ...(requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
      };

      return {
        params: preparedParams,
        effectiveAuthProfileId,
        agentDir,
        started,
        workspaceDir,
        cwd,
        backendResolved,
        preparedBackend: preparedBackendFinal,
        reusableCliSession,
        hadSessionFile: false,
        contextEngineConfig,
        modelId,
        normalizedModel,
        contextWindowInfo,
        systemPrompt,
        systemPromptReport,
        claudeSkillsPluginArgs: claudeSkillsPlugin.args,
        bootstrapPromptWarningLines: bootstrapPromptWarning.lines,
        authEpoch,
        authBindingFingerprint,
        ...(skipLocalCredentialEpoch ? { authBindingSkipsLocalCredential: true } : {}),
        authEpochVersion: CLI_AUTH_EPOCH_VERSION,
        extraSystemPromptHash,
        messageToolPolicyHash,
        promptToolNamesHash,
        cwdHash,
        ...(mcpDeliveryCaptureEnabled ? { mcpDeliveryCapture: true } : {}),
      };
    }
    ensureContextEnginesInitialized();
    const { sessionAgentId: contextEngineSessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: contextEngineConfig,
      agentId: params.agentId,
    });
    // Context remains session-owned. Trusted helper runs may borrow a different
    // agentDir only for model/auth execution.
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
      ...(requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
    };

    return {
      params: preparedParams,
      effectiveAuthProfileId,
      agentDir,
      started,
      workspaceDir,
      cwd,
      backendResolved,
      preparedBackend: preparedBackendFinal,
      reusableCliSession,
      ...(managedClaudeLiveSessionGeneration
        ? { requiredClaudeLiveSessionGeneration: managedClaudeLiveSessionGeneration }
        : {}),
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
      authBindingFingerprint,
      ...(skipLocalCredentialEpoch ? { authBindingSkipsLocalCredential: true } : {}),
      authEpochVersion: CLI_AUTH_EPOCH_VERSION,
      extraSystemPromptHash,
      messageToolPolicyHash,
      promptToolNamesHash,
      cwdHash,
      ...(mcpDeliveryCaptureEnabled ? { mcpDeliveryCapture: true } : {}),
    };
  } catch (err) {
    try {
      await cleanupPreparedResources?.();
    } catch (cleanupErr) {
      cliBackendLog.warn(`cli backend cleanup after prepare failure failed: ${String(cleanupErr)}`);
    }
    throw err;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
