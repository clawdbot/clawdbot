import { isDeepStrictEqual } from "node:util";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { applyMergePatch } from "../config/merge-patch.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import type {
  SystemAgentConfiguredRoute,
  SystemAgentConfiguredRouteDeps,
} from "./inference-route.js";
import {
  SetupInferenceActivationIndeterminateError,
  SetupInferenceActivationUnavailableError,
  setupInferenceLog,
  throwIfSetupInferenceCancelled,
  type ActivateSetupInferenceDeps,
  type ActivateSetupInferenceParams,
  type ActivateSetupInferenceResult,
} from "./setup-inference-core.js";
import {
  commitManualAuthProfiles,
  configReferencesManualAuthProfiles,
  isCodexInstallRecordPersisted,
  manualAuthProfilesPersisted,
  persistManualAuthProfiles,
  rollbackManualAuthProfiles,
  applyManualAuthConfig,
  type ManualAuthPersistenceReceipt,
} from "./setup-inference-persist.js";
import {
  projectSetupTargetModelMetadata,
  type SetupInferenceTestPlan,
} from "./setup-inference-plan-helpers.js";
import { runSetupInferenceTest } from "./setup-inference-test.js";
import { createSystemAgentModelSelectionUpdater } from "./setup-model-selection.js";
import type { SystemAgentOwnerPluginArtifactSnapshot } from "./verified-inference.js";

type ProjectedInferenceRoute = Awaited<ReturnType<typeof projectInferenceRoute>>;

export type SetupInferenceActivationPersistenceState = {
  codexInstallOwnership: "unknown" | "owned" | "unowned";
  gatewayRestartRequired: boolean;
};

