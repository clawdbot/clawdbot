// One tool-free confirmation turn through the configured inference route.
// Verify, activate, app matching, and the system-agent session gate all run it.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  type AgentRunResultView,
  extractAgentRunTerminalError,
  extractAgentRunText,
} from "../agents/agent-run-result.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store.js";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { describeFailoverError } from "../agents/failover-error.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { AgentHarnessPluginSelection } from "../agents/harness/runtime-plugin-load-plan.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { buildAgentRuntimeAuthPlan } from "../agents/runtime-plan/auth.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import { SessionManager } from "../agents/sessions/index.js";
import { GEMINI_CLI_DEFAULT_MODEL_REF } from "../commands/onboard-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryForContext } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import {
  type BoundVerifySetupInferenceResult,
  type CompleteSetupInferenceResult,
  invalidSetupConfigError,
  redactSetupInferenceError,
  SETUP_INFERENCE_TEST_PROMPT,
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceCancelledError,
  type SetupInferenceDeps,
  type SetupInferenceFailureStatus,
  setupInferenceLog,
  type VerifySetupInferenceResult,
} from "./setup-inference-core.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  hasCurrentSystemAgentOwnerPluginArtifacts,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

const SETUP_INFERENCE_TEST_MAX_TOKENS = 256;

const SETUP_STATUS_BY_FAILOVER_REASON = {
  auth: "auth",
  auth_permanent: "auth",
  format: "format",
  rate_limit: "rate_limit",
  overloaded: "rate_limit",
  billing: "billing",
  server_error: "unknown",
  timeout: "timeout",
  tls_certificate: "unknown",
  context_overflow: "unknown",
  model_not_found: "format",
  session_expired: "unknown",
  empty_response: "unknown",
  no_error_details: "unknown",
  unclassified: "unknown",
  unknown: "unknown",
} satisfies Record<FailoverReason, SetupInferenceFailureStatus>;

export function mapFailoverReasonToSetupStatus(
  reason?: string | null,
): SetupInferenceFailureStatus {
  return reason
    ? (SETUP_STATUS_BY_FAILOVER_REASON[reason as FailoverReason] ?? "unknown")
    : "unknown";
}

type SetupTurnFailure = { ok: false; status: SetupInferenceFailureStatus; error: string };

type SetupTurnSuccess = {
  ok: true;
  latencyMs: number;
  text: string;
  auth: AgentExecutionAuthBinding;
};

function parseRef(modelRef: string): { provider: string; model: string } {
  const slash = modelRef.indexOf("/");
  return slash === -1
    ? { provider: modelRef, model: "" }
    : { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
}

/** CLI backends need a hard tool-free mode; the probe must not let a CLI act on the host. */
function resolveToolFreeCliSetupError(route: SystemAgentConfiguredRoute): string | undefined {
  if (route.runner !== "cli") {
    return undefined;
  }
  const backend = resolveCliBackendConfig(route.provider, route.runConfig, {
    agentId: route.agentId,
  });
  if (backend?.sideQuestionToolMode === "disabled") {
    return undefined;
  }
  const geminiCliProvider = parseRef(GEMINI_CLI_DEFAULT_MODEL_REF).provider;
  if (backend?.nativeToolMode === "none" && route.provider !== geminiCliProvider) {
    return undefined;
  }
  return route.provider === geminiCliProvider
    ? "Gemini CLI cannot be used for inference-gated setup because it has no hard tool-free mode. Choose Claude Code, Codex, or an API-key provider; normal Gemini CLI agent runs remain available after setup."
    : `CLI backend ${backend?.id ?? route.provider} cannot be used for inference-gated setup because it has no hard tool-free mode. Choose another inference provider.`;
}

/** A pinned profile must exist and belong to the route before any request leaves the host. */
function resolveConfiguredProfileError(
  route: SystemAgentConfiguredRoute,
  workspaceDir: string,
  deps: SetupInferenceDeps,
): string | undefined {
  const profileId = route.authProfileId?.trim();
  if (!profileId) {
    return undefined;
  }
  const loadStore = deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const store = loadStore(route.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    config: route.runConfig,
    externalCliProviderIds: [route.provider],
  });
  const credential = store.profiles[profileId];
  if (!credential) {
    return `No credentials found for the configured setup profile "${profileId}".`;
  }
  if (route.runner === "embedded") {
    const authPlan = buildAgentRuntimeAuthPlan({
      provider: route.provider,
      authProfileProvider: credential.provider,
      authProfileMode: credential.type,
      sessionAuthProfileId: profileId,
      config: route.runConfig,
      workspaceDir,
      harnessId: route.agentHarnessRuntimeOverride,
      harnessRuntime: route.agentHarnessRuntimeOverride,
      allowHarnessAuthProfileForwarding: true,
    });
    if (authPlan.forwardedAuthProfileId === profileId) {
      return undefined;
    }
  } else {
    const aliasContext = { config: route.runConfig, workspaceDir };
    try {
      if (
        resolveProviderIdForAuth(route.provider, aliasContext) ===
        resolveProviderIdForAuth(credential.provider, aliasContext)
      ) {
        return undefined;
      }
    } catch {
      return `Could not verify that configured setup profile "${profileId}" belongs to the selected ${route.provider} inference route.`;
    }
  }
  return `Configured setup profile "${profileId}" belongs to ${credential.provider}, not the selected ${route.provider} inference route.`;
}

