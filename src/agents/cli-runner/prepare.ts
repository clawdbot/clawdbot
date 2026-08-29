import { ensureSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
/**
 * Prepares CLI backend run context: backend config, prompts, bootstrap context,
 * MCP, auth epoch, and reusable session metadata.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertContextEngineHostSupport,
  buildGenericCliContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import {
  activateMcpLoopbackClientGrantCapture,
  bindMcpLoopbackClientGrantAdmission,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import { ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import { buildSystemAgentToolsMcpServerConfig } from "../../mcp/openclaw-tools-serve-config.js";
import { CliBackendAuthProfilePreparationError } from "../../plugins/cli-backend-errors.js";
import type {
  CliBackendConfig,
  CliBackendAuthEpochMode,
  CliBackendPreparedExecution,
} from "../../plugins/cli-backend.types.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  resolveAdmittedRunActiveAssertion,
  resolvePreparedRunAdmission,
} from "../admitted-run-context.js";
import { hasAgentRosterProperty, resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../agent-scope.js";
import { hasUsableOAuthCredential } from "../auth-profiles/credential-state.js";
import { externalCliDiscoveryForProviderAuth } from "../auth-profiles/external-cli-discovery.js";
import { buildOAuthRefreshFailureLoginCommand } from "../auth-profiles/oauth-refresh-failure.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import {
  loadAuthProfileStoreForRuntime,
  resolveRuntimeAuthProfileAgentDir,
} from "../auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import {
  buildBootstrapBudgetState,
  buildBootstrapPromptWarningNotice,
  buildBootstrapTruncationReportMeta,
} from "../bootstrap-budget.js";
import {
  makeBootstrapWarn as makeBootstrapWarnImpl,
  resolveBootstrapContextForRun as resolveBootstrapContextForRunImpl,
} from "../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
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
  resolvePromptBuildHookResult,
  prependSystemPromptAddition,
  resolveAttemptMediaTaskSystemPromptAddition,
} from "../embedded-agent-runner/run/attempt-prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "../embedded-agent-runner/run/attempt-thread-helpers.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
} from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildCurrentInboundPrompt } from "../embedded-agent-runner/run/runtime-context-prompt.js";
import {
  mapSandboxSkillEntriesForPrompt,
  resolveSandboxSkillRuntimeInputs,
} from "../embedded-agent-runner/sandbox-skills.js";
import { selectContextEngineForTranscriptHost } from "../harness/context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "../harness/context-engine-turn-attempt.js";
import type { ResolvedProviderAuth } from "../model-auth-runtime-shared.js";
import { findModelCatalogEntry, loadManifestModelCatalog } from "../model-catalog.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../model-context-window.js";
import { recordAdmittedModelRoutingDecision } from "../model-routing-decision.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { collectRuntimeChannelCapabilities } from "../runtime-capabilities.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox.js";
import { buildSystemPromptReport } from "../system-prompt-report.js";
import { appendModelIdentitySystemPrompt, buildModelIdentityPromptLine } from "../system-prompt.js";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  isWorkspaceBootstrapPending as isWorkspaceBootstrapPendingImpl,
} from "../workspace.js";
import { CliAuthProfilePreparationError } from "./auth-profile-preparation-error.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import {
  resolveBundledCliBackendAuthPolicy,
  type BundledCliBackendAuthPolicy,
} from "./cli-backend-auth-policy.js";
import { getCliLiveSessionGeneration } from "./cli-live-session-registry.js";
import { buildCliAgentSystemPrompt, isClaudeCliBackendId, normalizeCliModel } from "./helpers.js";
import { cliBackendLog } from "./log.js";
import { buildCliMcpGrantContext, normalizeOptionalMcpContextValue } from "./mcp-grant-context.js";
import { CLAUDE_CLI_CONTEXT_MODEL_ALIASES, detectNodeClaudePlacement } from "./prepare-claude.js";
import {
  buildCliSessionHistoryPrompt,
  hasCliSessionTranscript,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  resolveAutoCliSessionReseedHistoryChars,
} from "./session-history.js";
import type {
  CliReusableSession,
  CliSecretInput,
  PreparedCliRunContext,
  RunCliAgentParams,
} from "./types.js";

type PrivateCliBackendPreparedExecution = CliBackendPreparedExecution & {
  isolatedCompletionEnforced?: true;
  secretInput?: CliSecretInput;
};

function unsupportedIsolatedCompletionError(backendId: string): Error & { code: "unsupported" } {
  const error = new Error(
    `CLI backend "${backendId}" does not support isolated completion; OpenClaw did not start the run.`,
  ) as Error & { code: "unsupported" };
  error.name = "IsolatedCompletionUnsupportedError";
  error.code = "unsupported";
  return error;
}

function resolveClaudeCliContextModelId(modelId: string): string {
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  return CLAUDE_CLI_CONTEXT_MODEL_ALIASES[lower] ?? trimmed;
}
type RunCliAgentPrepareParams = RunCliAgentParams & {
  /** Ring-zero tool transport supplied only by the OpenClaw orchestrator. */
  systemAgentTool?: import("../tools/system-agent-tool.js").SystemAgentToolOptions;
};

const defaultPrepareDeps = {
  isWorkspaceBootstrapPending: isWorkspaceBootstrapPendingImpl,
  makeBootstrapWarn: makeBootstrapWarnImpl,
  resolveBootstrapContextForRun: resolveBootstrapContextForRunImpl,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  createMcpLoopbackServerConfig,
  activateMcpLoopbackClientGrantCapture,
  bindMcpLoopbackClientGrantAdmission,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools,
  resolveOpenClawReferencePaths: async (
    params: Parameters<typeof import("../docs-path.js").resolveOpenClawReferencePaths>[0],
  ) => (await import("../docs-path.js")).resolveOpenClawReferencePaths(params),
  prepareClaudeCliSkillsPlugin,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
  getCliLiveSessionGeneration,
  resolveApiKeyForProfile,
  loadManifestModelCatalog,
};
const prepareDeps = { ...defaultPrepareDeps };

