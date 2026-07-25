import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  type CodexCliApiKeyCredential,
  readCodexCliActiveApiKey,
} from "../agents/cli-credentials.js";
import { createMergePatch } from "../config/io.write-prepare.js";
import { applyAutoLocalModelLean } from "../config/local-model-lean-auto.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { resolveUserPath } from "../utils.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import {
  projectDefaultInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import { applySystemAgentModelSelection, createQuickstartNotePrompter } from "./setup-apply.js";
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
  resolveSetupInferenceWorkspace,
  throwIfSetupInferenceCancelled,
} from "./setup-inference-core.js";
import { revalidateStableSetupInferenceOwner } from "./setup-inference-owner.js";
import {
  cleanupSetupInferenceTempDir,
  persistManualAuthProfiles,
  reloadCodexRegistryAfterActivation,
  retainUnownedCodexInstall,
  runSetupInferenceTest,
} from "./setup-inference-persist.js";
import {
  configureCodexCliPreparedAuth,
  projectSetupTargetModelMetadata,
  resolveSetupAgentRuntimeId,
} from "./setup-inference-plan-helpers.js";
import { buildTestPlan } from "./setup-inference-plan.js";
import {
  captureSystemAgentOwnerPluginArtifacts,
  type SystemAgentOwnerPluginArtifactSnapshot,
} from "./verified-inference.js";

