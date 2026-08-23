import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import { redactSetupInferenceError } from "./setup-inference-activate.js";
import {
  type ActivateSetupInferenceDeps,
  type BoundVerifySetupInferenceResult,
  type CompleteSetupInferenceResult,
  type VerifySetupInferenceResult,
  invalidSetupConfigError,
} from "./setup-inference-core.js";
import { revalidateStableSetupInferenceOwner } from "./setup-inference-owner.js";
import {
  cleanupSetupInferenceTempDir,
  persistManualAuthProfiles,
  runSetupInferenceTest,
} from "./setup-inference-persist.js";
import type { SetupInferenceTestPlan } from "./setup-inference-plan-helpers.js";
import { buildTestPlan } from "./setup-inference-plan.js";
import {
  captureSystemAgentOwnerPluginArtifacts,
  hasCurrentSystemAgentOwnerPluginArtifacts,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentOwnerPluginArtifactSnapshot,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type VerifySetupInferenceParams = {
  kind?: "existing-model";
  agentId?: string;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
};

/** Live-test the configured default model without changing config or auth state. */
export function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession: true },
): Promise<BoundVerifySetupInferenceResult>;

export function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession?: false },
): Promise<VerifySetupInferenceResult>;

export async function verifySetupInference(
  params: VerifySetupInferenceParams & { bindSession?: boolean },
): Promise<VerifySetupInferenceResult | BoundVerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
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
    return {
      ok: false,
      status: "format",
      error: invalidSetupConfigError(snapshot),
    };
  }
  const cfg: OpenClawConfig = snapshot.runtimeConfig ?? snapshot.config;
  const baselineRoute = await projectInferenceRoute(cfg, params.agentId);
  let verifiedBinding: SystemAgentVerifiedInferenceBinding | undefined;
  const verification = await verifySetupInferenceConfig({
    config: cfg,
    runtime: params.runtime,
    requireExecutionOwner: params.bindSession === true,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.deps ? { deps: params.deps } : {}),
    ...(params.bindSession
      ? {
          onVerifiedExecution: (
            _auth: AgentExecutionAuthBinding,
            binding: SystemAgentVerifiedInferenceBinding,
          ) => {
            verifiedBinding = binding;
          },
        }
      : {}),
  });
  if (!verification.ok) {
    return verification;
  }
  const latestSnapshot = await readSnapshot().catch(() => null);
  const latestConfig =
    latestSnapshot?.exists && latestSnapshot.valid
      ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
      : undefined;
  const latestRoute = latestConfig
    ? await projectInferenceRoute(latestConfig, params.agentId)
    : undefined;
  if (!latestRoute || !sameDefaultInferenceRoute(baselineRoute, latestRoute)) {
    return {
      ok: false,
      status: "unknown",
      error:
        "The inference route changed during its live test. Review current model/auth/runtime settings and retry.",
    };
  }
  if (!params.bindSession) {
    return verification;
  }
  const configuredRoute = await resolveSystemAgentConfiguredRouteFromConfig(cfg, params.agentId);
  if (!configuredRoute || !verifiedBinding) {
    return {
      ok: false,
      status: "unknown",
      error:
        "The successful inference run did not report an exact execution binding. Retry setup before starting OpenClaw.",
    };
  }
  return { ...verification, binding: verifiedBinding };
}

type BoundSetupInferenceVerifier = (params: {
  runtime: RuntimeEnv;
  bindSession: true;
  agentId?: string;
  deps?: ActivateSetupInferenceDeps;
}) => Promise<BoundVerifySetupInferenceResult>;

export type ResolvePersistentApplyInferenceDeps = SystemAgentVerifiedInferenceDeps & {
  resolveVerifiedInferenceRoute?: typeof resolveSystemAgentVerifiedInferenceRoute;
  hasCurrentOwnerPluginArtifacts?: typeof hasCurrentSystemAgentOwnerPluginArtifacts;
  verifyBoundInference?: BoundSetupInferenceVerifier;
};

function executionRouteIdentity(route: SystemAgentConfiguredRoute): unknown {
  const { runConfig: _runConfig, ...identity } = route;
  return identity;
}