async function resolveRunWinnerError(
  route: SystemAgentConfiguredRoute,
  result: AgentRunResultView,
): Promise<string | undefined> {
  const winnerProvider = result.meta?.executionTrace?.winnerProvider?.trim();
  const winnerModel = result.meta?.executionTrace?.winnerModel?.trim();
  if (!winnerProvider || !winnerModel) {
    return "The inference run did not report which provider and model produced its reply.";
  }
  if (winnerProvider === route.provider) {
    if (winnerModel === route.model) {
      return undefined;
    }
    const { resolveDirectBundledProviderPolicySurface } =
      await import("../plugins/provider-policy-surface.js");
    const equivalent = resolveDirectBundledProviderPolicySurface(
      route.provider,
    )?.isResponseModelEquivalent?.({
      provider: route.provider,
      requestedModelId: route.model,
      responseModelId: winnerModel,
    });
    if (equivalent === true) {
      return undefined;
    }
  }
  return `The inference run answered through ${winnerProvider}/${winnerModel} instead of the requested ${route.provider}/${route.model}. Disable model-routing overrides or choose the working route directly, then retry.`;
}

/**
 * Runs one bounded, tool-free turn through the exact configured route. The turn is evidence,
 * never a mutation: auth state stays read-only and the prepared runtime stays isolated so a
 * staged config can be tested before it is written.
 */