/**
 * Test one candidate with a real completion, then persist it as the setup
 * default. Manual credentials are tested from a temporary auth store and
 * copied into the real agent store only after success. A managed Codex install
 * record may remain after a failed probe because the installed package already exists.
 */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const codexCliApiKey = resolveCodexCliSetupApiKey(params);
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
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg: OpenClawConfig = snapshot.exists ? (snapshot.runtimeConfig ?? snapshot.config) : {};
  const sourceCfg: OpenClawConfig = snapshot.exists
    ? (snapshot.sourceConfig ?? snapshot.config)
    : {};
  const workspace = params.workspace?.trim()
    ? resolveUserPath(params.workspace)
    : (
        await resolveSetupInferenceWorkspace({
          configExists: snapshot.exists,
          configValid: snapshot.valid,
        })
      ).workspace;

  const tempDir = await (
    deps.createTempDir ?? (() => fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-inference-")))
  )();
  const testAgentDir = path.join(tempDir, "agent");
  let pendingCodexInstall: PluginInstallRecord | undefined;
  let codexInstallOwnership: "unknown" | "owned" | "unowned" = "unknown";
  let codexRegistryNeedsReload = false;
  let codexRegistryReloaded = false;
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
      deps,
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
        ...(agentRuntimeId ? { agentRuntimeId } : {}),
        ...(plan.manualAuth && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
      });
      testPlan = {
        ...plan,
        config: stagedConfig,
        routeAgentId: resolveDefaultAgentId(stagedConfig),
      };
    }

    let codexPluginPatch: unknown;
    if (params.kind === "codex-cli") {
      const { stripPendingPluginInstallRecords } =
        await import("../plugins/install-record-commit.js");
      // This explicit Codex CLI choice owns its runtime independently of the
      // user's existing OpenAI provider route (which may use a custom base URL).
      const codexInstallBase = stripPendingPluginInstallRecords(testPlan.config);
      const enabledCodexBase = enablePluginInConfig(
        normalizePluginTargetConfig(codexInstallBase, "codex"),
        "codex",
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
        prompter: createQuickstartNotePrompter(params.runtime),
        runtime: params.runtime,
        workspaceDir: tempDir,
      });
      if (!ensured.installed) {
        return {
          ok: false,
          status: ensured.status === "timed_out" ? "timeout" : "unavailable",
          error:
            ensured.status === "timed_out"
              ? "Codex runtime plugin installation timed out. Try again."
              : ensured.reason
                ? `Could not enable the Codex runtime plugin: ${ensured.reason}.`
                : "Could not install the Codex runtime plugin. Try again once the plugin is available.",
        };
      }
      codexRegistryNeedsReload = true;
      pendingCodexInstall = ensured.cfg.plugins?.installs?.codex;
      if (pendingCodexInstall) {
        // The managed package exists before inference can run. Mark this
        // generation retained now so a process exit cannot strand unowned bytes.
        const codexInstallRetained = await retainUnownedCodexInstall({
          record: pendingCodexInstall,
          verifyOwnership: false,
          deps,
        });
        if (!codexInstallRetained) {
          return {
            ok: false,
            status: "unavailable",
            error:
              "Could not retain the staged Codex runtime safely. No inference route was changed; retry after checking the plugin storage directory.",
          };
        }
      }
      const normalizedCodexConfig = normalizePluginTargetConfig(ensured.cfg, "codex");
      const enabledCodex = enablePluginInConfig(
        configureCodexCliPreparedAuth(normalizedCodexConfig),
        "codex",
      );
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
      codexPluginPatch = createMergePatch(
        codexInstallBase,
        stripPendingPluginInstallRecords(stagedCodexConfig),
      );
      testPlan = {
        ...testPlan,
        config: stagedCodexConfig,
      };

      // The Gateway registry predates a runtime installed by this request.
      // Refresh and load the exact Codex harness before auth snapshots it.
      const refreshPluginRegistry =
        deps.refreshPluginRegistryAfterConfigMutation ??
        (await import("../plugins/registry-refresh.js")).refreshPluginRegistryAfterConfigMutation;
      let registryRefreshWarning: string | undefined;
      await refreshPluginRegistry({
        config: testPlan.config,
        reason: "source-changed",
        workspaceDir: workspace,
        policyPluginIds: ["codex"],
        traceCommand: "openclaw-setup-probe",
        logger: { warn: (message) => (registryRefreshWarning = message) },
      });
      const ensureHarnessPlugin =
        deps.ensureSelectedAgentHarnessPlugin ??
        (await import("../agents/harness/runtime-plugin.js")).ensureSelectedAgentHarnessPlugin;
      try {
        await ensureHarnessPlugin({
          provider: testPlan.provider,
          modelId: testPlan.model,
          config: testPlan.config,
          agentId: testPlan.routeAgentId,
          agentHarnessRuntimeOverride: "codex",
          workspaceDir: tempDir,
        });
      } catch (error) {
        const loadError = `Could not load the Codex runtime plugin: ${formatErrorMessage(error)}`;
        return {
          ok: false,
          status: "unavailable",
          error: registryRefreshWarning ? `${registryRefreshWarning} ${loadError}` : loadError,
        };
      }
    }
    const baselineRoute = await projectDefaultInferenceRoute(cfg);
    const verifiedRoute = await projectDefaultInferenceRoute(testPlan.config);
    const stagedRoute = verifiedRoute.route;
    const stagedExecutionRoute = await resolveSystemAgentConfiguredRouteFromConfig(testPlan.config);
    if (
      !stagedRoute ||
      !stagedExecutionRoute ||
      stagedRoute.runner !== testPlan.runner ||
      stagedRoute.provider !== testPlan.provider ||
      stagedRoute.model !== testPlan.model ||
      stagedRoute.modelLabel !== plan.modelRef ||
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
    );
    const sourceTargetModelMetadata = projectSetupTargetModelMetadata(
      sourceCfg,
      stagedRoute.modelLabel,
    );
    // OpenClaw executes through the reserved agent id but reuses the default
    // route's agent directory. Only a submitted key stays in the isolated store.
    if (testPlan.runner === "embedded" && stagedRoute.runner === "embedded") {
      testPlan = {
        ...testPlan,
        config: stagedExecutionRoute.runConfig,
        agentDir: hasPreparedAuthProfiles ? testAgentDir : stagedRoute.agentDir,
        agentHarnessRuntimeOverride: stagedRoute.agentHarnessRuntimeOverride,
      };
    } else {
      testPlan = {
        ...testPlan,
        config: stagedExecutionRoute.runConfig,
        ...(!hasPreparedAuthProfiles ? { agentDir: stagedRoute.agentDir } : {}),
      };
    }

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
      stagedOwnerPluginArtifacts = (
        deps.captureSystemAgentOwnerPluginArtifacts ?? captureSystemAgentOwnerPluginArtifacts
      )({
        config: stagedExecutionRoute.runConfig,
        executionRoute: stagedExecutionRoute,
        deps,
      });
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
    try {
      test = await runSetupInferenceTest({
        plan: testPlan,
        tempDir,
        deps,
        // The setup probe is evidence, not an auth-store mutation. Manual keys
        // already exist in the isolated store and every other route stays read-only.
        authProfileStateMode: "read-only",
        requireExecutionOwner: true,
        ...(params.signal ? { signal: params.signal } : {}),
      });
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
      codexPluginPatch !== undefined ||
      pendingCodexInstall !== undefined ||
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
      if (
        !successfulHarnessId ||
        (testPlan.agentHarnessRuntimeOverride !== "auto" &&
          successfulHarnessId !== testPlan.agentHarnessRuntimeOverride)
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
    let committedConfig: OpenClawConfig | undefined;
    let autoLocalModelLeanApplied = false;
    if (!needsPersistence) {
      const latestSnapshot = await readSnapshot();
      const latestRuntime =
        latestSnapshot.exists && latestSnapshot.valid
          ? (latestSnapshot.runtimeConfig ?? latestSnapshot.config)
          : undefined;
      const latestRoute = latestRuntime
        ? await projectDefaultInferenceRoute(latestRuntime)
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
        ? await resolveSystemAgentConfiguredRouteFromConfig(latestRuntime)
        : null;
      if (!latestResolvedRoute) {
        return {
          ok: false,
          status: "unknown",
          error:
            "The default-agent inference route could not be resolved after its live test. Review the current model/auth/runtime settings and retry.",
        };
      }
      await revalidateStableSetupInferenceOwner({
        route: latestResolvedRoute,
        auth: test.auth,
        stagedOwnerPluginArtifacts,
        deps,
      });
    }
    if (needsPersistence) {
      const persistenceState: SetupInferenceActivationPersistenceState = {
        committedConfig,
        autoLocalModelLeanApplied,
        codexInstallOwnership,
      };
      const persistenceFailure = await persistActivatedSetupInference({
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
        state: persistenceState,
        revalidateOwner: revalidateStableSetupInferenceOwner,
      });
      if (persistenceFailure) {
        return persistenceFailure;
      }
      ({ committedConfig, autoLocalModelLeanApplied, codexInstallOwnership } = persistenceState);
    }
    if (codexRegistryNeedsReload && committedConfig) {
      codexRegistryReloaded = await reloadCodexRegistryAfterActivation({
        readSnapshot,
        workspaceDir: workspace,
        deps,
      });
      if (!codexRegistryReloaded) {
        throw new SetupInferenceActivationIndeterminateError(
          "Inference activation committed, but the active plugin registry could not be reloaded. Restart the Gateway before using Codex inference.",
        );
      }
    }
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
    };
  } finally {
    let codexCleanupError: SetupInferenceActivationIndeterminateError | undefined;
    if (pendingCodexInstall && codexInstallOwnership !== "owned") {
      // Reassert after probing: a partial install-index commit may have cleared
      // the early marker even though the matching model route never committed.
      const retained = await retainUnownedCodexInstall({
        record: pendingCodexInstall,
        verifyOwnership: false,
        deps,
      });
      if (!retained) {
        codexCleanupError = new SetupInferenceActivationIndeterminateError(
          "Inference activation stopped before its Codex runtime package could be retained safely. Restart the Gateway before retrying.",
        );
      }
    }
    if (codexRegistryNeedsReload && !codexRegistryReloaded) {
      // The probe loaded discovery against staged config. Restore the live
      // registry from the latest persisted config before another request runs.
      codexRegistryReloaded = await reloadCodexRegistryAfterActivation({
        readSnapshot,
        workspaceDir: workspace,
        deps,
      });
      if (!codexRegistryReloaded) {
        codexCleanupError = new SetupInferenceActivationIndeterminateError(
          "Inference activation could not restore the active plugin registry after its Codex probe. Restart the Gateway before retrying.",
        );
      }
    }
    await cleanupSetupInferenceTempDir({ tempDir, deps, runtime: params.runtime });
    if (codexCleanupError) {
      // oxlint-disable-next-line no-unsafe-finally -- an indeterminate plugin cleanup must supersede a stale success result
      throw codexCleanupError;
    }
  }
}

function resolveCodexCliSetupApiKey(
  params: ActivateSetupInferenceParams,
): CodexCliApiKeyCredential | null {
  if (params.kind !== "codex-cli") {
    return null;
  }
  const reader = params.deps?.readCodexCliActiveApiKey ?? readCodexCliActiveApiKey;
  return reader({ allowKeychainPrompt: true });
}

export async function redactSetupInferenceError(
  message: string,
  ...apiKeys: Array<string | undefined>
): Promise<string> {
  const secrets = new Set(
    apiKeys
      .flatMap((apiKey) => [apiKey, apiKey?.trim()])
      .filter((value): value is string => Boolean(value)),
  );
  let redacted = message;
  for (const secret of Array.from(secrets).toSorted((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  const { redactToolPayloadText } = await import("../logging/redact.js");
  return redactToolPayloadText(redacted);
}