/**
 * Strict credentials need only the static owner check. Opaque runtimes can
 * prove liveness only by completing another exact turn at the side-effect
 * boundary; the result must still be the original frozen route.
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
  // The live probe is not a lock. Recheck the authored route after it returns,
  // then keep using the original frozen execution snapshot.
  const finalRoute = await resolveVerified(params.binding, deps);
  if (!finalRoute || !(await hasCurrentOwnerPluginArtifacts(params.binding, deps))) {
    return null;
  }
  return finalRoute;
}

/** Live-test a staged default-agent route before any caller persists it. */
export async function verifySetupInferenceConfig(params: {
  config: OpenClawConfig;
  /** Candidate profiles staged in the isolated probe store, never the real agent store. */
  authProfiles?: ProviderAuthResult["profiles"];
  agentId?: string;
  /** Explicit isolated agent directory for staged onboarding verification. */
  agentDir?: string;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
  /** Internal session gate: capture only the final exact successful credential. */
  onVerifiedExecution?: (
    auth: AgentExecutionAuthBinding,
    binding: SystemAgentVerifiedInferenceBinding,
  ) => void;
  /** Reject a successful turn unless its runner reports the exact execution owner. */
  requireExecutionOwner?: boolean;
}): Promise<VerifySetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const cfg = params.config;
  const routeAgentId = normalizeAgentId(params.agentId ?? resolveDefaultAgentId(cfg));
  if (!resolveAgentEffectiveModelPrimary(cfg, routeAgentId)) {
    return {
      ok: false,
      status: "unavailable",
      error: "No agent model is configured. Run `openclaw onboard` first.",
    };
  }
  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  try {
    const builtPlan = await buildTestPlan({
      kind: "existing-model",
      cfg,
      sourceCfg: cfg,
      workspaceDir: tempDir,
      pluginWorkspaceDir: tempDir,
      agentDir: path.join(tempDir, "agent"),
      runtime: params.runtime,
      routeAgentId,
      deps,
    });
    if ("error" in builtPlan) {
      return {
        ok: false,
        status: builtPlan.status ?? "unavailable",
        error: builtPlan.error,
      };
    }
    let plan: SetupInferenceTestPlan = params.agentDir
      ? { ...builtPlan, agentDir: params.agentDir }
      : builtPlan;
    if (params.authProfiles && params.authProfiles.length > 0) {
      const selectedProfile = plan.authProfileId
        ? params.authProfiles.find((profile) => profile.profileId === plan.authProfileId)
        : params.authProfiles.find(
            (profile) =>
              normalizeProviderId(profile.credential.provider) ===
              normalizeProviderId(plan.provider),
          );
      if (!selectedProfile) {
        return {
          ok: false,
          status: "auth",
          error: plan.authProfileId
            ? "The staged credential does not match the configured auth profile."
            : "The staged credential does not belong to the configured inference provider.",
        };
      }
      const stagedAgentDir = path.join(tempDir, "agent");
      const staged = await persistManualAuthProfiles({
        profiles: params.authProfiles,
        agentDir: stagedAgentDir,
        deps,
      });
      if (staged.status !== "persisted") {
        return {
          ok: false,
          status: "unknown",
          error:
            "Could not stage the credential for its live inference test; try again in a moment.",
        };
      }
      plan = {
        ...plan,
        agentDir: stagedAgentDir,
        authProfileId: selectedProfile.profileId,
      };
    }
    const readStagedAuthProfiles = (): ProviderAuthResult["profiles"] | undefined => {
      if (!params.authProfiles || params.authProfiles.length === 0) {
        return undefined;
      }
      const loadStore = deps.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
      const { profiles } = loadStore(plan.agentDir, {
        readOnly: true,
        allowKeychainPrompt: false,
        config: plan.config,
        externalCliProviderIds: [plan.provider],
      });
      return params.authProfiles.map((profile) => {
        const credential = profiles[profile.profileId];
        if (!credential) {
          throw new Error("staged profile missing after verification");
        }
        return { profileId: profile.profileId, credential };
      });
    };
    const retainStagedAuthProfiles = () => {
      try {
        return { ok: true as const, authProfiles: readStagedAuthProfiles() };
      } catch {
        return {
          ok: false as const,
          result: {
            ok: false as const,
            status: "unknown" as const,
            error: "Could not retain the credential after its live inference test.",
          },
        };
      }
    };
    const requiresExecutionOwner =
      params.requireExecutionOwner === true || params.onVerifiedExecution !== undefined;
    let configuredRoute:
      | NonNullable<Awaited<ReturnType<typeof resolveSystemAgentConfiguredRouteFromConfig>>>
      | undefined;
    let stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot | undefined;
    if (requiresExecutionOwner) {
      configuredRoute =
        (await resolveSystemAgentConfiguredRouteFromConfig(cfg, routeAgentId)) ?? undefined;
      if (!configuredRoute) {
        return {
          ok: false,
          status: "unknown",
          error: "The verified inference route could not be resolved for owner validation.",
        };
      }
      try {
        stagedOwnerPluginArtifacts = (
          deps.captureSystemAgentOwnerPluginArtifacts ?? captureSystemAgentOwnerPluginArtifacts
        )({
          config: cfg,
          executionRoute: configuredRoute,
          deps,
        });
      } catch {
        return {
          ok: false,
          status: "unavailable",
          error:
            "Could not bind the configured inference plugin runtime. Refresh or reinstall the plugin and retry.",
        };
      }
    }
    let test = await runSetupInferenceTest({
      plan,
      tempDir,
      deps,
      authProfileStateMode: "read-only",
      requireExecutionOwner: requiresExecutionOwner,
    });
    let retained = retainStagedAuthProfiles();
    if (!retained.ok) {
      return retained.result;
    }
    let authProfiles = retained.authProfiles;
    if (test.ok) {
      const verifiedProfileId = test.auth.authProfileId;
      if (plan.authProfileId && verifiedProfileId !== plan.authProfileId) {
        return {
          ok: false,
          status: "auth",
          error: `The inference run used profile "${verifiedProfileId ?? "unknown"}" instead of the configured profile "${plan.authProfileId}".`,
          ...(authProfiles ? { authProfiles } : {}),
        };
      }
      if (params.onVerifiedExecution && !plan.authProfileId && verifiedProfileId) {
        // Auto-selection may rotate through several profiles before succeeding.
        // Re-run once with the winner locked so the session proof cannot bind a
        // credential that never completed an exact, non-rotating turn.
        test = await runSetupInferenceTest({
          plan: { ...plan, authProfileId: verifiedProfileId },
          tempDir,
          deps,
          authProfileStateMode: "read-only",
          requireExecutionOwner: true,
        });
        retained = retainStagedAuthProfiles();
        if (!retained.ok) {
          return retained.result;
        }
        authProfiles = retained.authProfiles;
        if (!test.ok) {
          return {
            ...test,
            error: await redactSetupInferenceError(test.error),
            ...(authProfiles ? { authProfiles } : {}),
          };
        }
        if (test.auth.authProfileId !== verifiedProfileId) {
          return {
            ok: false,
            status: "auth",
            error: "The selected inference credential changed during its locked verification.",
            ...(authProfiles ? { authProfiles } : {}),
          };
        }
      }
      if (params.requireExecutionOwner || params.onVerifiedExecution) {
        try {
          const binding = await revalidateStableSetupInferenceOwner({
            route: configuredRoute!,
            auth: test.auth,
            stagedOwnerPluginArtifacts,
            deps,
          });
          params.onVerifiedExecution?.(test.auth, binding);
        } catch {
          return {
            ok: false,
            status: "auth",
            error:
              "The verified inference owner changed before validation completed. Retry the inference check.",
            ...(authProfiles ? { authProfiles } : {}),
          };
        }
      }
      return {
        ok: true,
        latencyMs: test.latencyMs,
        modelRef: plan.modelRef,
        ...(authProfiles ? { authProfiles } : {}),
      };
    }
    return {
      ...test,
      error: await redactSetupInferenceError(test.error),
      ...(authProfiles ? { authProfiles } : {}),
    };
  } finally {
    await cleanupSetupInferenceTempDir({ tempDir, deps, runtime: params.runtime });
  }
}