export async function runSetupInferenceTurn(params: {
  route: SystemAgentConfiguredRoute;
  prompt?: string;
  deps: SetupInferenceDeps;
  requireExecutionOwner: boolean;
  signal?: AbortSignal;
}): Promise<SetupTurnSuccess | SetupTurnFailure> {
  const { route, deps } = params;
  // Probe ids stay under OpenAI's 64-char session cap and match the command-lane log filters.
  const runId = `probe-setup-inference-${randomUUID()}`;
  const sessionKey = `agent:${route.agentId}:setup-inference:incognito-${runId}`;
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  // A scratch workspace keeps the probe from reading the real workspace's bootstrap files.
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-"));
  const failed = (status: SetupInferenceFailureStatus, error: string): SetupTurnFailure => {
    setupInferenceLog.warn("Inference setup probe failed.", {
      event: "setup_inference_probe_failed",
      provider: route.provider,
      model: route.model,
      runner: route.runner,
      status,
      timeoutMs,
      durationMs: Date.now() - started,
    });
    return { ok: false, status, error };
  };
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    route.runConfig,
    runId,
    route.agentId,
    "system-agent.setup-inference",
  );
  let successfulAuth: AgentExecutionAuthBinding | undefined;
  const shared = {
    preparedRunAdmission,
    sessionId: runId,
    sessionKey,
    sessionManager: SessionManager.inMemory(workspaceDir),
    agentId: route.agentId,
    trigger: "manual" as const,
    sessionFile: `in-memory:${runId}`,
    workspaceDir,
    agentDir: route.agentDir,
    config: route.runConfig,
    prompt: params.prompt ?? SETUP_INFERENCE_TEST_PROMPT,
    provider: route.provider,
    model: route.model,
    timeoutMs,
    runId,
    messageChannel: "openclaw",
    messageProvider: "openclaw",
    disableTools: true,
    onSuccessfulAuthBinding: (binding: AgentExecutionAuthBinding) => {
      successfulAuth = binding;
    },
    ...(params.signal ? { abortSignal: params.signal } : {}),
  };
  try {
    const cliError = resolveToolFreeCliSetupError(route);
    if (cliError) {
      return failed("unavailable", cliError);
    }
    const profileError = resolveConfiguredProfileError(route, workspaceDir, deps);
    if (profileError) {
      return failed("auth", profileError);
    }
    let result: AgentRunResultView;
    if (route.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = (await runCli({
        ...shared,
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
        executionMode: "side-question",
        cleanupCliLiveSessionOnRunEnd: true,
      })) as AgentRunResultView;
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      const harness = route.agentHarnessRuntimeOverride;
      result = (await runEmbedded({
        ...shared,
        // The probe owns its transcript; session admission must not create durable agent state.
        sessionPersistence: "detached",
        ...(route.authProfileId
          ? { authProfileId: route.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        authProfileStateMode: "read-only",
        preparedModelRuntimeMode: "isolated-read-only",
        ...(harness === "codex" ? { cleanupBundleMcpOnRunEnd: true } : {}),
        ...(harness ? { agentHarnessRuntimeOverride: harness } : {}),
        lane: `session:probe-setup-inference:${route.provider}`,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        disableTrajectory: true,
        // The "reply OK" probe stays bounded; custom completions keep the model's own budget.
        ...(params.prompt === undefined && (!harness || harness === "openclaw")
          ? { streamParams: { maxTokens: SETUP_INFERENCE_TEST_MAX_TOKENS } }
          : {}),
        modelRun: true,
      })) as AgentRunResultView;
    }
    if (params.signal?.aborted) {
      throw new SetupInferenceCancelledError();
    }
    const terminalError = extractAgentRunTerminalError(result);
    if (terminalError) {
      const described = describeFailoverError(new Error(terminalError));
      return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
    }
    const text = extractAgentRunText(result)?.trim();
    if (!text) {
      return failed(
        "format",
        "The model started but did not send a reply. Try again or pick another option.",
      );
    }
    const winnerError = await resolveRunWinnerError(route, result);
    if (winnerError) {
      return failed("unknown", winnerError);
    }
    if (route.authProfileId && successfulAuth?.authProfileId !== route.authProfileId) {
      return failed(
        "auth",
        `The inference run used profile "${successfulAuth?.authProfileId ?? "unknown"}" instead of the configured profile "${route.authProfileId}".`,
      );
    }
    if (params.requireExecutionOwner && !successfulAuth) {
      return failed(
        "unknown",
        "Inference succeeded, but its runtime did not report an owner that OpenClaw can safely reuse.",
      );
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      text,
      auth: successfulAuth ?? (route.authProfileId ? { authProfileId: route.authProfileId } : {}),
    };
  } catch (error) {
    const described = describeFailoverError(error);
    return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
  } finally {
    preparedRunAdmission.close();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

type SetupInferenceOwnerDeps = SystemAgentVerifiedInferenceDeps & {
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
};

/** Setup owns fresh package facts without replacing the Gateway's startup generation. */
export function loadSetupInferencePluginGeneration(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  selection: AgentHarnessPluginSelection;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
}) {
  // Revalidation must select the probed artifacts: switching a built Gateway owner to source
  // files would report drift even when neither tree changed.
  const preferBuiltPluginArtifacts = getPluginRuntimeLoadContext(
    getPluginRegistryForContext() ?? undefined,
  )?.preferBuiltPluginArtifacts;
  // The install lease may have cached absence before writing the package; capture new facts
  // without retiring that lease's cache.
  return withPluginCache(createPluginCache(), () => {
    const generation = {
      config: params.config,
      metadataSnapshot: (params.resolvePluginMetadataSnapshot ?? resolvePluginMetadataSnapshot)({
        config: params.config,
        env: process.env,
        workspaceDir: params.workspaceDir,
        allowCurrent: false,
      }),
    };
    const pluginRegistry = withPluginRuntimeGenerationScope(generation, () =>
      loadAgentRuntimePluginRegistryHandle({
        config: params.config,
        workspaceDir: params.workspaceDir,
        metadataSnapshot: generation.metadataSnapshot,
        preferBuiltPluginArtifacts,
        selections: [params.selection],
      }),
    );
    if (!pluginRegistry) {
      throw new Error(`Could not load the ${params.selection.runtime} runtime plugin.`);
    }
    return { ...generation, pluginRegistry };
  });
}

/** Mints the frozen owner proof for a turn that just succeeded on this exact route. */
export async function bindSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  deps: SetupInferenceOwnerDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const { route, auth, deps } = params;
  const configuredHarnessId =
    route.runner === "embedded" ? route.agentHarnessRuntimeOverride?.trim() : undefined;
  const successfulHarnessId =
    auth.agentHarnessId?.trim() ||
    (configuredHarnessId && configuredHarnessId !== "auto" ? configuredHarnessId : undefined);
  const createBinding = () =>
    (deps.createSystemAgentVerifiedInferenceBinding ?? createSystemAgentVerifiedInferenceBinding)({
      configuredRoute: route,
      executionRoute: route,
      auth,
      deps,
    });
  if (route.runner !== "embedded" || !successfulHarnessId || successfulHarnessId === "openclaw") {
    return await createBinding();
  }
  const workspaceDir = resolveAgentWorkspaceDir(route.runConfig, route.agentId, process.env);
  const generation = loadSetupInferencePluginGeneration({
    config: route.runConfig,
    workspaceDir,
    selection: {
      provider: route.provider,
      modelId: route.model,
      runtime: successfulHarnessId,
      agentId: route.agentId,
    },
    resolvePluginMetadataSnapshot: deps.resolvePluginMetadataSnapshot,
  });
  return await withPluginRuntimeGenerationScope(generation, createBinding);
}

async function readSetupConfig(
  deps: SetupInferenceDeps,
): Promise<{ config: OpenClawConfig } | SetupTurnFailure> {
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists) {
    return {
      ok: false,
      status: "unavailable",
      error: "No OpenClaw config exists. Run `openclaw onboard` first.",
    };
  }
  if (!snapshot.valid) {
    return { ok: false, status: "format", error: invalidSetupConfigError(snapshot) };
  }
  return { config: snapshot.runtimeConfig ?? snapshot.config };
}

