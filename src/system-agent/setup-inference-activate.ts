import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  type CodexCliApiKeyCredential,
  readCodexCliActiveApiKey,
} from "../agents/cli-credentials.js";
import { applyAutoLocalModelLean } from "../config/local-model-lean-auto.js";
import { createMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginInConfig, enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderAuthChoicePreparation } from "../plugins/provider-auth-choice.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "../plugins/runtime-state.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveUserPath } from "../utils.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import {
  WizardCancelledError,
  WizardNavigationError,
  type WizardProgress,
} from "../wizard/prompts.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import { loadSetupInferencePluginGeneration } from "./revalidate-inference-owner.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  persistActivatedSetupInference,
  type SetupInferenceActivationPersistenceState,
} from "./setup-inference-activate-persist.js";
import {
  AUTO_LOCAL_MODEL_LEAN_ANNOUNCEMENT,
  type ActivateSetupInferenceParams,
  type ActivateSetupInferenceResult,
  SetupInferenceActivationIndeterminateError,
  SetupInferenceActivationUnavailableError,
  SetupInferenceCancelledError,
  SetupInferenceOwnerDriftError,
  invalidSetupConfigError,
  redactSetupInferenceError,
  resolveSetupInferenceWorkspace,
  throwIfSetupInferenceCancelled,
} from "./setup-inference-core.js";
import { revalidateStableSetupInferenceOwner } from "./setup-inference-owner.js";
import {
  cleanupSetupInferenceTempDir,
  persistManualAuthProfiles,
  restoreSetupPluginMetadata,
  retainUnownedSetupPluginInstall,
  runSetupInferenceTest,
} from "./setup-inference-persist.js";
import {
  configureCodexCliPreparedAuth,
  projectSetupTargetModelMetadata,
  resolveSetupAgentRuntimeId,
  type SetupInferencePluginPreparation,
} from "./setup-inference-plan-helpers.js";
import { buildTestPlan } from "./setup-inference-plan.js";
import { applySystemAgentModelSelection } from "./setup-model-selection.js";
import {
  captureSystemAgentOwnerPluginArtifacts,
  type SystemAgentOwnerPluginArtifactSnapshot,
} from "./verified-inference.js";

/**
 * Test one candidate with a real completion, then persist it as the setup
 * default. Manual credentials are tested from a temporary auth store and
 * copied into the real agent store only after success. Installed packages survive
 * failed probes; their install records are adopted only with the verified route.
 */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const codexCliApiKey =
    params.kind === "codex-cli"
      ? (params.deps?.readCodexCliActiveApiKey ?? readCodexCliActiveApiKey)({
          allowKeychainPrompt: true,
        })
      : null;
  try {
    const result = await activateSetupInferenceUnredacted(params, codexCliApiKey ?? undefined);
    if (result.ok) {
      return {
        ...result,
        lines: await Promise.all(
          result.lines.map((line) =>
            redactSetupInferenceError(line, params.apiKey, codexCliApiKey?.key),
          ),
        ),
      };
    }
    return {
      ...result,
      error: await redactSetupInferenceError(result.error, params.apiKey, codexCliApiKey?.key),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = await redactSetupInferenceError(message, params.apiKey, codexCliApiKey?.key);
    if (error instanceof WizardCancelledError) {
      throw new WizardCancelledError(redacted);
    }
    if (error instanceof WizardNavigationError) {
      throw new WizardNavigationError(error.direction);
    }
    if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
      return { ok: false, status: "unavailable", error: "Provider login was cancelled." };
    }
    if (error instanceof SetupInferenceActivationUnavailableError) {
      return { ok: false, status: "unavailable", error: redacted };
    }
    if (error instanceof SetupInferenceOwnerDriftError) {
      return { ok: false, status: "auth", error: redacted };
    }
    if (error instanceof SetupInferenceActivationIndeterminateError) {
      throw new SetupInferenceActivationIndeterminateError(redacted);
    }
    // oxlint-disable-next-line preserve-caught-error -- The original cause can contain the submitted setup secret.
    throw new Error(redacted);
  }
}

