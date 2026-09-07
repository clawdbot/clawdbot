// Executes validated plugin, marketplace, ClawHub, and hook-pack install requests.
import { theme } from "../../packages/terminal-core/src/theme.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config.js";
import { reportClawHubPluginInstallTelemetry } from "../infra/clawhub-packages.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub.js";
import { installManagedPluginSource } from "../plugins/management-install.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { tracePluginLifecyclePhaseAsync } from "../plugins/plugin-lifecycle-trace.js";
import { defaultRuntime } from "../runtime.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { shortenHomePath } from "../utils.js";
import { resolveClawHubInstallConfirmation } from "./clawhub-install-confirmation.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import {
  confirmNonClawHubInstall,
  type NonClawHubInstallSourceClass,
} from "./non-clawhub-install-acknowledgement.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import {
  createPluginInstallLogger,
  formatPluginInstallWithHookFallbackError,
} from "./plugins-command-helpers.js";
import {
  loadConfigForInstall,
  resolveFullyBlockedConfigMutationReason,
} from "./plugins-install-config.js";
import {
  isTerminalPluginInstallFailure,
  probeHookPackFromPath,
  resolveInstallSafetyOverrides,
  tryInstallHookPackFromLocalPath,
  tryInstallPluginOrHookPackFromNpmSpec,
} from "./plugins-install-hook-fallback.js";
import {
  resolvePluginInstallPreflight,
  type PluginInstallPreflight,
  type RunPluginInstallCommandParams,
} from "./plugins-install-preflight.js";

const DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING =
  "--dangerously-force-unsafe-install is deprecated and no longer affects plugin installs because built-in install-time dangerous-code scanning has been removed. Configure security.installPolicy for operator-owned install decisions.";

function isClawHubBlockedCliFailure(result: { code?: string; warning?: string }): boolean {
  return (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED &&
    typeof result.warning === "string" &&
    result.warning.trim().length > 0
  );
}

/** Validate install intent before opening the SQLite-backed plugin lifecycle lease. */
export async function runPluginInstallCommand(params: RunPluginInstallCommandParams) {
  assertConfigWriteAllowedInCurrentMode();
  const runtime = params.runtime ?? defaultRuntime;
  const preflight = await resolvePluginInstallPreflight(params);
  if (!preflight.ok) {
    runtime.error(preflight.error);
    return runtime.exit(1);
  }
  return await withPluginLifecycleLease(
    {},
    async (lease) =>
      await runPluginInstallCommandUnlocked(
        {
          ...params,
          beforePersistentApply: () => {
            lease.assertOwned();
            params.beforePersistentApply?.();
          },
        },
        preflight,
        lease.assertOwned.bind(lease),
      ),
  );
}

