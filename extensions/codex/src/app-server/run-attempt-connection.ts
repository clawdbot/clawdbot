import {
  embeddedAgentLog,
  getBeforeToolCallPolicyDiagnosticState,
  isActiveHarnessContextEngine,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  type FastModeAutoProgressState,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  resolveDiagnosticModelContentCapturePolicy,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import {
  resolveCodexAppServerForModelProvider,
  resolveCodexAppServerForOpenClawToolPolicy,
} from "./app-server-policy.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerPreparedAuthHandoff,
} from "./auth-bridge.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import {
  isCodexAppServerApprovalPolicyAllowedByRequirements,
  readCodexPluginConfig,
  resolveCodexComputerUseConfig,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
} from "./config.js";
import { createCodexDynamicToolBuildStageTracker } from "./dynamic-tool-build.js";
import { resolveCodexNativeHookRelayEvents } from "./native-hook-relay.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { ensureCodexWorkspaceDirOnce } from "./run-attempt-lifecycle.js";
import type { CodexRunAttemptInput } from "./run-attempt-types.js";
import {
  createCodexSessionGenerationSupersededError,
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";

function applyStoredBindingPermissions(params: {
  appServer: ReturnType<typeof resolveCodexBindingAppServerConnection>["appServer"];
  binding: CodexAppServerThreadBinding | undefined;
  execPolicyTouched: boolean;
}) {
  if (params.execPolicyTouched || params.binding?.connectionScope === "supervision") {
    return params.appServer;
  }
  // `/codex permissions` owns per-session policy. Explicit OpenClaw exec config
  // and supervised private connections remain authoritative when present.
  return {
    ...params.appServer,
    approvalPolicy: params.binding?.approvalPolicy ?? params.appServer.approvalPolicy,
    sandbox: params.binding?.sandbox ?? params.appServer.sandbox,
  };
}

export async function prepareCodexAttemptConnection({ params, options }: CodexRunAttemptInput) {
  const attemptStartedAt = Date.now();
  const profilerEnabled = isCodexAppServerProfilerEnabled(params.config);
  const codexModelCallTrace = freezeDiagnosticTraceContext(
    createDiagnosticTraceContextFromActiveScope(),
  );
  const codexModelContentCapture = resolveDiagnosticModelContentCapturePolicy(params.config);
  const codexModelCallId = `${params.runId}:codex-model:1`;
  const fastModeAutoStartedAtMs =
    typeof params.fastModeStartedAtMs === "number" && Number.isFinite(params.fastModeStartedAtMs)
      ? params.fastModeStartedAtMs
      : undefined;
  const fastModeAutoProgressState: FastModeAutoProgressState = params.fastModeAutoProgressState ?? {
    offAnnounced: false,
    resetAnnounced: false,
  };
  const preDynamicStartupStages = createCodexDynamicToolBuildStageTracker({
    enabled: profilerEnabled,
  });
  const attemptClientFactory = options.clientFactory ?? getLeasedSharedCodexAppServerClient;
  const runtimeArtifactRequest =
    params.captureRuntimeArtifact || params.expectedRuntimeArtifact
      ? params.expectedRuntimeArtifact
        ? { expected: params.expectedRuntimeArtifact }
        : {}
      : undefined;
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig });
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const beforeToolCallPolicy = getBeforeToolCallPolicyDiagnosticState();
  preDynamicStartupStages.mark("config");
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await ensureCodexWorkspaceDirOnce(resolvedWorkspace);
  preDynamicStartupStages.mark("workspace");
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  const contextSessionKey = params.sessionKey?.trim() || sandboxSessionKey;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  preDynamicStartupStages.mark("sandbox");
  const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
    execOverrides: params.execOverrides,
    approvals: loadExecApprovals(),
    config: params.config,
    agentId: sessionAgentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  const bindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const bindingStore = options.bindingStore;
  preDynamicStartupStages.mark("session-agent");
  let activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const isInactiveThreadBootstrapBinding = (binding: CodexAppServerThreadBinding | undefined) =>
    !activeContextEngine && binding?.contextEngine?.projection?.mode === "thread_bootstrap";
  let startupBinding = await bindingStore.read(bindingIdentity);
  if (!startupBinding && bindingIdentity.kind === "session" && bindingIdentity.sessionKey) {
    const reclaimed = await reclaimCurrentCodexSessionGeneration({
      bindingStore,
      identity: bindingIdentity,
      config: params.config,
    });
    if (!reclaimed) {
      throw createCodexSessionGenerationSupersededError(bindingIdentity.sessionId);
    }
    startupBinding = await bindingStore.read(bindingIdentity);
  }
  preDynamicStartupStages.mark("read-binding");
  const usesSupervisionConnection = startupBinding?.connectionScope === "supervision";
  if (usesSupervisionConnection) {
    activeContextEngine = undefined;
  }
  if (usesSupervisionConnection && pluginConfig.supervision?.enabled !== true) {
    throw new Error(
      "Codex supervision is disabled; refusing to open a native user-home supervised session",
    );
  }
  const resolveRuntimeOptionsForBinding = (selection: { modelProvider?: string; model?: string }) =>
    applyStoredBindingPermissions({
      appServer: resolveCodexBindingAppServerConnection({
        binding: startupBinding,
        pluginConfig,
        execPolicy,
        modelProvider: selection.modelProvider,
        model: selection.model,
        config: params.config,
        agentDir,
        openClawSandboxActive: sandbox?.enabled === true,
      }).appServer,
      binding: startupBinding,
      execPolicyTouched: execPolicy.touched,
    });
  const initialStartupBindingHadInactiveThreadBootstrap =
    isInactiveThreadBootstrapBinding(startupBinding);
  const preparedAuthRoute = usesSupervisionConnection
    ? undefined
    : params.runtimePlan?.auth.modelRoute;
  const startupAuthProfileCandidate = usesSupervisionConnection
    ? undefined
    : preparedAuthRoute
      ? params.runtimePlan?.auth.forwardedAuthProfileId
      : (params.runtimePlan?.auth.forwardedAuthProfileId ??
        params.authProfileId ??
        startupBinding?.authProfileId);
  const resolvedStartupAuthProfileId = usesSupervisionConnection
    ? undefined
    : preparedAuthRoute
      ? startupAuthProfileCandidate
      : params.authProfileStore
        ? resolveCodexAppServerAuthProfileId({
            authProfileId: startupAuthProfileCandidate,
            store: params.authProfileStore,
            config: params.config,
          })
        : resolveCodexAppServerAuthProfileIdForAgent({
            authProfileId: startupAuthProfileCandidate,
            agentDir,
            config: params.config,
          });
  const authHandoff = usesSupervisionConnection
    ? { authProfileId: undefined, nativeAuthProfile: true, preparedAuth: undefined }
    : await resolveCodexAppServerPreparedAuthHandoff({
        authRequirement: preparedAuthRoute?.authRequirement,
        resolvedApiKey: params.resolvedApiKey,
        authProfileId: resolvedStartupAuthProfileId,
        authProfileStore: params.authProfileStore,
        agentDir,
        config: params.config,
        subscriptionProfileRequiredError:
          "Prepared Codex subscription route requires a forwarded OpenAI OAuth or token profile.",
        subscriptionProfileUnusableError: "Prepared Codex subscription auth profile is unusable.",
      });
  const {
    authProfileId: startupAuthProfileId,
    nativeAuthProfile,
    preparedAuth: startupPreparedAuth,
  } = authHandoff;
  const startupClientAuthProfileId =
    usesSupervisionConnection || startupPreparedAuth?.kind === "api-key"
      ? null
      : startupAuthProfileId;
  const resolveReviewerPolicyContext = (binding: CodexAppServerThreadBinding | undefined) => {
    const nativeModelOwned = binding?.preserveNativeModel === true;
    return resolveCodexModelBackedReviewerPolicyContext({
      provider: nativeModelOwned ? "codex" : params.provider,
      model: nativeModelOwned ? binding.model : params.modelId,
      bindingModelProvider: binding?.modelProvider,
      bindingModel: binding?.model,
      nativeAuthProfile,
    });
  };
  let reviewerPolicyContext = resolveReviewerPolicyContext(startupBinding);
  preDynamicStartupStages.mark("auth-profile");
  let configuredAppServer = resolveRuntimeOptionsForBinding({
    modelProvider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed Codex app-server runs; omit cwd or use the agent workspace as cwd",
    );
  }
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace);
  await ensureCodexWorkspaceDirOnce(effectiveWorkspace);
  preDynamicStartupStages.mark("effective-workspace");
  const resolvePolicyAppServer = () =>
    resolveCodexAppServerForOpenClawToolPolicy({
      appServer: configuredAppServer,
      pluginConfig,
      env: process.env,
      shouldPromote:
        beforeToolCallPolicy.hasBeforeToolCallHook ||
        beforeToolCallPolicy.trustedToolPolicies.length > 0,
      execPolicy,
      canUseUntrustedApprovalPolicy:
        configuredAppServer.start.transport !== "stdio" ||
        isCodexAppServerApprovalPolicyAllowedByRequirements("untrusted"),
    });
  let policyAppServer = resolvePolicyAppServer();
  let appServer = resolveCodexAppServerForModelProvider({
    appServer: policyAppServer,
    provider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
    config: params.config,
    env: process.env,
    agentDir,
  });
  if (configuredAppServer.approvalPolicy === "never" && appServer.approvalPolicy === "untrusted") {
    embeddedAgentLog.info("codex app-server approval policy promoted for OpenClaw tool policy", {
      from: "never",
      to: "untrusted",
      beforeToolCallHook: beforeToolCallPolicy.hasBeforeToolCallHook,
      trustedToolPolicies: beforeToolCallPolicy.trustedToolPolicies,
    });
  }
  preDynamicStartupStages.mark("app-server-policy");
  preDynamicStartupStages.mark("native-hook-relay");
  const terminalState = {
    explicitCancellationObserved: false,
    explicitCancellationReason: undefined as unknown,
    terminalOutcomeFrozen: false,
    sharedAbortAllowedAfterTerminalOutcome: false,
  };
  const runAbortController = new AbortController();
  let attemptAbortNotified = false;
  const notifyAttemptAbort = () => {
    if (attemptAbortNotified) {
      return;
    }
    attemptAbortNotified = true;
    params.onAttemptAbort?.();
  };
  const abortExplicitly = (reason: unknown) => {
    if (terminalState.terminalOutcomeFrozen) {
      if (terminalState.sharedAbortAllowedAfterTerminalOutcome) {
        notifyAttemptAbort();
      }
      return;
    }
    notifyAttemptAbort();
    terminalState.explicitCancellationObserved = true;
    terminalState.explicitCancellationReason ??= reason;
    runAbortController.abort(reason);
  };
  const abortFromUpstream = () => {
    abortExplicitly(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  startupBinding = await rotateOversizedCodexAppServerStartupBinding({
    binding: startupBinding,
    bindingStore,
    identity: bindingIdentity,
    sessionFile: params.sessionFile,
    agentDir,
    codexHome: appServer.start.env?.CODEX_HOME,
    config: params.config,
    contextEngineActive: Boolean(activeContextEngine),
  });
  const initialInactiveThreadBootstrapBindingForcedFreshStart =
    initialStartupBindingHadInactiveThreadBootstrap && !startupBinding?.threadId;
  preDynamicStartupStages.mark("rotate-binding");
  reviewerPolicyContext = resolveReviewerPolicyContext(startupBinding);
  configuredAppServer = resolveRuntimeOptionsForBinding({
    modelProvider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
  });
  policyAppServer = resolvePolicyAppServer();
  appServer = resolveCodexAppServerForModelProvider({
    appServer: policyAppServer,
    provider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
    config: params.config,
    env: process.env,
    agentDir,
  });
  const nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
    configuredEvents: options.nativeHookRelay?.events,
    appServer,
  });
  const mutable = { startupBinding, pluginAppServer: appServer };
  const resolveRuntimeOptionsForCurrentBinding = (selection: {
    modelProvider?: string;
    model?: string;
  }) =>
    applyStoredBindingPermissions({
      appServer: resolveCodexBindingAppServerConnection({
        binding: mutable.startupBinding,
        pluginConfig,
        execPolicy,
        modelProvider: selection.modelProvider,
        model: selection.model,
        config: params.config,
        agentDir,
        openClawSandboxActive: sandbox?.enabled === true,
      }).appServer,
      binding: mutable.startupBinding,
      execPolicyTouched: execPolicy.touched,
    });
  return {
    params,
    options,
    attemptStartedAt,
    profilerEnabled,
    codexModelCallTrace,
    codexModelContentCapture,
    codexModelCallId,
    fastModeAutoStartedAtMs,
    fastModeAutoProgressState,
    preDynamicStartupStages,
    attemptClientFactory,
    runtimeArtifactRequest,
    pluginConfig,
    computerUseConfig,
    sessionAgentId,
    resolvedWorkspace,
    sandboxSessionKey,
    contextSessionKey,
    sandbox,
    agentDir,
    bindingIdentity,
    bindingStore,
    activeContextEngine,
    isInactiveThreadBootstrapBinding,
    usesSupervisionConnection,
    startupAuthProfileId,
    startupAuthRequirement: preparedAuthRoute?.authRequirement,
    startupPreparedAuth,
    startupClientAuthProfileId,
    effectiveWorkspace,
    effectiveCwd,
    appServer,
    nativeHookRelayEvents,
    runAbortController,
    terminalState,
    abortExplicitly,
    abortFromUpstream,
    resolveReviewerPolicyContext,
    resolveRuntimeOptionsForCurrentBinding,
    mutable,
    initialStartupBindingHadInactiveThreadBootstrap,
    initialInactiveThreadBootstrapBindingForcedFreshStart,
  };
}

export type CodexAttemptConnection = Awaited<ReturnType<typeof prepareCodexAttemptConnection>>;