/** Run one tool-free completion through the configured setup inference route. */
export async function completeSetupInference(params: {
  prompt: string;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
}): Promise<CompleteSetupInferenceResult> {
  const readSnapshot =
    params.deps?.readConfigFileSnapshot ??
    (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists) {
    return { ok: false, status: "unavailable", error: "No OpenClaw config exists." };
  }
  if (!snapshot.valid) {
    return { ok: false, status: "format", error: invalidSetupConfigError(snapshot) };
  }
  return await completeSetupInferenceConfig({
    config: snapshot.runtimeConfig ?? snapshot.config,
    prompt: params.prompt,
    runtime: params.runtime,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.deps ? { deps: params.deps } : {}),
  });
}

/** Config-injected variant used by setup clients and live provider tests. */
export async function completeSetupInferenceConfig(params: {
  config: OpenClawConfig;
  prompt: string;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  deps?: ActivateSetupInferenceDeps;
}): Promise<CompleteSetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const routeAgentId = normalizeAgentId(resolveDefaultAgentId(params.config));
  if (!resolveAgentEffectiveModelPrimary(params.config, routeAgentId)) {
    return { ok: false, status: "unavailable", error: "No agent model is configured." };
  }
  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  try {
    const plan = await buildTestPlan({
      kind: "existing-model",
      cfg: params.config,
      sourceCfg: params.config,
      workspaceDir: tempDir,
      pluginWorkspaceDir: tempDir,
      agentDir: path.join(tempDir, "agent"),
      runtime: params.runtime,
      routeAgentId,
      deps,
    });
    if ("error" in plan) {
      return {
        ok: false,
        status: plan.status ?? "unavailable",
        error: plan.error,
      };
    }
    const result = await runSetupInferenceTest({
      plan,
      prompt: params.prompt,
      tempDir,
      deps,
      authProfileStateMode: "read-only",
      requireExecutionOwner: false,
    });
    if (!result.ok) {
      return { ...result, error: await redactSetupInferenceError(result.error) };
    }
    if (plan.authProfileId && result.auth.authProfileId !== plan.authProfileId) {
      return {
        ok: false,
        status: "auth",
        error: "The inference completion used a different credential than the configured route.",
      };
    }
    return {
      ok: true,
      modelRef: plan.modelRef,
      latencyMs: result.latencyMs,
      text: result.text,
    };
  } finally {
    await cleanupSetupInferenceTempDir({ tempDir, deps, runtime: params.runtime });
  }
}