function findSelectableContextWindowEntry(params: {
  catalog: ModelCatalogEntry[];
  providers: string[];
  models: string[];
}): ModelCatalogEntry | undefined {
  for (const provider of params.providers) {
    for (const model of params.models) {
      const entry = findModelCatalogEntry(params.catalog, { provider, modelId: model });
      if (entry?.contextWindows?.length) {
        return entry;
      }
    }
  }
  return undefined;
}

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
    const { shouldLoadSkillEntries, skillEntries, loadSkillEntries, preserveEntryOrder } =
      resolveEmbeddedRunSkillEntries({
        workspaceDir: params.workspaceDir,
        config: params.config,
        agentId: params.agentId,
        skillsSnapshot: params.skillsSnapshot,
      });
    return resolveSkillsPrompt({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      loadEntries: loadSkillEntries,
      workspaceDir: params.workspaceDir,
      config: params.config,
      agentId: params.agentId,
      preserveEntryOrder,
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
    skillsAnchorWorkspace: sandboxWorkspace.workspaceDir,
    skillsSnapshot: params.skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries, preserveEntryOrder } =
    resolveEmbeddedRunSkillEntries({
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
  return resolveSkillsPrompt({
    skillsSnapshot: skillsSnapshotForRun,
    entries: promptSkillEntries,
    workspaceDir: skillsPromptWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    eligibility: skillsEligibility,
    preserveEntryOrder,
  });
}

/** Overrides preparation dependencies for CLI runner tests. */
function setCliRunnerPrepareTestDeps(overrides: Partial<typeof prepareDeps>): void {
  Object.assign(prepareDeps, overrides);
}

/** Restores preparation dependencies after CLI runner tests. */
function resetCliRunnerPrepareTestDeps(): void {
  Object.assign(prepareDeps, defaultPrepareDeps);
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
    resetCliRunnerPrepareTestDeps,
    setCliRunnerPrepareTestDeps: (overrides: Record<string, unknown>) => {
      setCliRunnerPrepareTestDeps(overrides as Partial<typeof prepareDeps>);
    },
  };
}

function shouldRefreshAuthProfileForExecution(params: {
  policy?: BundledCliBackendAuthPolicy;
  authProfileId?: string;
  authCredential?: AuthProfileCredential;
}): boolean {
  if (!params.policy || !params.authProfileId || !params.authCredential) {
    return false;
  }
  if (params.authCredential.type === "oauth") {
    return params.policy.oauthRefreshOwner === "core";
  }
  return params.authCredential.type === "api_key" || params.authCredential.type === "token";
}

type CliAuthProfileResolutionFailure =
  | { kind: "unmaterialized" }
  | { kind: "resolved-as-other"; resolvedProfileId: string };

function describeCliAuthProfileResolutionFailure(
  profileId: string,
  failure: CliAuthProfileResolutionFailure,
): string {
  switch (failure.kind) {
    case "resolved-as-other":
      return `selected auth profile "${profileId}" resolved as "${failure.resolvedProfileId}"`;
    case "unmaterialized":
      return `could not materialize selected auth profile "${profileId}"`;
  }
  return failure satisfies never;
}

function buildCliAuthProfileResolutionError(params: {
  backendId: string;
  profileId: string;
  provider: string;
  agentDir: string;
  failure: CliAuthProfileResolutionFailure;
}): CliAuthProfilePreparationError {
  const loginCommand = buildOAuthRefreshFailureLoginCommand(params.provider, {
    profileId: params.profileId,
  });
  const reason = describeCliAuthProfileResolutionFailure(params.profileId, params.failure);
  return new CliAuthProfilePreparationError({
    message: `CLI backend "${params.backendId}" ${reason}. Re-authenticate with: ${loginCommand}. OpenClaw did not start the run.`,
    profileId: params.profileId,
    provider: params.provider,
    agentDir: params.agentDir,
  });
}

/** Builds the complete context required to execute a CLI-backed agent run. */
export async function prepareCliRunContext(
  inputParams: RunCliAgentParams,
): Promise<PreparedCliRunContext> {
  let params = inputParams.config ? inputParams : { ...inputParams, config: getRuntimeConfig() };
  const runConfig = params.config!;
  const sessionOwner = normalizeAgentId(
    parseAgentSessionKey(params.sessionKey)?.agentId ||
      params.agentId?.trim() ||
      LEGACY_IMPLICIT_AGENT_ID,
  );
  // Direct CLI-runner callers predate roster-aware ownership. Adapt that SDK
  // input only for strict workspace admission; keep the original config object
  // for backend hooks, sandboxing, and context-engine identity contracts.
  const workspaceConfig = hasAgentRosterProperty(runConfig)
    ? runConfig
    : ({
        ...runConfig,
        agents: {
          ...runConfig.agents,
          entries: { [sessionOwner]: { default: true } },
        },
      } satisfies OpenClawConfig);
  const started = Date.now();
  const executionMode = params.executionMode ?? "agent";
  const isSideQuestion = executionMode === "side-question";
  const isControlOperation = params.controlOperation !== undefined;
  // Control bytes must reach the resumed backend without turn hooks, prompts,
  // tools, MCP, skills, or context-engine setup changing their execution.
  const skipsTurnPreparation = isSideQuestion || isControlOperation;
  const admitPreparedParams = async (
    candidate: RunCliAgentParams,
  ): Promise<
    RunCliAgentParams & { admittedRunContext: NonNullable<RunCliAgentParams["admittedRunContext"]> }
  > => {
    const admittedRunContext = await resolvePreparedRunAdmission({
      runId: candidate.runId,
      runtimeKind: "embedded",
      admittedRunContext: candidate.admittedRunContext,
      preparedRunAdmission: candidate.preparedRunAdmission,
    });
    const { preparedRunAdmission: _preparedRunAdmission, ...rest } = candidate;
    return { ...rest, agentId: workspaceResolution.agentId, admittedRunContext };
  };
  const runtimeChatType = params.chatType ?? params.sessionEntry?.chatType;
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: sessionOwner,
    config: workspaceConfig,
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

  // params.agentId may identify a distinct runtime-policy requester. Backend
  // config and managed process reuse must key from the resolved session owner.
  const backendResolved = resolveCliBackendConfig(params.provider, params.config, {
    agentId: workspaceResolution.agentId,
  });
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const backendAuthPolicy = resolveBundledCliBackendAuthPolicy(backendResolved.id);
  const canEnforceExactToolAvailability =
    backendResolved.nativeToolMode === "selectable" &&
    ((backendResolved.toolAvailabilityEnforcement === "execution-args" &&
      backendResolved.resolveExecutionArgs !== undefined) ||
      (backendResolved.toolAvailabilityEnforcement === "prepare-execution" &&
        backendResolved.prepareExecution !== undefined));
  let runtimeToolsAllowPolicy: string[] | undefined;
  if (params.toolsAllow !== undefined) {
    if (params.cliToolAvailability !== undefined) {
      throw new Error(
        `CLI backend ${backendResolved.id} received conflicting runtime tool policies`,
      );
    }
    if (params.toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")) {
      params = { ...params, toolsAllow: undefined };
    } else {
      runtimeToolsAllowPolicy = [...params.toolsAllow];
      const fallbackOpenClawTools = uniqueStrings(
        expandToolGroups(params.toolsAllow)
          .map((toolName) => normalizeToolPolicyName(toolName))
          .filter(Boolean),
      );
      if (
        fallbackOpenClawTools.includes("write") &&
        !fallbackOpenClawTools.includes("apply_patch")
      ) {
        fallbackOpenClawTools.push("apply_patch");
      }
      params = {
        ...params,
        toolsAllow: undefined,
        cliToolAvailability: {
          native: [],
          // Preserve the prior normalized fallback for modes without a catalog;
          // catalog-backed paths replace it with exact names below.
          openClaw: fallbackOpenClawTools,
        },
      };
    }
  }
  if (params.disableTools === true && !isSideQuestion && canEnforceExactToolAvailability) {
    // Selectable backends need the exact empty cap as well as the generic flag;
    // otherwise their native tools remain selectable and the run must fail closed.
    runtimeToolsAllowPolicy = undefined;
    params = {
      ...params,
      toolsAllow: undefined,
      cliToolAvailability: { native: [], openClaw: [] },
    };
  }
  const internalParams = params as RunCliAgentPrepareParams;
  const nodeClaudePlacement = detectNodeClaudePlacement({
    backendId: backendResolved.id,
    execHost: params.sessionEntry?.execHost,
    execNode: params.sessionEntry?.execNode,
  });
  if (nodeClaudePlacement && params.cliToolAvailability) {
    // Gateway-loopback MCP tools do not exist on the node. Project the policy
    // before either backend enforcement phase so staged settings and argv agree.
    params = {
      ...params,
      cliToolAvailability: {
        native: params.cliToolAvailability.native,
        openClaw: [],
      },
    };
  }
  if (params.cliToolAvailability !== undefined && !canEnforceExactToolAvailability) {
    // Cron persists this verbatim and failure alerts truncate at 200 characters,
    // so keep the upgrade recovery and fail-closed outcome compact.
    throw new Error(
      `CLI backend "${backendResolved.id}" cannot enforce this run's tool cap. Upgrade its plugin and retry; if current, ask its maintainer to add exact-cap support. OpenClaw did not start the run.`,
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
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: sessionOwner,
  });
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
  // Claude owns its native login and single-use refresh-token family. Never
  // preflight, refresh, or forward OpenClaw's snapshot; the installed Claude
  // process validates and refreshes its own current login.
  const usesNativeAuthProfile =
    backendAuthPolicy?.nativeAuthProfileIds !== undefined &&
    effectiveAuthProfileId !== undefined &&
    backendAuthPolicy.nativeAuthProfileIds.includes(effectiveAuthProfileId);
  if (usesNativeAuthProfile) {
    effectiveAuthProfileId = undefined;
    authCredential = undefined;
  } else if (
    effectiveAuthProfileId &&
    shouldRefreshAuthProfileForExecution({
      policy: backendAuthPolicy,
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
      // Claude's selected profile is an account boundary. Never refresh or
      // substitute a sibling account while preparing this run.
      ...(backendAuthPolicy?.strictSelectedProfile ? { allowProfileFallback: false } : {}),
    });
    if (!resolvedAuth && backendAuthPolicy?.strictSelectedProfile) {
      throw buildCliAuthProfileResolutionError({
        backendId: backendResolved.id,
        profileId: authProfileId,
        provider: writableAuthStore.profiles[authProfileId]?.provider ?? params.provider,
        agentDir,
        failure: { kind: "unmaterialized" },
      });
    }
    if (
      resolvedAuth &&
      backendAuthPolicy?.strictSelectedProfile &&
      resolvedAuth.profileId !== authProfileId
    ) {
      throw buildCliAuthProfileResolutionError({
        backendId: backendResolved.id,
        profileId: authProfileId,
        provider: writableAuthStore.profiles[authProfileId]?.provider ?? params.provider,
        agentDir,
        failure: { kind: "resolved-as-other", resolvedProfileId: resolvedAuth.profileId },
      });
    }
    const resolvedAuthProfileId = resolvedAuth?.profileId ?? authProfileId;
    authStore = loadScopedAuthStore({ profileId: resolvedAuthProfileId });
    authCredential = resolvedAuth?.credential ?? authStore.profiles[resolvedAuthProfileId];
    if (
      backendAuthPolicy?.strictSelectedProfile &&
      (!authCredential ||
        (authCredential.type === "oauth" && !hasUsableOAuthCredential(authCredential)))
    ) {
      throw buildCliAuthProfileResolutionError({
        backendId: backendResolved.id,
        profileId: authProfileId,
        provider: resolvedAuth?.provider ?? params.provider,
        agentDir,
        failure: { kind: "unmaterialized" },
      });
    }
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
  const normalizedCatalogModel = normalizeCliModel(modelId, backendResolved.config);
  const normalizedModel =
    backendResolved.resolveModelId?.({
      modelId: normalizedCatalogModel,
      contextWindow: params.contextWindow,
    }) ?? normalizedCatalogModel;
  const modelDisplay = `${params.provider}/${modelId}`;
  let openClawHistoryMessages: unknown[] | undefined;
  const loadOpenClawHistoryMessages = async () => {
    openClawHistoryMessages ??= await loadCliSessionHistoryMessages({
      sessionTarget: params.sessionTarget,
    });
    return openClawHistoryMessages;
  };
  const promptBuildHookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir,
    modelProviderId: params.provider,
    modelId,
    trigger: params.trigger,
    ...buildAgentHookContextChannelFields(params),
  };
  const promptBuildHookRunner = skipsTurnPreparation ? undefined : getGlobalHookRunner();
  const promptBuildHookResult = await (async () => {
    if (skipsTurnPreparation) {
      return undefined;
    }
    try {
      return await resolvePromptBuildHookResult({
        config: params.config ?? getRuntimeConfig(),
        prompt: params.prompt,
        messages: await loadOpenClawHistoryMessages(),
        hookCtx: promptBuildHookContext,
        hookRunner: promptBuildHookRunner,
        bootstrapContextRunKind: params.bootstrapContextRunKind,
      });
    } catch (error) {
      cliBackendLog.warn(`cli prompt-build hook preparation failed: ${String(error)}`);
      return undefined;
    }
  })();
  const promptBuildToolsAllow = mergeForcedEmbeddedAttemptToolsAllow(
    promptBuildHookResult?.toolsAllow,
    {
      forceMessageTool: messageToolOwnsVisibleReply({
        sourceReplyDeliveryMode: bindingSourceReplyDeliveryMode,
      }),
    },
  );
  const promptBuildRestrictsTools =
    promptBuildToolsAllow !== undefined &&
    !promptBuildToolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*");
  const isClaudeCli = isClaudeCliBackendId(params.provider);
  const requestedContextModelId = isClaudeCli ? resolveClaudeCliContextModelId(modelId) : modelId;
  const normalizedContextModelId = isClaudeCli
    ? resolveClaudeCliContextModelId(normalizedCatalogModel)
    : normalizedCatalogModel;
  // Aliases can map a canonical id to a CLI shorthand or a user shorthand to
  // a canonical id. Resolve both identities and keep the safest owned limit.
  const contextModelIds = [
    requestedContextModelId,
    ...(normalizedContextModelId !== requestedContextModelId ? [normalizedContextModelId] : []),
  ];
  const resolveContextModelTokens = (contextModelId: string) =>
    resolveContextTokensForModel({
      cfg: params.config,
      provider: params.provider,
      modelProvider: backendResolved.modelProvider,
      model: contextModelId,
      modelContextWindow: params.modelContextWindow,
      modelContextTokens: params.modelContextTokens,
      allowAsyncLoad: false,
      // A same-name API model may have a different native window from this CLI runtime.
      allowUnscopedModelLookup: false,
    });
  let modelContextTokens: number | undefined;
  for (const contextModelId of contextModelIds) {
    const candidateContextTokens = resolveContextModelTokens(contextModelId);
    if (candidateContextTokens !== undefined) {
      modelContextTokens =
        modelContextTokens === undefined
          ? candidateContextTokens
          : Math.min(modelContextTokens, candidateContextTokens);
    }
  }
  modelContextTokens ??= DEFAULT_CONTEXT_TOKENS;
  // Session-selectable context windows (catalog `contextWindows`, e.g. Claude
  // CLI 200k/1m) cap the resolved window here: the fixed provider contract in
  // resolveAnthropicFixedContextWindow deliberately ignores catalog scalars,
  // so the selected (or default) option must apply after it or a 200k session
  // would auto-compact against a 1M budget.
  const selectableContextEntry = findSelectableContextWindowEntry({
    catalog: params.config
      ? prepareDeps.loadManifestModelCatalog({ config: params.config, workspaceDir })
      : [],
    providers: uniqueStrings(
      [params.provider, backendResolved.modelProvider].filter(
        (provider): provider is string => typeof provider === "string" && provider.length > 0,
      ),
    ),
    models: uniqueStrings([modelId, normalizedCatalogModel]),
  });
  if (selectableContextEntry) {
    const contextWindowProfile = resolveModelContextWindowProfile({
      catalogEntry: selectableContextEntry,
      selected: params.contextWindow,
    });
    // Only an effective option caps the window; the bare catalog scalar stays
    // subordinate to the fixed provider contract above.
    if (contextWindowProfile.contextWindow && contextWindowProfile.contextTokens !== undefined) {
      modelContextTokens = Math.min(modelContextTokens, contextWindowProfile.contextTokens);
    }
  }
  const resolvedContextWindowInfo = resolveContextWindowInfo({
    cfg: params.config,
    provider: params.provider,
    modelId,
    modelContextTokens,
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
  const { bootstrapFiles, contextFiles: resolvedContextFiles } = skipsTurnPreparation
    ? { bootstrapFiles: [], contextFiles: [] }
    : await prepareDeps.resolveBootstrapContextForRun({
        workspaceDir,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        chatType: runtimeChatType,
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
    skipsTurnPreparation || !canTransportSystemPrompt(backendResolved.config)
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
  const {
    bootstrapAnalysis,
    bootstrapMaxChars,
    bootstrapPromptWarning,
    bootstrapPromptWarningMode,
    bootstrapTotalMaxChars,
  } = buildBootstrapBudgetState({
    config: params.config,
    agentId: sessionAgentId,
    bootstrapFiles: bootstrapFilesForInjectionStats,
    injectedFiles: contextFiles,
    seenSignatures: params.bootstrapPromptWarningSignaturesSeen,
    previousSignature: params.bootstrapPromptWarningSignature,
  });
  const bootstrapTruncationNotice = buildBootstrapPromptWarningNotice(bootstrapPromptWarning.lines);
  // Ring-zero OpenClaw runs replace the bundle MCP surface entirely: no
  // loopback server, no plugin/user servers. A selectable backend also removes
  // its native tools, leaving only this openclaw stdio server.
  const systemAgentMcpConfig = internalParams.systemAgentTool
    ? buildSystemAgentToolsMcpServerConfig(internalParams.systemAgentTool)
    : undefined;
  const bundleMcpEnabled =
    !nodeClaudePlacement &&
    !skipsTurnPreparation &&
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
  const runtimeConfig = params.config ?? getRuntimeConfig();
  const shouldMaterializeRuntimePolicy =
    runtimeToolsAllowPolicy !== undefined &&
    !nodeClaudePlacement &&
    !skipsTurnPreparation &&
    !systemAgentMcpConfig &&
    params.disableTools !== true;
  const mcpContextBase =
    mcpLoopbackRuntime || shouldMaterializeRuntimePolicy
      ? buildCliMcpGrantContext({
          run: params,
          config: runtimeConfig,
          requireExplicitMessageTarget,
          agentId: sessionAgentId,
          modelProvider,
          modelId,
        })
      : undefined;
  const mcpToolAuthAgentDir = mcpContextBase
    ? resolveRuntimeAuthProfileAgentDir(agentDir)
    : undefined;
  const mcpToolAuth = mcpContextBase
    ? {
        ...(mcpToolAuthAgentDir ? { agentDir: mcpToolAuthAgentDir } : {}),
        store: authStore ?? loadScopedAuthStore(),
      }
    : undefined;
  const requestedLoopbackToolsAllow =
    runtimeToolsAllowPolicy ?? params.cliToolAvailability?.openClaw;
  const mcpProjectionContext =
    mcpContextBase && requestedLoopbackToolsAllow !== undefined
      ? { ...mcpContextBase, toolsAllow: [...requestedLoopbackToolsAllow] }
      : mcpContextBase;
  const resolveProjectedTools =
    runtimeToolsAllowPolicy !== undefined
      ? prepareDeps.resolveMcpLoopbackPolicyTools
      : prepareDeps.resolveMcpLoopbackScopedTools;
  const projectedToolsBeforePromptBuild =
    (bundleMcpEnabled || shouldMaterializeRuntimePolicy) && mcpProjectionContext
      ? resolveProjectedTools({
          cfg: runtimeConfig,
          ...mcpProjectionContext,
          ...(mcpToolAuth ? { authProfileStore: mcpToolAuth.store } : {}),
          ...(mcpToolAuth?.agentDir ? { authProfileStoreAgentDir: mcpToolAuth.agentDir } : {}),
        }).tools
      : [];
  const hookFilteredProjectedTools = applyEmbeddedAttemptToolsAllow(
    projectedToolsBeforePromptBuild,
    promptBuildToolsAllow,
  );
  if (
    promptBuildRestrictsTools &&
    (backendResolved.nativeToolMode === "always-on" ||
      (backendResolved.nativeToolMode === "selectable" && !canEnforceExactToolAvailability))
  ) {
    throw new Error(
      `CLI backend "${backendResolved.id}" cannot enforce before_prompt_build tool restrictions. Use a backend with exact tool availability or remove the hook restriction. OpenClaw did not start the run.`,
    );
  }
  if (promptBuildRestrictsTools && params.cliToolAvailability === undefined) {
    if (backendResolved.nativeToolMode === "selectable") {
      params = {
        ...params,
        cliToolAvailability: {
          native: [],
          openClaw: hookFilteredProjectedTools.map((tool) => tool.name),
        },
      };
    }
  }
  if (runtimeToolsAllowPolicy !== undefined && shouldMaterializeRuntimePolicy) {
    params = {
      ...params,
      cliToolAvailability: {
        native: [],
        openClaw: hookFilteredProjectedTools.map((tool) => tool.name),
      },
    };
  }
  if (params.cliToolAvailability && promptBuildToolsAllow !== undefined) {
    const filterToolNames = (names: string[]) =>
      applyEmbeddedAttemptToolsAllow(
        names.map((name) => ({ name })),
        promptBuildToolsAllow,
      ).map((tool) => tool.name);
    params = {
      ...params,
      cliToolAvailability: {
        native: filterToolNames(params.cliToolAvailability.native),
        openClaw: filterToolNames(params.cliToolAvailability.openClaw),
      },
    };
  }
  const projectedTools = params.cliToolAvailability
    ? applyEmbeddedAttemptToolsAllow(
        hookFilteredProjectedTools,
        params.cliToolAvailability.openClaw,
      )
    : hookFilteredProjectedTools;
  const promptTools = bundleMcpEnabled ? projectedTools : [];
  const authorizedPromptBuildResult = await (async () => {
    const toolAuthorityFingerprint = params.toolAuthorityFingerprint;
    if (!promptBuildHookRunner || !toolAuthorityFingerprint) {
      return undefined;
    }
    const admittedParams = await admitPreparedParams(params);
    params = admittedParams;
    const assertHostActive = resolveAdmittedRunActiveAssertion(
      admittedParams.admittedRunContext,
      admittedParams.abortSignal,
    );
    if (!assertHostActive) {
      return undefined;
    }
    try {
      return await promptBuildHookRunner.runAuthorizedPromptBuild(
        {
          prompt: params.prompt,
          messages: await loadOpenClawHistoryMessages(),
        },
        promptBuildHookContext,
        {
          toolAuthorityFingerprint,
          activeToolNames: promptTools.map((tool) => tool.name),
          assertHostActive,
        },
      );
    } catch (error) {
      cliBackendLog.warn(`authorized CLI prompt-build hook failed: ${String(error)}`);
      return undefined;
    }
  })();
  const messageToolAvailable = promptTools.some(
    (tool) => normalizeToolPolicyName(tool.name) === "message",
  );
  const resultContentSourceByToolName = new Map(
    promptTools.flatMap((tool) =>
      tool.resultContentSource ? [[tool.name, tool.resultContentSource] as const] : [],
    ),
  );
  // A restricted selectable tool surface must also bound the MCP bundle:
  // CLI-side --allowedTools is advisory under bypass permission modes, so
  // user/plugin MCP servers must not be merged into the run's config at all.
  // The loopback server (scoped by the grant allowlist) becomes the complete
  // tool universe for the run.
  const restrictedLoopbackToolsAllow =
    params.cliToolAvailability?.openClaw ??
    (promptBuildRestrictsTools ? projectedTools.map((tool) => tool.name) : undefined);
  const mcpGrantContext =
    mcpContextBase && restrictedLoopbackToolsAllow !== undefined
      ? { ...mcpContextBase, toolsAllow: [...restrictedLoopbackToolsAllow] }
      : mcpContextBase;
  const toolBoundExtraSystemPromptHash = params.cliToolAvailability
    ? hashCliSessionText(
        JSON.stringify([
          baseExtraSystemPromptHash ?? null,
          params.cliToolAvailability.native.toSorted(),
          params.cliToolAvailability.openClaw.toSorted(),
        ]),
      )
    : baseExtraSystemPromptHash;
  // Bootstrap guidance and truncation notices change resumable system context.
  // Hash both so entering or leaving either state refreshes first-only CLI
  // system prompts.
  const extraSystemPromptHash =
    bootstrapMode === "none" && bootstrapTruncationNotice === undefined
      ? toolBoundExtraSystemPromptHash
      : hashCliSessionText(
          JSON.stringify([
            toolBoundExtraSystemPromptHash ?? null,
            bootstrapMode,
            bootstrapTruncationNotice !== undefined,
          ]),
        );
  let cleanupPreparedResources: (() => Promise<void>) | undefined;
  let preparedExecution: PrivateCliBackendPreparedExecution | undefined;
  try {
    const mcpClientGrant =
      mcpLoopbackRuntime && mcpGrantContext
        ? prepareDeps.mintMcpLoopbackClientGrant({
            context: mcpGrantContext,
            runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
            admittedRunContext: params.admittedRunContext,
            ...(mcpToolAuth ? { toolAuth: mcpToolAuth } : {}),
          })
        : undefined;
    const bindMcpClientGrantAdmission = (
      admittedRunContext: NonNullable<RunCliAgentParams["admittedRunContext"]>,
    ) => {
      if (
        mcpClientGrant &&
        mcpLoopbackRuntime &&
        !prepareDeps.bindMcpLoopbackClientGrantAdmission({
          token: mcpClientGrant.token,
          runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
          admittedRunContext,
        })
      ) {
        throw new Error("CLI MCP client grant is no longer valid for this admitted run");
      }
    };
    const mcpClientGrantCapture =
      mcpClientGrant && mcpLoopbackRuntime
        ? (() => {
            let activeToken = mcpClientGrant.token;
            return {
              transportToken: mcpClientGrant.token,
              adoptProcessToken: (processToken: string) => {
                if (activeToken === processToken) {
                  return;
                }
                if (
                  !prepareDeps.transferMcpLoopbackClientGrant({
                    sourceToken: mcpClientGrant.token,
                    targetToken: processToken,
                    runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                  })
                ) {
                  throw new Error(
                    "CLI MCP client grant could not transfer onto the live process bearer",
                  );
                }
                activeToken = processToken;
              },
              revokeProcessToken: () => {
                prepareDeps.revokeMcpLoopbackClientGrant(activeToken);
              },
              activate: (captureKey: string) => {
                const activated = prepareDeps.activateMcpLoopbackClientGrantCapture({
                  token: activeToken,
                  runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                  captureKey,
                });
                if (!activated) {
                  throw new Error(
                    "CLI MCP client grant is no longer valid for this Gateway runtime",
                  );
                }
              },
              deactivate: (captureKey: string) => {
                prepareDeps.deactivateMcpLoopbackClientGrantCapture({
                  token: activeToken,
                  runtimeOwnerToken: mcpLoopbackRuntime.ownerToken,
                  captureKey,
                });
              },
            };
          })()
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
    const loopbackServerConfig = mcpLoopbackRuntime
      ? prepareDeps.createMcpLoopbackServerConfig(mcpLoopbackRuntime.port)
      : undefined;
    const preparedBackend = await prepareCliBundleMcpConfig({
      enabled: bundleMcpEnabled || systemAgentMcpConfig !== undefined,
      mode: backendResolved.bundleMcpMode,
      backend: backendResolved.config,
      workspaceDir,
      config: params.config,
      toolOverrides: params.toolOverrides,
      agentDir,
      // Restricted runs serve only the loopback server; merging user/plugin
      // MCP servers would let the run reach tools outside its allowlist.
      ...(systemAgentMcpConfig
        ? { exclusiveConfig: systemAgentMcpConfig }
        : restrictedLoopbackToolsAllow && loopbackServerConfig
          ? { exclusiveConfig: loopbackServerConfig }
          : {}),
      additionalConfig: restrictedLoopbackToolsAllow ? undefined : loopbackServerConfig,
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
      ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
      contextTokenBudget: contextWindowInfo.tokens,
      thinkingLevel: params.thinkLevel === "ultra" ? "max" : params.thinkLevel,
      authProfileId: effectiveAuthProfileId,
      executionMode,
      toolAvailability: params.cliToolAvailability,
      env: preparedBackend.env,
    } satisfies Parameters<NonNullable<typeof backendResolved.prepareExecution>>[0];
    const privatePrepareExecutionContext = params.isolatedCompletion
      ? {
          ...prepareExecutionContext,
          // Bundled owners may project this through a native per-process system-prompt
          // channel. Keep it private so exact isolated inference does not expand the SDK.
          isolatedCompletionCwd: cwd,
          isolatedCompletionModelId: normalizedModel,
          isolatedCompletionPrompt: params.prompt,
          isolatedCompletionSystemPrompt: params.extraSystemPrompt ?? "",
        }
      : prepareExecutionContext;
    try {
      preparedExecution =
        (await backendResolved.prepareExecution?.(
          (backendAuthPolicy
            ? {
                ...privatePrepareExecutionContext,
                // The core-internal auth policy table owns this private credential and isolated
                // completion bridge; third-party backends cannot opt into either capability.
                authCredential,
              }
            : privatePrepareExecutionContext) as typeof prepareExecutionContext & {
            authCredential?: AuthProfileCredential;
            isolatedCompletionCwd?: string;
            isolatedCompletionModelId?: string;
            isolatedCompletionPrompt?: string;
            isolatedCompletionSystemPrompt?: string;
          },
        )) ?? undefined;
    } catch (error) {
      if (error instanceof CliBackendAuthProfilePreparationError && effectiveAuthProfileId) {
        // Preserve the selected-profile fact across lazy plugin preparation so
        // the generic runner can settle it once without backend-owned writes.
        throw new CliAuthProfilePreparationError({
          message: error.message,
          profileId: effectiveAuthProfileId,
          provider: authStore?.profiles[effectiveAuthProfileId]?.provider ?? params.provider,
          agentDir,
          cause: error,
        });
      }
      throw error;
    }
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
    if (params.isolatedCompletion && preparedExecution?.isolatedCompletionEnforced !== true) {
      throw unsupportedIsolatedCompletionError(backendResolved.id);
    }
    if (
      params.cliToolAvailability &&
      backendResolved.toolAvailabilityEnforcement === "prepare-execution" &&
      preparedExecution?.toolAvailabilityEnforced !== true
    ) {
      throw new Error(
        `CLI backend ${backendResolved.id} did not enforce exact per-run tool availability during execution preparation`,
      );
    }
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
      skipsTurnPreparation || nodeClaudePlacement
        ? { args: [], cleanup: async () => {} }
        : await prepareDeps.prepareClaudeCliSkillsPlugin({
            backendId: backendResolved.id,
            skillsSnapshot: params.skillsSnapshot,
          });
    let claudeSkillsPluginClaimed = false;
    const claimLiveSessionResources =
      claudeSkillsPlugin.args.length > 0
        ? () => {
            if (claudeSkillsPluginClaimed) {
              return undefined;
            }
            claudeSkillsPluginClaimed = true;
            return claudeSkillsPlugin.cleanup;
          }
        : undefined;
    const preparedCleanup =
      preparedBackendCleanup || claudeSkillsPlugin.args.length > 0
        ? async () => {
            try {
              if (!claudeSkillsPluginClaimed) {
                await claudeSkillsPlugin.cleanup();
              }
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
      ...(claimLiveSessionResources ? { claimLiveSessionResources } : {}),
      ...(preparedExecution?.execute ? { execute: preparedExecution.execute } : {}),
      ...(preparedExecution?.secretInput ? { secretInput: preparedExecution.secretInput } : {}),
      ...(mcpClientGrantCapture ? { mcpClientGrantCapture } : {}),
      ...(preparedCleanup ? { cleanup: preparedCleanup } : {}),
    };
    const promptToolNamesHash =
      bundleMcpEnabled && mcpLoopbackRuntime
        ? hashCliSessionText(JSON.stringify(promptTools.map((tool) => tool.name).toSorted()))
        : undefined;
    // `sessionMode: none` may still use a live transport in-process, but neither a
    // returned nor previously stored id is authority for cross-process continuity.
    const ignoreCliSessionCandidate =
      isSideQuestion || preparedBackendFinal.backend.sessionMode === "none";
    // Native controls target the already-owned transcript without rebuilding its turn-time MCP
    // topology. Re-validating that topology here would discard the session being compacted.
    const controlOperationCliSessionId = isControlOperation
      ? params.cliSessionBinding?.sessionId.trim() || params.cliSessionId?.trim()
      : undefined;
    const reusableCliSessionCandidate: CliReusableSession = ignoreCliSessionCandidate
      ? { mode: "none" }
      : controlOperationCliSessionId
        ? { mode: "reuse", sessionId: controlOperationCliSessionId }
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
    // Control operations must keep the exact native session they were asked to mutate.
    // Ordinary-turn transcript recovery must not turn `/compact` into a fresh session.
    const hasClaudeCliCandidate =
      !isControlOperation &&
      !nodeClaudePlacement &&
      candidateClaudeCliSessionId !== undefined &&
      isClaudeCliBackendId(params.provider);
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
      prepareDeps.getCliLiveSessionGeneration({
        backendId: backendResolved.id,
        agentAccountId: params.agentAccountId,
        agentId: workspaceResolution.agentId,
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
    const openClawReferences = skipsTurnPreparation
      ? { docsPath: null, sourcePath: null }
      : await prepareDeps.resolveOpenClawReferencePaths({
          workspaceDir,
          argv1: process.argv[1],
          cwd,
          moduleUrl: import.meta.url,
        });
    const systemPromptSkillsPrompt =
      skipsTurnPreparation || nodeClaudePlacement || claudeSkillsPlugin.args.length > 0
        ? ""
        : await resolveCliSkillsPrompt({
            skillsSnapshot: params.skillsSnapshot,
            workspaceDir,
            config: params.config,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey?.trim() || params.sessionId,
          });
    const runtimeChannel = skipsTurnPreparation
      ? undefined
      : normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    const runtimeCapabilities = skipsTurnPreparation
      ? undefined
      : collectRuntimeChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        });
    const builtSystemPrompt = isControlOperation
      ? ""
      : isSideQuestion
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
            runtimeChatType,
            runtimeCapabilities,
            ownerNumbers: params.ownerNumbers,
            docsPath: openClawReferences.docsPath ?? undefined,
            sourcePath: openClawReferences.sourcePath ?? undefined,
            skillsPrompt: systemPromptSkillsPrompt,
            tools: promptTools,
            contextFiles,
            bootstrapMode,
            bootstrapTruncationNotice,
            modelDisplay,
            agentId: sessionAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
          });
    const transformedSystemPrompt = !skipsTurnPreparation
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
    const finalizedTranscriptPrompt =
      params.finalizePromptForResolvedTools && params.transcriptPrompt === undefined
        ? params.prompt
        : params.transcriptPrompt;
    let preparedPrompt = isControlOperation
      ? params.prompt
      : (params.finalizePromptForResolvedTools?.({
          prompt: params.prompt,
          messageToolAvailable,
        }) ?? params.prompt);
    if (!skipsTurnPreparation) {
      try {
        const hookResult = promptBuildHookResult;
        const prependContext = [
          hookResult?.prependContext,
          authorizedPromptBuildResult?.prependContext,
        ]
          .filter((value): value is string => Boolean(value?.trim()))
          .join("\n\n");
        const appendContext = [
          hookResult?.appendContext,
          authorizedPromptBuildResult?.appendContext,
        ]
          .filter((value): value is string => Boolean(value?.trim()))
          .join("\n\n");
        if (prependContext) {
          preparedPrompt = `${prependContext}\n\n${preparedPrompt}`;
        }
        if (appendContext) {
          preparedPrompt = `${preparedPrompt}\n\n${appendContext}`;
        }
        const hookSystemPrompt = hookResult?.systemPrompt?.trim();
        if (hookSystemPrompt) {
          systemPrompt = hookSystemPrompt;
        }
        systemPrompt =
          composeSystemPromptWithHookContext({
            baseSystemPrompt: systemPrompt,
            prependSystemContext: hookResult?.prependSystemContext,
            appendSystemContext: hookResult?.appendSystemContext,
          }) ?? systemPrompt;
        const mediaTaskSystemPromptAddition = resolveAttemptMediaTaskSystemPromptAddition({
          sessionKey: params.sessionKey,
          agentId: sessionAgentId,
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
    if (!skipsTurnPreparation) {
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
      !skipsTurnPreparation && (!reusableCliSessionId || allowRawTranscriptReseed);
    const openClawHistoryPrompt = shouldPrepareOpenClawHistoryPrompt
      ? buildCliSessionHistoryPrompt({
          messages: await loadCliSessionReseedMessages({
            sessionTarget: params.sessionTarget,
            allowRawTranscriptReseed,
            rawTranscriptReseedReason,
          }),
          prompt: historyPromptCurrentTurn,
          maxHistoryChars: autoReseedHistoryChars,
        })
      : undefined;
    const systemPromptWithReplacements = skipsTurnPreparation
      ? systemPrompt
      : applyPluginTextReplacements(systemPrompt, backendResolved.textTransforms?.input);
    // Ensure the cache boundary before appending the model identity so the identity lands in the
    // dynamic suffix, not the cached prefix, for marker-free hook overrides — otherwise an idle
    // turn's prefix (O + identity) diverges from an active media turn's prefix (O) and breaks
    // prompt caching. Skip empty prompts and turns with no identity line, which need no boundary.
    systemPrompt = skipsTurnPreparation
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
    if (skipsTurnPreparation) {
      const preparedParams = await admitPreparedParams({
        ...params,
        config: contextEngineConfig,
        prompt: preparedPrompt,
        transcriptPrompt: finalizedTranscriptPrompt,
        ...(requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
      });
      bindMcpClientGrantAdmission(preparedParams.admittedRunContext);
      if (!isControlOperation) {
        recordAdmittedModelRoutingDecision({
          admittedRunContext: preparedParams.admittedRunContext,
          abortSignal: preparedParams.abortSignal,
          requestedProvider:
            params.modelRoutingProvenance?.requestedProvider ??
            params.modelProvider ??
            params.provider,
          requestedModel:
            params.modelRoutingProvenance?.requestedModel ?? params.model ?? "default",
          selectedProvider: params.modelProvider ?? params.provider,
          selectedModel: normalizedModel,
          selectionMode: requestedAuthProfileId ? "explicit" : "automatic",
          credentialProfileId: effectiveAuthProfileId,
          fallbackSelected: params.modelRoutingProvenance?.stage === "fallback",
          fallbackReason: params.modelRoutingProvenance?.fallbackReason,
        });
      }

      return {
        params: preparedParams,
        effectiveAuthProfileId,
        ...(authStore ? { authProfileStore: authStore } : {}),
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
        authEpoch,
        authBindingFingerprint,
        ...(skipLocalCredentialEpoch ? { authBindingSkipsLocalCredential: true } : {}),
        authEpochVersion: CLI_AUTH_EPOCH_VERSION,
        extraSystemPromptHash,
        messageToolPolicyHash,
        promptToolNamesHash,
        ...(resultContentSourceByToolName.size > 0 ? { resultContentSourceByToolName } : {}),
        cwdHash,
        ...(mcpDeliveryCaptureEnabled ? { mcpDeliveryCapture: true } : {}),
      };
    }
    ensureContextEnginesInitialized();
    const { sessionAgentId: contextEngineSessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: contextEngineConfig,
      agentId: sessionAgentId,
    });
    // Context remains session-owned. Trusted helper runs may borrow a different
    // agentDir only for model/auth execution.
    const contextEngineAgentDir = resolveAgentDir(contextEngineConfig, contextEngineSessionAgentId);
    const contextEngineHostSupport = buildGenericCliContextEngineHostSupport({
      backendId: backendResolved.id,
      capabilities: backendResolved.contextEngineHostCapabilities,
    });
    let resolvedContextEngine;
    if (params.contextEngineLogicalTurnLease) {
      selectContextEngineForTranscriptHost({
        lease: params.contextEngineLogicalTurnLease,
        host: contextEngineHostSupport,
        operation: "agent-run",
        recorder: params.userTurnTranscriptRecorder,
      });
      await drainPendingContextEngineTurnsBeforeRun({
        admission: params.userTurnTranscriptRecorder?.getAdmissionReceipt(),
        isHeartbeat: isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind),
        lease: params.contextEngineLogicalTurnLease,
        recorder: params.userTurnTranscriptRecorder,
        sessionTarget: params.sessionTarget,
      });
      resolvedContextEngine = params.contextEngineLogicalTurnLease.begin().engine;
    } else {
      resolvedContextEngine = await resolveContextEngine(contextEngineConfig, {
        agentDir: contextEngineAgentDir,
        workspaceDir,
      });
    }
    const contextEngine =
      resolvedContextEngine.info.id !== "legacy" ? resolvedContextEngine : undefined;
    if (contextEngine) {
      assertContextEngineHostSupport({
        contextEngine,
        operation: "agent-run",
        host: contextEngineHostSupport,
      });
    }
    const hadSessionFile = await hasCliSessionTranscript({
      sessionTarget: params.sessionTarget,
    });
    const contextEngineTurnPrompt = params.transcriptPrompt ?? params.prompt;
    const preparedParams = await admitPreparedParams({
      ...params,
      config: contextEngineConfig,
      prompt: preparedPrompt,
      transcriptPrompt: finalizedTranscriptPrompt,
      ...(requireExplicitMessageTarget ? { requireExplicitMessageTarget: true } : {}),
    });
    bindMcpClientGrantAdmission(preparedParams.admittedRunContext);
    recordAdmittedModelRoutingDecision({
      admittedRunContext: preparedParams.admittedRunContext,
      abortSignal: preparedParams.abortSignal,
      requestedProvider:
        params.modelRoutingProvenance?.requestedProvider ?? params.modelProvider ?? params.provider,
      requestedModel: params.modelRoutingProvenance?.requestedModel ?? params.model ?? "default",
      selectedProvider: params.modelProvider ?? params.provider,
      selectedModel: normalizedModel,
      selectionMode: requestedAuthProfileId ? "explicit" : "automatic",
      credentialProfileId: effectiveAuthProfileId,
      fallbackSelected: params.modelRoutingProvenance?.stage === "fallback",
      fallbackReason: params.modelRoutingProvenance?.fallbackReason,
    });

    return {
      params: preparedParams,
      effectiveAuthProfileId,
      ...(authStore ? { authProfileStore: authStore } : {}),
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
      ...(openClawHistoryPrompt ? { openClawHistoryPrompt } : {}),
      authEpoch,
      authBindingFingerprint,
      ...(skipLocalCredentialEpoch ? { authBindingSkipsLocalCredential: true } : {}),
      authEpochVersion: CLI_AUTH_EPOCH_VERSION,
      extraSystemPromptHash,
      messageToolPolicyHash,
      promptToolNamesHash,
      ...(resultContentSourceByToolName.size > 0 ? { resultContentSourceByToolName } : {}),
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
