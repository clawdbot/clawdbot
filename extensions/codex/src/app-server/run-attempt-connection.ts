import {
  isActiveHarnessContextEngine,
  resolveSandboxContext,
  resolveUserPath,
  type FastModeAutoProgressState,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  resolveDiagnosticModelContentCapturePolicy,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { resolveCodexAppServerForModelProvider } from "./app-server-policy.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileIdForAgent,
  resolveCodexAppServerPreparedAuthHandoff,
} from "./auth-bridge.js";
import {
  assertCodexSessionRuntimeOwnership,
  resolveCodexBindingAppServerConnection,
} from "./binding-connection.js";
import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  isCodexPairedNodeRemoteExecPlacementSandbox,
  isCodexRemoteExecPlacementSandbox,
  readCodexPluginConfig,
  readCodexRequirementsToml,
  resolveCodexAppServerHomeScope,
  resolveCodexComputerUseConfig,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveOpenClawExecPolicyForCodexAppServer,
  type CodexAppServerRuntimeOptions,
} from "./config.js";
import { createCodexDynamicToolBuildStageTracker } from "./dynamic-tool-build.js";
import { resolveCodexNativeHookRelayEvents } from "./native-hook-relay.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { ensureCodexWorkspaceDirOnce } from "./run-attempt-lifecycle.js";
import type { CodexRunAttemptInput } from "./run-attempt-types.js";
import {
  createCodexSessionGenerationSupersededError,
  resolveCodexSessionBinding,
  resolveCodexRunSessionBindingAuthority,
  scopeCodexRunBindingStore,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import {
  applyCodexSessionPermissionPolicy,
  resolveCodexEffectiveSessionPermissionPolicy,
  resolveCodexSessionPermissionCwd,
} from "./session-permission-policy.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { rotateOversizedCodexAppServerStartupBinding } from "./startup-binding.js";

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
  const preDynamicStartupStages = createCodexDynamicToolBuildStageTracker();
  const runtimeArtifactRequest =
    params.captureRuntimeArtifact || params.expectedRuntimeArtifact
      ? params.expectedRuntimeArtifact
        ? { expected: params.expectedRuntimeArtifact }
        : {}
      : undefined;
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const requirementsToml = readCodexRequirementsToml({});
  const computerUseConfig = resolveCodexComputerUseConfig({ pluginConfig });
  const { sessionAgentId } = resolveSessionAgentIdsStrict({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  // Retained policy owns native and dynamic restrictions; execution identity still owns
  // credentials, hooks, and bindings.
  const policyAgentId = params.sandboxAgentId ?? sessionAgentId;
  preDynamicStartupStages.mark("config");
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await ensureCodexWorkspaceDirOnce(resolvedWorkspace);
  preDynamicStartupStages.mark("workspace");
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  const contextSessionKey = params.sessionKey?.trim() || sandboxSessionKey;
  const sandbox =
    params.sandbox !== undefined
      ? params.sandbox
      : await resolveSandboxContext({
          config: params.config,
          agentId: params.sandboxAgentId,
          sessionKey: sandboxSessionKey,
          workspaceDir: resolvedWorkspace,
        });
  // Upstream cannot remove registered environments, so node leases own one disposable client.
  const attemptClientFactory =
    options.clientFactory ??
    (isCodexPairedNodeRemoteExecPlacementSandbox(sandbox)
      ? createIsolatedCodexAppServerClient
      : getLeasedSharedCodexAppServerClient);
  preDynamicStartupStages.mark("sandbox");
  const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
    // Explicit modes replace legacy fields; full also replaces approval-file floors.
    permissionMode: params.permissionMode,
    execOverrides: params.execOverrides,
    approvals: params.permissionMode === "full" ? undefined : loadExecApprovals(),
    config: params.config,
    agentId: policyAgentId,
  });
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
  const preparedEnvironment = params.hostCapabilities.preparedEnvironment?.();
  const remoteExec = isCodexRemoteExecPlacementSandbox(sandbox);
  const assertLocalTargetSupported = (unsupported: boolean) => {
    if (preparedEnvironment?.localProcessEnv && unsupported) {
      throw new Error(
        "This runtime cannot target the diagnosed local installation. Use the saved prompt with a suggested external or manual handoff on this machine.",
      );
    }
  };
  assertLocalTargetSupported(sandbox?.enabled === true || remoteExec);
  const preparedShellEnvironment = preparedEnvironment
    ? {
        ...preparedEnvironment.credentialScrubEnv,
        ...(sandbox?.enabled || remoteExec ? undefined : preparedEnvironment.localIdentityEnv),
        ...preparedEnvironment.localProcessEnv,
      }
    : undefined;
  const shellEnvironment =
    preparedShellEnvironment && Object.keys(preparedShellEnvironment).length > 0
      ? preparedShellEnvironment
      : undefined;
  // An empty system-detected overlay intentionally keeps the runtime user's native shell identity.
  // Selected, scrubbed, or remote identities must not let a later profile replace that decision.
  const disableLoginShell =
    remoteExec ||
    preparedEnvironment?.localProcessEnv !== undefined ||
    preparedEnvironment?.managedLocalIdentity === true ||
    (preparedEnvironment !== undefined &&
      Object.keys(preparedEnvironment.credentialScrubEnv).length > 0);
  const withPreparedProcessEnv = <T extends CodexAppServerRuntimeOptions>(appServer: T) => {
    // Loopback WebSockets can forward to another host; their URL does not attest peer locality.
    assertLocalTargetSupported(
      appServer.start.transport === "websocket" || Boolean(appServer.remoteWorkspaceRoot),
    );
    return shellEnvironment
      ? {
          ...appServer,
          start: { ...appServer.start, env: { ...appServer.start.env, ...shellEnvironment } },
        }
      : appServer;
  };
  let bindingIdentity: CodexAppServerBindingIdentity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  let bindingStore = options.bindingStore;
  preDynamicStartupStages.mark("session-agent");
  let activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  const isInactiveThreadBootstrapBinding = (binding: CodexAppServerThreadBinding | undefined) =>
    !activeContextEngine && binding?.contextEngine?.projection?.mode === "thread_bootstrap";
  // Only a durable session row authorizes stable-key ownership. Caller-owned
  // transcripts omit a store target, so classify them against the default store too.
  if (bindingIdentity.kind === "session" && bindingIdentity.sessionKey) {
    const authority = resolveCodexRunSessionBindingAuthority({
      identity: bindingIdentity,
      config: params.config,
      storePath: params.sessionTarget?.storePath,
    });
    if (authority === "superseded") {
      throw createCodexSessionGenerationSupersededError(bindingIdentity.sessionId);
    }
    if (authority === "ephemeral") {
      // Stable-key fences protect only durable session rows. Ephemeral callers rotate
      // physical ids, so sharing that owner would strand every run after the first.
      const logicalIdentity = bindingIdentity;
      const physicalIdentity = {
        kind: "session",
        agentId: bindingIdentity.agentId,
        sessionId: bindingIdentity.sessionId,
      } as const;
      bindingStore = scopeCodexRunBindingStore({
        bindingStore,
        logicalIdentity,
        physicalIdentity,
      });
      bindingIdentity = physicalIdentity;
    }
  }
  const { binding: admittedBinding, assertCurrent } = await resolveCodexSessionBinding({
    reclaimStale: true,
    bindingStore,
    identity: bindingIdentity,
    config: params.config,
    storePath: params.sessionTarget?.storePath,
    assertCurrent: params.hostCapabilities.assertActive,
    signal: params.abortSignal,
    assertBinding: params.expectedSessionRuntimeOwnership
      ? (binding) =>
          assertCodexSessionRuntimeOwnership(binding, params.expectedSessionRuntimeOwnership)
      : undefined,
  });
  let startupBinding = admittedBinding;
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
  const resolveRuntimeOptionsForBinding = (
    binding: CodexAppServerThreadBinding | undefined,
    selection: { modelProvider?: string; model?: string },
  ) =>
    resolveCodexBindingAppServerConnection({
      binding,
      pluginConfig,
      execPolicy,
      modelProvider: selection.modelProvider,
      model: selection.model,
      config: params.config,
      agentDir,
      requirementsToml,
      openClawSandboxActive: sandbox?.enabled === true,
      sessionPermissionMode: params.permissionMode,
    }).appServer;
  const initialStartupBindingHadInactiveThreadBootstrap =
    isInactiveThreadBootstrapBinding(startupBinding);
  const appServerHomeScope = resolveCodexAppServerHomeScope({
    appServer: pluginConfig.appServer,
  });
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
        homeScope: appServerHomeScope,
        requirePreparedAuth: isCodexRemoteExecPlacementSandbox(sandbox),
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
    usesSupervisionConnection ||
    appServerHomeScope === "user" ||
    startupPreparedAuth?.kind === "api-key"
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
  let configuredAppServer = resolveRuntimeOptionsForBinding(startupBinding, {
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
  const sessionPermissionCwd = resolveCodexSessionPermissionCwd({
    permissionMode: params.permissionMode,
    sessionRoot: params.sessionRoot,
    defaultRoot: effectiveWorkspace,
    requestedCwd,
    fallbackCwd: effectiveWorkspace,
  });
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : sessionPermissionCwd;
  if (effectiveWorkspace !== resolvedWorkspace) {
    await ensureCodexWorkspaceDirOnce(effectiveWorkspace);
  }
  preDynamicStartupStages.mark("effective-workspace");
  const applySessionPermissionPolicy = (
    appServer: typeof configuredAppServer,
    selection: { modelProvider?: string; model?: string },
  ) =>
    applyCodexSessionPermissionPolicy({
      appServer,
      permissionMode: params.permissionMode,
      sessionRoot: params.sessionRoot,
      defaultRoot: effectiveWorkspace,
      pluginConfig,
      canUseAutoReview: canUseCodexModelBackedApprovalsReviewerForModel({
        modelProvider: selection.modelProvider,
        model: selection.model,
        config: params.config,
        env: { ...process.env, ...appServer.start.env, ...shellEnvironment },
        agentDir,
        homeScope: appServer.start.homeScope,
        codexArgs: appServer.start.args,
      }),
      requirementsToml,
      policyLocked: startupBinding?.connectionScope === "supervision",
      execMode: execPolicy.mode,
    });
  const resolveFinalAppServer = (
    configured: typeof configuredAppServer,
    selection: { modelProvider?: string; model?: string },
  ) => {
    const session = applySessionPermissionPolicy(configured, selection);
    const trusted = resolveCodexAppServerForModelProvider({
      appServer: session,
      provider: selection.modelProvider,
      model: selection.model,
      config: params.config,
      env: { ...process.env, ...session.start.env, ...shellEnvironment },
      agentDir,
    });
    return { session, appServer: withPreparedProcessEnv(trusted) };
  };
  let resolvedAppServer = resolveFinalAppServer(configuredAppServer, reviewerPolicyContext);
  let appServer = resolvedAppServer.appServer;
  preDynamicStartupStages.mark("app-server-policy");
  preDynamicStartupStages.mark("native-hook-relay");
  const terminalState = {
    turnSucceeded: false,
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
  try {
    const startupBindingBeforeRotation = startupBinding;
    const startupBindingResolution = await rotateOversizedCodexAppServerStartupBinding({
      assertCurrent,
      binding: startupBinding,
      bindingStore,
      identity: bindingIdentity,
      sessionFile: params.sessionFile,
      agentDir,
      codexHome: appServer.start.env?.CODEX_HOME,
      config: params.config,
      contextEngineActive: Boolean(activeContextEngine),
      expectedSessionRuntimeOwnership: params.expectedSessionRuntimeOwnership,
    });
    startupBinding = startupBindingResolution.binding;
    const initialInactiveThreadBootstrapBindingForcedFreshStart =
      initialStartupBindingHadInactiveThreadBootstrap && !startupBinding?.threadId;
    preDynamicStartupStages.mark("rotate-binding");
    // Rotation returns the original binding on the common resume path; only a
    // cleared or replaced native thread changes its model, policy, or connection.
    if (startupBinding !== startupBindingBeforeRotation) {
      reviewerPolicyContext = resolveReviewerPolicyContext(startupBinding);
      configuredAppServer = resolveRuntimeOptionsForBinding(startupBinding, {
        modelProvider: reviewerPolicyContext.modelProvider,
        model: reviewerPolicyContext.model,
      });
      resolvedAppServer = resolveFinalAppServer(configuredAppServer, reviewerPolicyContext);
      appServer = resolvedAppServer.appServer;
    }
    const sessionPermissionPolicy = resolveCodexEffectiveSessionPermissionPolicy({
      appServer,
      permissionMode: params.permissionMode,
      sessionRoot: params.sessionRoot,
      defaultRoot: effectiveWorkspace,
    });
    if (sessionPermissionPolicy) {
      params.permissionMode = sessionPermissionPolicy.mode;
      params.sessionRoot = sessionPermissionPolicy.root;
      (params.execOverrides ??= {}).mode = sessionPermissionPolicy.execMode;
    }
    const nativeHookRelayEvents = resolveCodexNativeHookRelayEvents({
      configuredEvents: options.nativeHookRelay?.events,
      appServer,
    });
    const mutable = {
      startupBinding,
      startupContextTokens: startupBindingResolution.startupContextTokens,
      pluginAppServer: appServer,
      // Captured before rotation: a rotated-away thread's observed density is the
      // best available sample for sizing the fresh thread's continuity projection.
      continuityCalibration: startupBindingBeforeRotation?.continuityCalibration,
    };
    const resolveRuntimeOptionsForCurrentBinding = (selection: {
      modelProvider?: string;
      model?: string;
    }) =>
      resolveFinalAppServer(
        resolveRuntimeOptionsForBinding(mutable.startupBinding, selection),
        selection,
      ).appServer;
    assertCurrent();
    // Host capabilities are identity-keyed; carry generation proof separately.
    return {
      params,
      assertCurrent,
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
      policyAgentId,
      resolvedWorkspace,
      sandboxSessionKey,
      contextSessionKey,
      sandbox,
      agentDir,
      shellEnvironment,
      disableLoginShell,
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
      sessionPermissionPolicy,
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
  } catch (error) {
    // The attempt owns this listener only after connection preparation returns.
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
    throw error;
  }
}

export type CodexAttemptConnection = Awaited<ReturnType<typeof prepareCodexAttemptConnection>>;