type VerifyParams = {
  agentId?: string;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: SetupInferenceDeps;
};

/** Live-test a config's default-agent route without changing config or auth state. */
export async function verifySetupInferenceConfig(
  params: VerifyParams & { config: OpenClawConfig; bindSession?: boolean },
): Promise<VerifySetupInferenceResult | BoundVerifySetupInferenceResult> {
  const deps: SetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const route = await resolveSystemAgentConfiguredRouteFromConfig(params.config, params.agentId, {
    loadAuthProfileStoreForRuntime: deps.loadAuthProfileStoreForRuntime,
  });
  if (!route) {
    return {
      ok: false,
      status: "unavailable",
      error: "No agent model is configured. Run `openclaw onboard` first.",
    };
  }
  const turn = await runSetupInferenceTurn({
    route,
    deps,
    requireExecutionOwner: params.bindSession === true,
  });
  if (!turn.ok) {
    return { ...turn, error: await redactSetupInferenceError(turn.error) };
  }
  if (!params.bindSession) {
    return { ok: true, modelRef: route.modelLabel, latencyMs: turn.latencyMs };
  }
  try {
    const binding = await bindSetupInferenceOwner({ route, auth: turn.auth, deps });
    return { ok: true, modelRef: route.modelLabel, latencyMs: turn.latencyMs, binding };
  } catch {
    return {
      ok: false,
      status: "auth",
      error:
        "The verified inference owner changed before validation completed. Retry the inference check.",
    };
  }
}

/** Live-test the saved default model without changing config or auth state. */
export function verifySetupInference(
  params: VerifyParams & { bindSession: true },
): Promise<BoundVerifySetupInferenceResult>;
export function verifySetupInference(
  params: VerifyParams & { bindSession?: false },
): Promise<VerifySetupInferenceResult>;
export async function verifySetupInference(
  params: VerifyParams & { bindSession?: boolean },
): Promise<VerifySetupInferenceResult | BoundVerifySetupInferenceResult> {
  const read = await readSetupConfig(params.deps ?? {});
  if ("ok" in read) {
    return read;
  }
  return await verifySetupInferenceConfig({ ...params, config: read.config });
}