async function runPluginInstallCommandUnlocked(
  params: RunPluginInstallCommandParams,
  preflight: Extract<PluginInstallPreflight, { ok: true }>,
  assertOwned: () => void,
) {
  assertConfigWriteAllowedInCurrentMode();

  const runtime = params.runtime ?? defaultRuntime;
  const { raw, opts, installMode, request } = preflight;
  if (opts.dangerouslyForceUnsafeInstall) {
    runtime.log(theme.warn(DEPRECATED_DANGEROUS_FORCE_UNSAFE_INSTALL_WARNING));
  }
  const snapshot = await loadConfigForInstall(request).catch((error: unknown) => {
    runtime.error(formatErrorMessage(error));
    return null;
  });
  if (!snapshot) {
    return runtime.exit(1);
  }
  const installContext = {
    snapshot,
    runtime,
    invalidateRuntimeCache: params.invalidateRuntimeCache ?? true,
    beforePersistentApply: params.beforePersistentApply,
    assertOwned,
  };
  const safetyOverrides = resolveInstallSafetyOverrides({
    ...opts,
    config: snapshot.config,
    ...resolveInstallPolicyWarningAcknowledgementCliOptions({
      acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
      allowPrompt: params.allowInstallPolicyWarningPrompt,
      dangerouslyForceUnsafeInstall: opts.dangerouslyForceUnsafeInstall,
    }),
  });
  const capabilityConsent = resolvePluginCapabilityConsentCliOptions({
    acceptCapabilities: opts.acceptCapabilities,
    action: "install",
    runtime,
  });
  const acknowledgeNonClawHubSource = async (
    sourceClass: NonClawHubInstallSourceClass,
    spec: string,
  ): Promise<boolean> =>
    await confirmNonClawHubInstall({
      acknowledged: opts.force,
      runtime,
      sourceClass,
      spec,
    });

  if (preflight.sourcePlan === null) {
    if (
      !(await acknowledgeNonClawHubSource("marketplace", `${raw} from ${preflight.marketplace}`))
    ) {
      return runtime.exit(1);
    }
    const result = await installManagedPluginSource({
      request: {
        source: "marketplace",
        marketplace: preflight.marketplace,
        plugin: raw,
        mode: installMode,
      },
      ...installContext,
      ...capabilityConsent,
      safetyOverrides,
      logger: createPluginInstallLogger(runtime),
    });
    if (!result.ok) {
      if (!isClawHubBlockedCliFailure(result)) {
        runtime.error(result.error);
      }
      return runtime.exit(1);
    }
    return;
  }

  const { sourcePlan } = preflight;
  if (
    sourcePlan.acknowledgement &&
    !(await acknowledgeNonClawHubSource(
      sourcePlan.acknowledgement.sourceClass,
      sourcePlan.acknowledgement.spec,
    ))
  ) {
    return runtime.exit(1);
  }

  const sourceRequest = sourcePlan.request;
  switch (sourceRequest.source) {
    case "local": {
      const resolved = sourceRequest.path;
      if (sourceRequest.link) {
        sourceRequest.successMessage = `Linked plugin path: ${shortenHomePath(resolved)}`;
      }
      const fullyBlockedReason = resolveFullyBlockedConfigMutationReason(snapshot);
      if (fullyBlockedReason) {
        runtime.error(fullyBlockedReason);
        return runtime.exit(1);
      }
      if (snapshot.pluginMutation.mode === "blocked" || snapshot.hookMutation.mode === "blocked") {
        const hookProbe = await probeHookPackFromPath({
          ...safetyOverrides,
          path: resolved,
          mode: installMode,
          inspection: "package-kind",
        });
        if (hookProbe.ok && hookProbe.packageKind === "hook-only") {
          if (snapshot.hookMutation.mode === "blocked") {
            runtime.error(snapshot.hookMutation.reason);
            return runtime.exit(1);
          }
          const hookFallback = await tryInstallHookPackFromLocalPath({
            ...installContext,
            installMode,
            resolvedPath: resolved,
            safetyOverrides,
            ...(opts.link ? { link: true } : {}),
            expectedPackageKind: "hook-only",
          });
          if (hookFallback.ok) {
            return;
          }
          runtime.error(hookFallback.error);
          return runtime.exit(1);
        }
        if (snapshot.pluginMutation.mode === "blocked") {
          runtime.error(snapshot.pluginMutation.reason);
          return runtime.exit(1);
        }
      }

      const result = await installManagedPluginSource({
        request: sourceRequest,
        ...installContext,
        ...capabilityConsent,
        safetyOverrides,
        logger: createPluginInstallLogger(runtime),
      });
      if (result.ok) {
        return;
      }
      if (isTerminalPluginInstallFailure(result.code)) {
        runtime.error(result.error);
        return runtime.exit(1);
      }
      const hookFallback = await tryInstallHookPackFromLocalPath({
        ...installContext,
        installMode,
        resolvedPath: resolved,
        safetyOverrides,
        ...(sourceRequest.link ? { link: true } : {}),
      });
      if (hookFallback.ok) {
        return;
      }
      runtime.error(formatPluginInstallWithHookFallbackError(result.error, hookFallback));
      return runtime.exit(1);
    }

    case "marketplace":
    case "npm-pack":
    case "git": {
      const result = await installManagedPluginSource({
        request: sourceRequest,
        ...installContext,
        ...capabilityConsent,
        safetyOverrides,
        logger: createPluginInstallLogger(runtime),
      });
      if (!result.ok) {
        runtime.error(result.error);
        return runtime.exit(1);
      }
      return;
    }

    case "bundled": {
      const result = await tracePluginLifecyclePhaseAsync(
        "install execution",
        () =>
          installManagedPluginSource({
            request: sourceRequest,
            ...installContext,
          }),
        {
          command: "install",
          source: "bundled",
          pluginId: sourceRequest.bundledSource.pluginId,
        },
      );
      if (!result.ok) {
        runtime.error(result.error);
        return runtime.exit(1);
      }
      return;
    }

    case "official": {
      const primary = sourceRequest.installSources?.[0];
      if (primary?.source === "clawhub") {
        const result = await installManagedPluginSource({
          request: sourceRequest,
          ...installContext,
          ...capabilityConsent,
          safetyOverrides,
          logger: createPluginInstallLogger(runtime),
        });
        if (!result.ok) {
          runtime.error(result.error);
          return runtime.exit(1);
        }
        return;
      }
      const result = await tryInstallPluginOrHookPackFromNpmSpec({
        ...installContext,
        installMode,
        spec: sourceRequest.spec,
        pin: sourceRequest.pin,
        safetyOverrides,
        capabilityConsent,
        allowBundledFallback: false,
        expectedPluginId: sourceRequest.pluginId,
        expectedIntegrity: primary?.expectedIntegrity ?? sourceRequest.expectedIntegrity,
        trustedSourceLinkedOfficialInstall: true,
        officialRequest: sourceRequest,
      });
      if (!result.ok) {
        return runtime.exit(1);
      }
      return;
    }

    case "clawhub": {
      const installFromClawHub = async (
        installSnapshot = snapshot,
        installSafetyOverrides = safetyOverrides,
      ) => {
        const result = await installManagedPluginSource({
          ...installContext,
          request: {
            ...sourceRequest,
            ...(opts.expectedIntegrity ? { expectedIntegrity: opts.expectedIntegrity } : {}),
            ...(opts.expectedPluginId ? { expectedPluginId: opts.expectedPluginId } : {}),
            confirmInstall: resolveClawHubInstallConfirmation(),
          },
          snapshot: installSnapshot,
          ...capabilityConsent,
          safetyOverrides: installSafetyOverrides,
          logger: createPluginInstallLogger(runtime),
        });
        if (!result.ok) {
          if (!isClawHubBlockedCliFailure(result)) {
            runtime.error(result.error);
          }
          return runtime.exit(1);
        }
        if (!result.clawhub) {
          runtime.error("ClawHub plugin install completed without source metadata.");
          return runtime.exit(1);
        }

        if (!params.clawManaged && result.clawhub.version) {
          markClawPackageIndependentlyOwned({
            kind: "plugin",
            source: "clawhub",
            ref: result.clawhub.clawhubPackage,
            version: result.clawhub.version,
          });
        }
        await reportClawHubPluginInstallTelemetry({
          baseUrl: result.clawhub.clawhubUrl,
          packageName: result.clawhub.clawhubPackage,
          version: result.clawhub.version,
        }).catch(() => undefined);
      };
      if (params.clawManaged) {
        return await installFromClawHub();
      }
      return await withClawPackageLifecycleLease(
        {
          kind: "plugin",
          source: "clawhub",
          ref: parseClawHubPluginSpec(sourceRequest.spec)?.name ?? sourceRequest.spec,
        },
        async () => {
          const leasedSnapshot = await loadConfigForInstall(request).catch((error: unknown) => {
            runtime.error(formatErrorMessage(error));
            return null;
          });
          if (!leasedSnapshot) {
            return runtime.exit(1);
          }
          return await installFromClawHub(
            leasedSnapshot,
            resolveInstallSafetyOverrides({ ...safetyOverrides, config: leasedSnapshot.config }),
          );
        },
      );
    }

    case "npm": {
      const result = await tryInstallPluginOrHookPackFromNpmSpec({
        ...installContext,
        installMode,
        spec: sourceRequest.spec,
        pin: sourceRequest.pin,
        safetyOverrides,
        capabilityConsent,
        allowBundledFallback: sourceRequest.allowBundledFallback ?? false,
        expectedPluginId: sourceRequest.expectedPluginId,
        expectedIntegrity: sourceRequest.expectedIntegrity,
        trustedSourceLinkedOfficialInstall: sourceRequest.trustedSourceLinkedOfficialInstall,
      });
      if (!result.ok) {
        return runtime.exit(1);
      }
    }
  }
}
