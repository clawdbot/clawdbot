import { isDeepStrictEqual } from "node:util";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { applyAutoLocalModelLean } from "../config/local-model-lean-auto.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  projectDefaultInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import { createSystemAgentModelSelectionUpdater } from "./setup-apply.js";
import {
  SetupInferenceActivationIndeterminateError,
  SetupInferenceActivationUnavailableError,
  log,
  throwIfSetupInferenceCancelled,
  type ActivateSetupInferenceDeps,
  type ActivateSetupInferenceParams,
  type ActivateSetupInferenceResult,
} from "./setup-inference-core.js";
import {
  configReferencesManualAuthProfiles,
  isCodexInstallRecordPersisted,
  manualAuthProfilesPersisted,
  persistManualAuthProfiles,
  rollbackManualAuthProfiles,
  applyManualAuthConfig,
  type ManualAuthPersistenceReceipt,
  runSetupInferenceTest,
} from "./setup-inference-persist.js";
import {
  projectSetupTargetModelMetadata,
  resolveSetupAgentRuntimeId,
  type SetupInferenceTestPlan,
} from "./setup-inference-plan-helpers.js";
import type { SystemAgentOwnerPluginArtifactSnapshot } from "./verified-inference.js";

type ProjectedInferenceRoute = Awaited<ReturnType<typeof projectDefaultInferenceRoute>>;

export type SetupInferenceActivationPersistenceState = {
  committedConfig: OpenClawConfig | undefined;
  autoLocalModelLeanApplied: boolean;
  codexInstallOwnership: "unknown" | "owned" | "unowned";
};