/** One free-prompt completion through the configured route (app recommendations). */
export async function completeSetupInference(params: {
  prompt: string;
  agentId?: string;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: SetupInferenceDeps;
}): Promise<CompleteSetupInferenceResult> {
  const deps: SetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const read = await readSetupConfig(deps);
  if ("ok" in read) {
    return read;
  }
  const route = await resolveSystemAgentConfiguredRouteFromConfig(read.config, params.agentId, {
    loadAuthProfileStoreForRuntime: deps.loadAuthProfileStoreForRuntime,
  });
  if (!route) {
    return { ok: false, status: "unavailable", error: "No agent model is configured." };
  }
  const turn = await runSetupInferenceTurn({
    route,
    prompt: params.prompt,
    deps,
    requireExecutionOwner: false,
  });
  if (!turn.ok) {
    return { ...turn, error: await redactSetupInferenceError(turn.error) };
  }
  return { ok: true, modelRef: route.modelLabel, latencyMs: turn.latencyMs, text: turn.text };
}

export type ResolvePersistentApplyInferenceDeps = SystemAgentVerifiedInferenceDeps & {
  resolveVerifiedInferenceRoute?: typeof resolveSystemAgentVerifiedInferenceRoute;
  hasCurrentOwnerPluginArtifacts?: typeof hasCurrentSystemAgentOwnerPluginArtifacts;
  verifyBoundInference?: (params: {
    runtime: RuntimeEnv;
    bindSession: true;
    agentId?: string;
    deps?: SetupInferenceDeps;
  }) => Promise<BoundVerifySetupInferenceResult>;
};

function executionRouteIdentity(route: SystemAgentConfiguredRoute): unknown {
  const { runConfig: _runConfig, ...identity } = route;
  return identity;
}

/**
 * Re-proves a frozen session binding at a side-effect boundary. Strict credentials need only
 * the static owner check; opaque runtimes prove liveness with one more exact turn.
 */
export async function resolvePersistentApplyInference(params: {
  binding: SystemAgentVerifiedInferenceBinding;
  runtime: RuntimeEnv;
  deps?: ResolvePersistentApplyInferenceDeps;
}): Promise<SystemAgentConfiguredRoute | null> {
  const deps = params.deps ?? {};
  const resolveVerified =
    deps.resolveVerifiedInferenceRoute ?? resolveSystemAgentVerifiedInferenceRoute;
  const initialRoute = await resolveVerified(params.binding, deps);
  if (!initialRoute) {
    return null;
  }
  const hasCurrentOwnerPluginArtifacts =
    deps.hasCurrentOwnerPluginArtifacts ?? hasCurrentSystemAgentOwnerPluginArtifacts;
  if (!(await hasCurrentOwnerPluginArtifacts(params.binding, deps))) {
    return null;
  }
  if (params.binding.auth.proofKind !== "runtime-owner") {
    return initialRoute;
  }
  const verifyBound = deps.verifyBoundInference ?? verifySetupInference;
  const live = await verifyBound({
    runtime: params.runtime,
    bindSession: true,
    agentId: params.binding.execution.agentId,
    deps,
  });
  if (
    !live.ok ||
    !isDeepStrictEqual(live.binding.configuredRoute, params.binding.configuredRoute) ||
    !isDeepStrictEqual(
      executionRouteIdentity(live.binding.execution),
      executionRouteIdentity(params.binding.execution),
    ) ||
    !isDeepStrictEqual(live.binding.executionFingerprint, params.binding.executionFingerprint) ||
    !isDeepStrictEqual(live.binding.ownerPluginIds, params.binding.ownerPluginIds) ||
    !isDeepStrictEqual(live.binding.ownerPluginArtifacts, params.binding.ownerPluginArtifacts) ||
    !isDeepStrictEqual(live.binding.auth, params.binding.auth)
  ) {
    return null;
  }
  // The live turn is not a lock: recheck the authored route after it returns.
  const finalRoute = await resolveVerified(params.binding, deps);
  if (!finalRoute || !(await hasCurrentOwnerPluginArtifacts(params.binding, deps))) {
    return null;
  }
  return finalRoute;
}