async function activateSetupInferenceUnredacted(
  params: ActivateSetupInferenceParams,
  codexCliApiKey?: CodexCliApiKeyCredential,
): Promise<ActivateSetupInferenceResult> {
  const deps = params.deps ?? {};
  const beforePersistentEffect = async () => {
    throwIfSetupInferenceCancelled(params);
    await params.beforePersistentEffect?.();
    throwIfSetupInferenceCancelled(params);
  };
  const resolveRouteMetadata = deps.resolvePluginMetadataSnapshot ?? resolvePluginMetadataSnapshot;
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  // Missing-file snapshots still carry the load-time implicit-main roster.
  // Setup must probe against that runtime view without treating it as authored config.
  const cfg: OpenClawConfig = snapshot.runtimeConfig ?? snapshot.config;
  // The source snapshot includes raw compatibility migrations for comparison,
  // while the writer still projects changes back onto the untouched authored bytes.
  const sourceCfg: OpenClawConfig = snapshot.sourceConfig ?? snapshot.config;
  const routeAgentId = resolveAmbientOwnerAgentId(cfg, params.agentId);
  const workspace = params.workspace?.trim()
    ? resolveUserPath(params.workspace)
    : resolveSetupInferenceWorkspace(snapshot);

  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  const testAgentDir = path.join(tempDir, "agent");
  let pluginPreparation: SetupInferencePluginPreparation | undefined;
  let pluginInstallOwnership: "unknown" | "owned" | "unowned" = "unknown";
  let pluginMetadataNeedsRestore = false;
  let verificationProgress: WizardProgress | undefined;
  let probePluginGeneration: ReturnType<typeof loadSetupInferencePluginGeneration> | undefined;
  const withProbePluginGeneration = <T>(run: () => T): T =>
    probePluginGeneration ? withPluginRuntimeGenerationScope(probePluginGeneration, run) : run();
  const capturePluginPreparation = async (
    prepared: ProviderAuthChoicePreparation & { pluginId: string },
    baseConfig = cfg,
  ) => {
    pluginMetadataNeedsRestore = true;
    const preparation: SetupInferencePluginPreparation = {
      pluginId: prepared.pluginId,
      runtimeConfigBase: baseConfig,
      sourceConfigBase: sourceCfg,
      configPatch: {},
      ...(prepared.installation ? { installation: prepared.installation.record } : {}),
    };
    pluginPreparation = preparation;
    // Installation is already durable; retain the package before auth or runtime imports can fail.
    if (
      prepared.installation &&
      !(await retainUnownedSetupPluginInstall({
        pluginId: prepared.pluginId,
        record: prepared.installation.record,
        deps,
      }))
    ) {
      throw new SetupInferenceActivationUnavailableError(
        "Could not retain the staged plugin safely. No inference route was changed; retry after checking the plugin storage directory.",
      );
    }
    const { stripPendingPluginInstallRecords } =
      await import("../plugins/install-record-commit.js");
    const baseFor = (config: OpenClawConfig) =>
      enablePluginInConfig(
        normalizePluginTargetConfig(stripPendingPluginInstallRecords(config), prepared.pluginId),
        prepared.pluginId,
      ).config;
    preparation.runtimeConfigBase = baseFor(baseConfig);
    preparation.sourceConfigBase = baseFor(sourceCfg);
    preparation.configPatch = createMergePatch(
      preparation.runtimeConfigBase,
      stripPendingPluginInstallRecords(prepared.config),
    );
    return preparation;
  };
  const revalidateOwner: typeof revalidateStableSetupInferenceOwner = (owner) =>
    revalidateStableSetupInferenceOwner({
      ...owner,
      refreshPluginGeneration: Boolean(pluginPreparation),
    });
  try {
    const plan = await buildTestPlan({
      kind: params.kind,
      ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
      ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
      ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
      cfg,
      sourceCfg,
      workspaceDir: tempDir,
      pluginWorkspaceDir: workspace,
      agentDir: testAgentDir,
      runtime: params.runtime,
      ...(params.prompter ? { prompter: params.prompter } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.isCancelled ? { isCancelled: params.isCancelled } : {}),
      ...(params.kind === "provider-auth"
        ? { isRemoteProviderAuth: params.surface === "gateway" }
        : {}),
      ...(codexCliApiKey ? { codexCliApiKey } : {}),
      beforePersistentEffect,
      onPluginPrepared: async (prepared) => {
        await capturePluginPreparation(prepared);
      },
      deps,
      routeAgentId,
    });
    if ("error" in plan) {
      return {
        ok: false,
        status: plan.status ?? "unavailable",
        error: plan.error,
      };
    }

    const hasPreparedAuthProfiles = (plan.manualAuth?.profiles.length ?? 0) > 0;
    let testPlan = plan;
    if (plan.persistModelRef) {
      const agentRuntimeId = resolveSetupAgentRuntimeId(params.kind);
      const stagedConfig = await applySystemAgentModelSelection({
        config: plan.config,
        model: plan.persistModelRef,
        ...(params.agentId ? { targetAgentId: testPlan.routeAgentId } : {}),
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
      });
      testPlan = {
        ...plan,
        config: stagedConfig,
        routeAgentId: resolveAmbientOwnerAgentId(stagedConfig, params.agentId),
      };
    }

    const prepareProbeGeneration = async (
      preparation: SetupInferencePluginPreparation,
    ): Promise<ActivateSetupInferenceResult | undefined> => {
      const refreshPluginRegistry =
        deps.refreshPluginRegistryAfterConfigMutation ??
        (await import("../plugins/registry-refresh.js")).refreshPluginRegistryAfterConfigMutation;
      let registryRefreshWarning: string | undefined;
      await refreshPluginRegistry({
        config: testPlan.config,
        reason: "source-changed",
        ...(testPlan.config.plugins?.installs
          ? { installRecords: testPlan.config.plugins.installs }
          : {}),
        workspaceDir: workspace,
        policyPluginIds: [preparation.pluginId],
        traceCommand: "openclaw-setup-probe",
        logger: { warn: (message) => (registryRefreshWarning = message) },
      });
      try {
        // The probe owns fresh package facts, not the running Gateway's startup registry.
        probePluginGeneration = loadSetupInferencePluginGeneration({
          config: testPlan.config,
          workspaceDir: workspace,
          selection: {
            provider: testPlan.provider,
            modelId: testPlan.model,
            runtime: resolveSetupAgentRuntimeId(params.kind) ?? "openclaw",
            agentId: testPlan.routeAgentId,
          },
          resolvePluginMetadataSnapshot: resolveRouteMetadata,
        });
      } catch (error) {
        const loadError = `Could not load the prepared inference plugin: ${formatErrorMessage(error)}`;
        return {
          ok: false,
          status: "unavailable",
          error: registryRefreshWarning ? `${registryRefreshWarning} ${loadError}` : loadError,
        };
      }
      return undefined;
    };
    if (params.kind === "codex-cli") {
      // Keep the reviewed package stable until its prepared registry handle is captured.
      const preparationFailure = await withPluginLifecycleLease(
        { signal: params.signal },
        async (): Promise<ActivateSetupInferenceResult | undefined> => {
          const { stripPendingPluginInstallRecords } =
            await import("../plugins/install-record-commit.js");
          // This explicit Codex CLI choice owns its runtime independently of the
          // user's existing OpenAI provider route (which may use a custom base URL).
          const codexInstallBase = stripPendingPluginInstallRecords(testPlan.config);
          const enabledCodexBase = await enablePluginWithCapabilityConsent(
            normalizePluginTargetConfig(codexInstallBase, "codex"),
            "codex",
            {
              workspaceDir: workspace,
              onCapabilityConsent: params.prompter
                ? createPluginCapabilityConsentPrompter(params.prompter)
                : undefined,
              beforePersistentEffect,
            },
          );
          if (!enabledCodexBase.enabled) {
            return {
              ok: false,
              status: "unavailable",
              error: `Could not enable the Codex runtime plugin: ${enabledCodexBase.reason ?? "plugin disabled"}.`,
            };
          }
          const ensureCodex =
            deps.ensureCodexRuntimePlugin ??
            (await import("../commands/codex-runtime-plugin-install.js"))
              .ensureCodexRuntimePluginForModelSelection;
          const ensured = await ensureCodex({
            cfg: enabledCodexBase.config,
            model: plan.modelRef,
            agentId: testPlan.routeAgentId,
            prompter: params.prompter ?? createQuickstartNotePrompter(params.runtime),
            runtime: params.runtime,
            workspaceDir: tempDir,
            beforePersistentEffect,
          });
          if (!ensured.ok) {
            return {
              ok: false,
              status: ensured.status === "timed_out" ? "timeout" : "unavailable",
              error: ensured.message,
            };
          }
          const record = ensured.cfg.plugins?.installs?.codex;
          const preparation = await capturePluginPreparation(
            {
              config: ensured.cfg,
              pluginId: "codex",
              ...(record ? { installation: { pluginId: "codex", record } } : {}),
            },
            codexInstallBase,
          );
          const normalizedCodexConfig = normalizePluginTargetConfig(ensured.cfg, "codex");
          const preparedAuth = configureCodexCliPreparedAuth(
            normalizedCodexConfig,
            codexCliApiKey ? "agent" : "user",
          );
          if (!preparedAuth.ok) {
            return { ok: false, status: "unavailable", error: preparedAuth.error };
          }
          const enabledCodex = enablePluginInConfig(preparedAuth.value, "codex");
          if (!enabledCodex.enabled) {
            return {
              ok: false,
              status: "unavailable",
              error: `Could not enable the Codex runtime plugin: ${enabledCodex.reason ?? "plugin disabled"}.`,
            };
          }
          // Discovery needs the just-installed package record during the probe, but
          // install ownership remains transient until inference succeeds.
          const stagedCodexConfig = enabledCodex.config;
          preparation.configPatch = createMergePatch(
            preparation.runtimeConfigBase,
            stripPendingPluginInstallRecords(stagedCodexConfig),
          );
          testPlan = {
            ...testPlan,
            config: stagedCodexConfig,
          };

          return await prepareProbeGeneration(preparation);
        },
      );
      if (preparationFailure) {
        return preparationFailure;
      }
    } else if (pluginPreparation) {
      const preparation = pluginPreparation;
      const failure = await withPluginLifecycleLease({ signal: params.signal }, () =>
        prepareProbeGeneration(preparation),
      );
      if (failure) {
        return failure;
      }
    }
    const metadataWorkspaceDir = getActivePluginRegistryWorkspaceDirFromState();
    const routeMetadataSnapshot =
      probePluginGeneration?.metadataSnapshot ??
      resolveRouteMetadata({
        config: testPlan.config,
        env: process.env,
        ...(metadataWorkspaceDir ? { workspaceDir: metadataWorkspaceDir } : {}),
      });
    const routeDeps = { pluginMetadataPlugins: routeMetadataSnapshot.plugins };
    const requestedAgentId = params.agentId ? testPlan.routeAgentId : undefined;
    const baselineRoute = await projectInferenceRoute(cfg, requestedAgentId, routeDeps);
    const verifiedRoute = await projectInferenceRoute(testPlan.config, requestedAgentId, routeDeps);
    const stagedRoute = verifiedRoute.route;
    const stagedExecutionRoute = await resolveSystemAgentConfiguredRouteFromConfig(
      testPlan.config,
      requestedAgentId,
      routeDeps,
    );
    if (
      !stagedRoute ||
      !stagedExecutionRoute ||
      stagedRoute.runner !== testPlan.runner ||
      stagedRoute.provider !== testPlan.provider ||
      stagedRoute.model !== testPlan.model ||
      stagedRoute.modelLabel !== (plan.persistModelRef ?? plan.modelRef) ||
      (plan.authProfileId && stagedRoute.authProfileId !== plan.authProfileId)
    ) {
      return {
        ok: false,
        status: "unavailable",
        error:
          "The staged default-agent route does not match the requested inference candidate. Review model runtime policy and retry.",
      };
    }
    const baselineTargetModelMetadata = projectSetupTargetModelMetadata(
      cfg,
      stagedRoute.modelLabel,
      requestedAgentId,
    );
    const sourceTargetModelMetadata = projectSetupTargetModelMetadata(
      sourceCfg,
      stagedRoute.modelLabel,
      requestedAgentId,
    );
    // Prepared credentials stay in the isolated test store; existing routes use
    // the default agent's store while execution keeps the reserved agent id.
    testPlan = {
      ...testPlan,
      executionConfig: stagedExecutionRoute.runConfig,
      agentDir: hasPreparedAuthProfiles ? testAgentDir : stagedRoute.agentDir,
      ...(testPlan.runner === "embedded" &&
      stagedRoute.runner === "embedded" &&
      stagedRoute.agentHarnessRuntimeOverride
        ? { agentHarnessRuntimeOverride: stagedRoute.agentHarnessRuntimeOverride }
        : {}),
    };

    if (hasPreparedAuthProfiles && plan.manualAuth) {
      const staged = await persistManualAuthProfiles({
        profiles: plan.manualAuth.profiles,
        agentDir: testAgentDir,
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
    }

    let stagedOwnerPluginArtifacts: SystemAgentOwnerPluginArtifactSnapshot;
    try {
      stagedOwnerPluginArtifacts = withProbePluginGeneration(() =>
        (deps.captureSystemAgentOwnerPluginArtifacts ?? captureSystemAgentOwnerPluginArtifacts)({
          config: stagedExecutionRoute.runConfig,
          executionRoute: stagedExecutionRoute,
          deps,
        }),
      );
    } catch {
      return {
        ok: false,
        status: "unavailable",
        error:
          "Could not bind the staged inference plugin runtime. Refresh or reinstall the plugin and retry.",
      };
    }

    if (params.signal?.aborted || params.isCancelled?.()) {
      return { ok: false, status: "unavailable", error: "Provider login was cancelled." };
    }
    let test: Awaited<ReturnType<typeof runSetupInferenceTest>>;
    verificationProgress = params.prompter?.progress("Testing your AI connection…");
    try {
      test = await withProbePluginGeneration(() =>
        runSetupInferenceTest({
          plan: testPlan,
          tempDir,
          deps,
          // The setup probe is evidence, not an auth-store mutation. Manual keys
          // already exist in the isolated store and every other route stays read-only.
          authProfileStateMode: "read-only",
          requireExecutionOwner: true,
          ...(params.signal ? { signal: params.signal } : {}),
        }),
      );
      throwIfSetupInferenceCancelled(params);
    } catch (error) {
      if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
        return { ok: false, status: "unavailable", error: "Provider login was cancelled." };
      }
      throw error;
    }
    if (!test.ok) {
      return test;
    }
    verificationProgress?.update("Finishing AI setup…");
    if (plan.authProfileId && test.auth.authProfileId !== plan.authProfileId) {
      return {
        ok: false,
        status: "auth",
        error: `The inference run used profile "${test.auth.authProfileId ?? "unknown"}" instead of the configured profile "${plan.authProfileId}". No model or credential route was saved.`,
      };
    }

    const autoLocalModelLeanUpdate = applyAutoLocalModelLean({
      config: sourceCfg,
      providerId: testPlan.provider,
      modelRef: plan.modelRef,
    });
    const needsPersistence =
      plan.persistModelRef !== undefined ||
      plan.manualAuth !== undefined ||
      pluginPreparation !== undefined ||
      autoLocalModelLeanUpdate.changed;
    if (
      !test.auth.authFingerprint &&
      (!test.auth.runtimeOwnerFingerprint ||
        !test.auth.runtimeOwnerKind ||
        !test.auth.runtimeOwnerId?.trim())
    ) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its runtime did not report an owner that OpenClaw can safely reuse. No model or credential route was saved.",
      };
    }
    if (
      testPlan.runner === "cli" &&
      (!test.auth.runtimeArtifactFingerprint || !test.auth.runtimeArtifactId?.trim())
    ) {
      return {
        ok: false,
        status: "unknown",
        error:
          "Inference succeeded, but its CLI executable/package artifact could not be safely reused. No model or credential route was saved.",
      };
    }
    if (testPlan.runner === "embedded") {
      const successfulHarnessId = test.auth.agentHarnessId?.trim();
      const configuredHarnessId = testPlan.agentHarnessRuntimeOverride?.trim();
      if (
        !successfulHarnessId ||
        (configuredHarnessId !== undefined &&
          configuredHarnessId !== "auto" &&
          successfulHarnessId !== configuredHarnessId)
      ) {
        return {
          ok: false,
          status: "unknown",
          error:
            "Inference succeeded, but its exact agent harness could not be safely reused. No model or credential route was saved.",
        };
      }
      if (
        successfulHarnessId !== "openclaw" &&
        (test.auth.runtimeOwnerKind !== "plugin-harness" ||
          test.auth.runtimeOwnerId?.trim() !== successfulHarnessId ||
          !test.auth.runtimeArtifactFingerprint ||
          !test.auth.runtimeArtifactId?.trim())
      ) {
        return {
          ok: false,
          status: "unknown",
          error:
            "Inference succeeded, but its agent harness artifact could not be safely reused. No model or credential route was saved.",
        };
      }
    }
    const persistenceState: SetupInferenceActivationPersistenceState = {
      committedConfig: undefined,
      autoLocalModelLeanApplied: false,
      pluginInstallOwnership,
      gatewayRestartRequired: false,
    };
    if (!needsPersistence) {
      const latestSnapshot = await readSnapshot();
      const latestRuntime =
        latestSnapshot.exists && latestSnapshot.valid
          ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
          : undefined;
      const latestRoute = latestRuntime
        ? await projectInferenceRoute(latestRuntime, requestedAgentId, routeDeps)
        : undefined;
      if (!latestRoute || !sameDefaultInferenceRoute(latestRoute, verifiedRoute)) {
        return {
          ok: false,
          status: "unknown",
          error:
            "The default-agent inference route changed during its live test. Review the current model/auth/runtime settings and retry.",
        };
      }
      const latestResolvedRoute = latestRuntime
        ? await resolveSystemAgentConfiguredRouteFromConfig(
            latestRuntime,
            requestedAgentId,
            routeDeps,
          )
        : null;
      if (!latestResolvedRoute) {
        return {
          ok: false,
          status: "unknown",
          error:
            "The default-agent inference route could not be resolved after its live test. Review the current model/auth/runtime settings and retry.",
        };
      }
      await revalidateOwner({
        route: latestResolvedRoute,
        auth: test.auth,
        stagedOwnerPluginArtifacts,
        deps,
      });
    }
    if (needsPersistence) {
      const persistenceFailure = await persistActivatedSetupInference({
        params,
        deps,
        plan,
        testPlan,
        test,
        pluginPreparation,
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
        state: persistenceState,
        revalidateOwner,
      });
      if (persistenceFailure) {
        return persistenceFailure;
      }
      pluginInstallOwnership = persistenceState.pluginInstallOwnership;
    }
    const { committedConfig, autoLocalModelLeanApplied, gatewayRestartRequired } = persistenceState;
    const announceAutoLocalModelLean =
      autoLocalModelLeanApplied &&
      committedConfig?.agents?.defaults?.experimental?.localModelLean === true;
    let lines = [
      `Inference verified: ${plan.modelRef}`,
      ...(announceAutoLocalModelLean ? [AUTO_LOCAL_MODEL_LEAN_ANNOUNCEMENT] : []),
    ];
    if (params.surface === "gateway" && params.recordSetupAudit !== false) {
      const after = await readSnapshot().catch(() => null);
      try {
        await appendSystemAgentAuditEntry({
          operation: "openclaw.setup",
          summary: "Verified and configured AI access through OpenClaw setup",
          configPath: after?.path ?? snapshot.path,
          configHashBefore: snapshot.hash ?? null,
          configHashAfter: after?.hash ?? null,
          details: { modelRef: plan.modelRef, inferenceKind: params.kind },
        });
      } catch (error) {
        // Inference is already verified and its route may already be durable.
        // Surface audit failure as a warning instead of misreporting setup failure.
        const warning = `Inference setup completed, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
        params.runtime.error?.(warning);
        lines = [...lines, warning];
      }
    }
    return {
      ok: true,
      modelRef: plan.modelRef,
      latencyMs: test.latencyMs,
      lines,
      ...(params.surface === "gateway" && gatewayRestartRequired
        ? { gatewayRestartRequired: true as const }
        : {}),
    };
  } finally {
    verificationProgress?.stop();
    let pluginCleanupError: SetupInferenceActivationIndeterminateError | undefined;
    if (pluginPreparation?.installation && pluginInstallOwnership !== "owned") {
      // Reassert after probing: a partial install-index commit may have cleared
      // the early marker even though the matching model route never committed.
      const retained = await retainUnownedSetupPluginInstall({
        pluginId: pluginPreparation.pluginId,
        record: pluginPreparation.installation,
        deps,
      });
      if (!retained) {
        pluginCleanupError = new SetupInferenceActivationIndeterminateError(
          "Inference activation stopped before its plugin package could be retained safely. Restart the Gateway before retrying.",
        );
      }
    }
    if (pluginMetadataNeedsRestore) {
      // The probe owns a private registry. Restore only its staged metadata;
      // Gateway reload owns runtime replacement and the prepared auth generation.
      await restoreSetupPluginMetadata({ readSnapshot, workspaceDir: workspace, deps });
    }
    await cleanupSetupInferenceTempDir({ tempDir, deps, runtime: params.runtime });
    if (pluginCleanupError) {
      // oxlint-disable-next-line no-unsafe-finally -- an indeterminate plugin cleanup must supersede a stale success result
      throw pluginCleanupError;
    }
  }
}