export async function persistActivatedSetupInference(input: {
  params: ActivateSetupInferenceParams;
  deps: ActivateSetupInferenceDeps;
  plan: SetupInferenceTestPlan;
  testPlan: SetupInferenceTestPlan;
  test: Extract<Awaited<ReturnType<typeof runSetupInferenceTest>>, { ok: true }>;
  codexPluginPatch: unknown;
  pendingCodexInstall: PluginInstallRecord | undefined;
  cfg: OpenClawConfig;
  sourceCfg: OpenClawConfig;
  verifiedRoute: ProjectedInferenceRoute;
  baselineRoute: ProjectedInferenceRoute;
  stagedRoute: NonNullable<ProjectedInferenceRoute["route"]>;
  stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot;
  baselineTargetModelMetadata: unknown;
  sourceTargetModelMetadata: unknown;
  readSnapshot: NonNullable<ActivateSetupInferenceDeps["readConfigFileSnapshot"]>;
  hasPreparedAuthProfiles: boolean;
  state: SetupInferenceActivationPersistenceState;
  revalidateOwner: (params: {
    route: SystemAgentConfiguredRoute;
    auth: AgentExecutionAuthBinding;
    stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot | undefined;
    deps: ActivateSetupInferenceDeps;
  }) => Promise<unknown>;
}): Promise<ActivateSetupInferenceResult | undefined> {
  const {
    params,
    deps,
    plan,
    testPlan,
    test,
    codexPluginPatch,
    pendingCodexInstall,
    cfg,
    sourceCfg,
    verifiedRoute,
    baselineRoute,
    stagedRoute,
    stagedOwnerPluginArtifacts,
    baselineTargetModelMetadata,
    sourceTargetModelMetadata,
    readSnapshot,
    hasPreparedAuthProfiles,
    state,
    revalidateOwner,
  } = input;
  let committedConfig: OpenClawConfig | undefined;
  let { codexInstallOwnership } = state;

  const { stripPendingPluginInstallRecords } = await import("../plugins/install-record-commit.js");
  const agentRuntimeId = resolveSetupAgentRuntimeId(params.kind);
  const selectModel = plan.persistModelRef
    ? await createSystemAgentModelSelectionUpdater({
        model: plan.persistModelRef,
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
      })
    : undefined;
  const stageCandidate = (
    current: OpenClawConfig,
    configKind: "runtime" | "source",
  ): OpenClawConfig => {
    let next = codexPluginPatch === undefined ? current : stripPendingPluginInstallRecords(current);
    if (plan.manualAuth) {
      next = applyManualAuthConfig(
        next,
        plan.manualAuth,
        configKind,
        deps.enablePluginInConfig ?? enablePluginInConfig,
      );
    }
    if (codexPluginPatch !== undefined) {
      const patched = applyMergePatch(next, codexPluginPatch) as OpenClawConfig;
      const enabledCodex = enablePluginInConfig(
        normalizePluginTargetConfig(patched, "codex"),
        "codex",
      );
      if (!enabledCodex.enabled) {
        throw new SetupInferenceActivationUnavailableError(
          `Could not enable the Codex runtime plugin: ${enabledCodex.reason ?? "plugin disabled"}.`,
        );
      }
      next = enabledCodex.config;
    }
    next = applyAutoLocalModelLean({
      config: next,
      providerId: testPlan.provider,
      modelRef: plan.modelRef,
    }).config;
    next = selectModel ? selectModel(next) : next;
    if (!pendingCodexInstall) {
      return next;
    }
    return {
      ...next,
      plugins: {
        ...next.plugins,
        installs: { codex: pendingCodexInstall },
      },
    };
  };
  // Pending install records are probe-only discovery input. The config
  // writer moves them into the installed-plugin index before committing,
  // so post-write reconciliation must compare against the stripped route
  // and verify the exact index record separately below.
  const persistedRoute = pendingCodexInstall
    ? await projectDefaultInferenceRoute(
        stripPendingPluginInstallRecords(stageCandidate(cfg, "runtime")),
      )
    : verifiedRoute;
  // Runtime config may materialize provider defaults that are intentionally
  // absent from authored config. Compare source writes against the candidate
  // produced from the original source shape, without ignoring concurrent rows.
  const expectedSourceCandidateRoute = await projectDefaultInferenceRoute(
    stageCandidate(sourceCfg, "source"),
  );
  // Resolve every fallible config-commit dependency before writing a
  // credential into the real agent store. From this point onward, any
  // failure is inside the rollback boundary below.
  const transformConfig =
    deps.transformConfigWithPendingPluginInstalls ??
    (await import("../plugins/install-record-commit.js")).transformConfigWithPendingPluginInstalls;
  let manualAuthReceipt: ManualAuthPersistenceReceipt | undefined;
  if (hasPreparedAuthProfiles && plan.manualAuth) {
    throwIfSetupInferenceCancelled(params);
    const initialCandidate = stageCandidate(cfg, "runtime");
    const initialRoute = await projectDefaultInferenceRoute(initialCandidate);
    const resolvedRoute = await resolveSystemAgentConfiguredRouteFromConfig(initialCandidate);
    if (
      !sameDefaultInferenceRoute(initialRoute, verifiedRoute) ||
      !resolvedRoute ||
      resolvedRoute.modelLabel !== plan.modelRef ||
      resolvedRoute.authProfileId !== plan.authProfileId
    ) {
      throw new Error(
        "The default-agent inference route changed during its live test, so the verified credential was not saved. Review the current model/auth/runtime settings and retry.",
      );
    }
    const persistedManualAuth = await persistManualAuthProfiles({
      profiles: plan.manualAuth.profiles,
      agentDir: resolvedRoute.agentDir,
      deps,
    });
    if (persistedManualAuth.status === "unknown") {
      const rolledBack = await rollbackManualAuthProfiles(persistedManualAuth.receipt, deps);
      if (rolledBack) {
        return {
          ok: false,
          status: "unknown",
          error:
            "Could not confirm the credential write, so it was rolled back. Try again in a moment.",
        };
      }
      throw new SetupInferenceActivationIndeterminateError(
        "Inference activation could not confirm whether its verified credential was saved or rolled back. No config commit was attempted; run openclaw doctor --fix before retrying.",
      );
    }
    if (persistedManualAuth.status === "not-persisted") {
      return {
        ok: false,
        status: "unknown",
        error: "Could not save the verified credential; try again in a moment.",
      };
    }
    manualAuthReceipt = persistedManualAuth.receipt;
  }
  let commitMayHaveStarted = false;
  try {
    throwIfSetupInferenceCancelled(params);
    const committed = await transformConfig({
      base: "source",
      // The transform stays side-effect free so a config conflict can retry
      // without replaying credential writes in another agent directory.
      // Setup changes only hot-reloadable model, agent, and plugin-entry surfaces.
      // Publish the verified route now so the next turn cannot reuse the old harness.
      afterWrite: { mode: "auto" },
      transform: async (current, context) => {
        const latestRuntime = context.snapshot.runtimeConfig ?? context.snapshot.config;
        // Validate that the candidate is still admissible before reporting
        // broader route drift, so policy revocations retain their actionable error.
        const stagedRuntime = stageCandidate(latestRuntime, "runtime");
        const latestBaseline = await projectDefaultInferenceRoute(latestRuntime);
        if (!sameDefaultInferenceRoute(latestBaseline, baselineRoute)) {
          throw new Error(
            "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
          );
        }
        if (
          !isDeepStrictEqual(
            projectSetupTargetModelMetadata(latestRuntime, stagedRoute.modelLabel),
            baselineTargetModelMetadata,
          )
        ) {
          throw new Error(
            "The target model metadata changed during its live inference test, so the verified candidate was not saved. Review the current model settings and retry.",
          );
        }
        const currentRoute = await projectDefaultInferenceRoute(stagedRuntime);
        if (!sameDefaultInferenceRoute(currentRoute, verifiedRoute)) {
          throw new Error(
            "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
          );
        }
        const resolvedRoute = await resolveSystemAgentConfiguredRouteFromConfig(stagedRuntime);
        if (
          !resolvedRoute ||
          resolvedRoute.modelLabel !== plan.modelRef ||
          (plan.authProfileId && resolvedRoute.authProfileId !== plan.authProfileId)
        ) {
          throw new Error(
            "The latest default-agent route no longer matches the verified candidate, so it was not saved. Review the current config and retry.",
          );
        }
        if (
          !isDeepStrictEqual(
            projectSetupTargetModelMetadata(current, stagedRoute.modelLabel),
            sourceTargetModelMetadata,
          )
        ) {
          throw new Error(
            "The authored target model metadata changed during its live inference test, so the verified candidate was not saved. Review the current model settings and retry.",
          );
        }
        const autoLocalModelLean = applyAutoLocalModelLean({
          config: current,
          providerId: testPlan.provider,
          modelRef: plan.modelRef,
        });
        const nextConfig = stageCandidate(current, "source");
        const nextRouteProjection = await projectDefaultInferenceRoute(nextConfig);
        const nextResolvedRoute = await resolveSystemAgentConfiguredRouteFromConfig(nextConfig);
        if (
          !sameDefaultInferenceRoute(nextRouteProjection, expectedSourceCandidateRoute) ||
          !nextResolvedRoute ||
          nextResolvedRoute.modelLabel !== plan.modelRef ||
          (plan.authProfileId && nextResolvedRoute.authProfileId !== plan.authProfileId)
        ) {
          throw new Error(
            "The source config no longer matches the verified candidate, so it was not saved. Review the current config and retry.",
          );
        }
        await revalidateOwner({
          route: nextResolvedRoute,
          auth: test.auth,
          stagedOwnerPluginArtifacts,
          deps,
        });
        // Once this callback returns, the config writer owns the candidate.
        // Any later throw may be post-commit and needs reconciliation.
        throwIfSetupInferenceCancelled(params);
        params.onCommitStarted?.();
        commitMayHaveStarted = true;
        state.autoLocalModelLeanApplied = autoLocalModelLean.enabled;
        return { nextConfig };
      },
    });
    committedConfig = committed.nextConfig;
    if (pendingCodexInstall) {
      codexInstallOwnership = "owned";
    }
  } catch (error) {
    if (!commitMayHaveStarted) {
      if (manualAuthReceipt) {
        const rolledBack = await rollbackManualAuthProfiles(manualAuthReceipt, deps);
        if (!rolledBack) {
          throw new SetupInferenceActivationIndeterminateError(
            "Inference activation stopped before its config commit, but could not confirm removal of its staged credential. Run openclaw doctor --fix before retrying.",
          );
        }
      }
      throw error;
    }
    const reconciledSnapshot = await readSnapshot().catch(() => null);
    const reconciledRuntime =
      reconciledSnapshot?.exists && reconciledSnapshot.valid
        ? (reconciledSnapshot.runtimeConfig ?? reconciledSnapshot.config)
        : undefined;
    const reconciledRoute = reconciledRuntime
      ? await projectDefaultInferenceRoute(reconciledRuntime)
      : undefined;
    const codexInstallPersisted = pendingCodexInstall
      ? await isCodexInstallRecordPersisted(pendingCodexInstall, deps)
      : true;
    const committedDespiteError =
      reconciledRoute !== undefined &&
      sameDefaultInferenceRoute(reconciledRoute, persistedRoute) &&
      (!manualAuthReceipt || manualAuthProfilesPersisted(manualAuthReceipt, deps)) &&
      codexInstallPersisted;
    if (pendingCodexInstall) {
      codexInstallOwnership = committedDespiteError ? "owned" : "unowned";
    }
    if (!committedDespiteError) {
      if (manualAuthReceipt) {
        if (
          !reconciledRuntime ||
          configReferencesManualAuthProfiles(reconciledRuntime, manualAuthReceipt)
        ) {
          throw new SetupInferenceActivationIndeterminateError(
            "Inference activation could not confirm its config commit state. The verified credential was retained because the current config may reference it. Run openclaw doctor --fix before retrying.",
          );
        }
        const rolledBack = await rollbackManualAuthProfiles(manualAuthReceipt, deps);
        if (!rolledBack) {
          throw new SetupInferenceActivationIndeterminateError(
            "Inference activation failed and its staged credential could not be rolled back. Run openclaw doctor --fix before retrying.",
          );
        }
      }
      throw error;
    }
    committedConfig = reconciledSnapshot?.sourceConfig ?? reconciledRuntime;
    log.warn("Inference activation committed successfully despite a post-write cleanup error.");
  }

  state.committedConfig = committedConfig;
  state.codexInstallOwnership = codexInstallOwnership;
  return undefined;
}