/** Build one typed candidate projection for verification and final persistence. */
export async function createSetupInferenceCandidateStager(params: {
  plan: Pick<SetupInferenceTestPlan, "manualAuth" | "persistModelRef" | "authProfileId">;
  targetAgentId?: string;
  agentRuntimeId?: string;
  codexPluginPatch: unknown;
  pendingCodexInstall: PluginInstallRecord | undefined;
  enablePlugin?: typeof enablePluginInConfig;
}) {
  const { plan, codexPluginPatch, pendingCodexInstall } = params;
  const { stripPendingPluginInstallRecords } = await import("../plugins/install-record-commit.js");
  const selectModel = plan.persistModelRef
    ? await createSystemAgentModelSelectionUpdater({
        model: plan.persistModelRef,
        ...(params.targetAgentId ? { targetAgentId: params.targetAgentId } : {}),
        ...(params.agentRuntimeId ? { agentRuntimeId: params.agentRuntimeId } : {}),
        ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
      })
    : undefined;
  return (current: OpenClawConfig, currentSourceConfig: OpenClawConfig): OpenClawConfig => {
    let next = codexPluginPatch === undefined ? current : stripPendingPluginInstallRecords(current);
    if (plan.manualAuth) {
      next = applyManualAuthConfig(
        next,
        plan.manualAuth,
        currentSourceConfig,
        params.enablePlugin ?? enablePluginInConfig,
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
    next = selectModel ? selectModel(next) : next;
    return pendingCodexInstall
      ? { ...next, plugins: { ...next.plugins, installs: { codex: pendingCodexInstall } } }
      : next;
  };
}

export async function persistActivatedSetupInference(input: {
  params: ActivateSetupInferenceParams;
  deps: ActivateSetupInferenceDeps;
  plan: SetupInferenceTestPlan;
  stageCandidate: Awaited<ReturnType<typeof createSetupInferenceCandidateStager>>;
  targetAgentId?: string;
  test: Extract<Awaited<ReturnType<typeof runSetupInferenceTest>>, { ok: true }>;
  pendingCodexInstall: PluginInstallRecord | undefined;
  cfg: OpenClawConfig;
  sourceCfg: OpenClawConfig;
  verifiedRoute: ProjectedInferenceRoute;
  baselineRoute: ProjectedInferenceRoute;
  stagedRoute: NonNullable<ProjectedInferenceRoute["route"]>;
  stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot;
  baselineTargetModelMetadata: unknown;
  sourceTargetModelMetadata: unknown;
  routeDeps: Pick<SystemAgentConfiguredRouteDeps, "pluginMetadataPlugins">;
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
    stageCandidate,
    targetAgentId,
    test,
    pendingCodexInstall,
    cfg,
    sourceCfg,
    verifiedRoute,
    baselineRoute,
    stagedRoute,
    stagedOwnerPluginArtifacts,
    baselineTargetModelMetadata,
    sourceTargetModelMetadata,
    routeDeps,
    readSnapshot,
    hasPreparedAuthProfiles,
    state,
    revalidateOwner,
  } = input;
  let { codexInstallOwnership } = state;
  const requestedAgentId = targetAgentId;
  const projectRoute = (config: OpenClawConfig, sourceConfig: OpenClawConfig) =>
    projectInferenceRoute(config, requestedAgentId, routeDeps, sourceConfig);
  const resolveRoute = (config: OpenClawConfig) =>
    resolveSystemAgentConfiguredRouteFromConfig(config, requestedAgentId, routeDeps);

  const { stripPendingPluginInstallRecords } = await import("../plugins/install-record-commit.js");
  const sourceCandidate = stageCandidate(sourceCfg, sourceCfg);
  // Pending install records are probe-only discovery input. The config
  // writer moves them into the installed-plugin index before committing,
  // so post-write reconciliation must compare against the stripped route
  // and verify the exact index record separately below.
  const persistedRoute = pendingCodexInstall
    ? await projectRoute(
        stripPendingPluginInstallRecords(stageCandidate(cfg, sourceCfg)),
        stripPendingPluginInstallRecords(sourceCandidate),
      )
    : verifiedRoute;
  // Runtime config may materialize provider defaults that are intentionally
  // absent from authored config. Compare source writes against the candidate
  // produced from the original source shape, without ignoring concurrent rows.
  const expectedSourceCandidateRoute = await projectRoute(sourceCandidate, sourceCandidate);
  // Resolve every fallible config-commit dependency before writing a
  // credential into the real agent store. From this point onward, any
  // failure is inside the rollback boundary below.
  const transformConfig =
    deps.transformConfigWithPendingPluginInstalls ??
    (await import("../plugins/install-record-commit.js")).transformConfigWithPendingPluginInstalls;
  let manualAuthReceipt: ManualAuthPersistenceReceipt | undefined;
  if (hasPreparedAuthProfiles && plan.manualAuth) {
    throwIfSetupInferenceCancelled(params);
    await params.beforePersistentEffect?.();
    throwIfSetupInferenceCancelled(params);
    const initialCandidate = stageCandidate(cfg, sourceCfg);
    const initialRoute = await projectRoute(initialCandidate, sourceCandidate);
    const resolvedRoute = await resolveRoute(initialCandidate);
    if (
      !sameDefaultInferenceRoute(initialRoute, verifiedRoute) ||
      !resolvedRoute ||
      resolvedRoute.modelLabel !== (plan.persistModelRef ?? plan.modelRef) ||
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
      secretStorage: { config: initialCandidate, env: process.env },
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
  const application = params.onRuntimeApplication
    ? createRuntimeConfigWriteApplication(captureGatewayRootWorkAdmissionContinuationScope()?.run)
    : undefined;
  if (application) {
    params.onRuntimeApplication?.(application);
  }
  let commitMayHaveStarted = false;
  try {
    throwIfSetupInferenceCancelled(params);
    const committed = await transformConfig({
      base: "source",
      ...(application
        ? { writeOptions: attachRuntimeConfigWriteApplication({}, application) }
        : {}),
      // The transform stays side-effect free so a config conflict can retry
      // without replaying credential writes in another agent directory.
      // The install-record owner adds a restart follow-up when this commit adopts
      // a new plugin source. Preserve that intent for structured setup clients.
      transform: async (current, context) => {
        const latestRuntime = context.snapshot.runtimeConfig ?? context.snapshot.config;
        // Validate that the candidate is still admissible before reporting
        // broader route drift, so policy revocations retain their actionable error.
        const stagedRuntime = stageCandidate(latestRuntime, context.snapshot.sourceConfig);
        const latestBaseline = await projectRoute(latestRuntime, context.snapshot.sourceConfig);
        if (!sameDefaultInferenceRoute(latestBaseline, baselineRoute)) {
          throw new Error(
            "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
          );
        }
        if (
          !isDeepStrictEqual(
            projectSetupTargetModelMetadata(
              latestRuntime,
              stagedRoute.modelLabel,
              requestedAgentId,
            ),
            baselineTargetModelMetadata,
          )
        ) {
          throw new Error(
            "The target model metadata changed during its live inference test, so the verified candidate was not saved. Review the current model settings and retry.",
          );
        }
        const nextConfig = stageCandidate(current, current);
        const currentRoute = await projectRoute(stagedRuntime, nextConfig);
        if (!sameDefaultInferenceRoute(currentRoute, verifiedRoute)) {
          throw new Error(
            "The default-agent inference route changed during its live test, so the verified candidate was not saved. Review the current model/auth/runtime settings and retry.",
          );
        }
        const resolvedRoute = await resolveRoute(stagedRuntime);
        if (
          !resolvedRoute ||
          resolvedRoute.modelLabel !== (plan.persistModelRef ?? plan.modelRef) ||
          (plan.authProfileId && resolvedRoute.authProfileId !== plan.authProfileId)
        ) {
          throw new Error(
            "The latest default-agent route no longer matches the verified candidate, so it was not saved. Review the current config and retry.",
          );
        }
        if (
          !isDeepStrictEqual(
            projectSetupTargetModelMetadata(current, stagedRoute.modelLabel, requestedAgentId),
            sourceTargetModelMetadata,
          )
        ) {
          throw new Error(
            "The authored target model metadata changed during its live inference test, so the verified candidate was not saved. Review the current model settings and retry.",
          );
        }
        const nextRouteProjection = await projectRoute(nextConfig, nextConfig);
        const nextResolvedRoute = await resolveRoute(nextConfig);
        if (
          !sameDefaultInferenceRoute(nextRouteProjection, expectedSourceCandidateRoute) ||
          !nextResolvedRoute ||
          nextResolvedRoute.modelLabel !== (plan.persistModelRef ?? plan.modelRef) ||
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
        params.onCommitStarted?.(current);
        commitMayHaveStarted = true;
        return { nextConfig };
      },
    });
    state.gatewayRestartRequired = committed.followUp.requiresRestart;
    if (manualAuthReceipt) {
      await commitManualAuthProfiles(manualAuthReceipt);
    }
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
    const reconciledRoute =
      reconciledRuntime && reconciledSnapshot
        ? await projectRoute(reconciledRuntime, reconciledSnapshot.sourceConfig)
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
          const indeterminateError = new SetupInferenceActivationIndeterminateError(
            "Inference activation could not confirm its config commit state. The verified credential was retained because the current config may reference it. Run openclaw doctor --fix before retrying.",
          );
          await commitManualAuthProfiles(manualAuthReceipt, {
            primaryError: indeterminateError,
            message: `${indeterminateError.message} Protected storage could not be released.`,
          });
          throw indeterminateError;
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
    if (manualAuthReceipt) {
      await commitManualAuthProfiles(manualAuthReceipt, {
        primaryError: error,
        message:
          "Inference activation committed despite a post-write error, but protected storage could not be released.",
      });
    }
    state.gatewayRestartRequired = pendingCodexInstall !== undefined;
    setupInferenceLog.warn(
      "Inference activation committed successfully despite a post-write cleanup error.",
    );
  }

  state.codexInstallOwnership = codexInstallOwnership;
  return undefined;
}
