import type { PluginsInstallParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
// Executes validated plugin, marketplace, ClawHub, and hook-pack install requests.
import { theme } from "../../packages/terminal-core/src/theme.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub.js";
import { loadConfigForInstall } from "../plugins/install-config.js";
import { installManagedPlugin } from "../plugins/management-mutations.js";
import { defaultRuntime } from "../runtime.js";
import { resolveClawHubInstallConfirmation } from "./clawhub-install-confirmation.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { confirmNonClawHubInstall } from "./non-clawhub-install-acknowledgement.js";
import { resolvePluginCapabilityConsentCliOptions } from "./plugin-capability-consent.js";
import { createPluginInstallLogger } from "./plugins-command-helpers.js";
import { createGatewayPluginInstaller } from "./plugins-install-gateway.js";
import {
  installPluginWithHookFallback,
  resolveInstallSafetyOverrides,
} from "./plugins-install-hook-fallback.js";
import {
  resolvePluginInstallPreflight,
  type RunPluginInstallCommandParams,
} from "./plugins-install-preflight.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";

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
  const gateway = await resolvePluginLifecycleGateway();
  const install = gateway ? createGatewayPluginInstaller(gateway) : installManagedPlugin;
  assertConfigWriteAllowedInCurrentMode();
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
  const acknowledgement =
    preflight.sourcePlan === null
      ? { sourceClass: "marketplace" as const, spec: `${raw} from ${preflight.marketplace}` }
      : preflight.sourcePlan.acknowledgement;
  if (
    acknowledgement &&
    !(await confirmNonClawHubInstall({
      ...acknowledgement,
      acknowledged: opts.force,
      runtime,
    }))
  ) {
    return runtime.exit(1);
  }

  const sourceRequest: PluginsInstallParams = preflight.sourcePlan?.request ?? {
    source: "marketplace",
    marketplace: preflight.marketplace!,
    plugin: raw,
    mode: installMode,
  };
  if (preflight.sourcePlan?.warning) {
    runtime.log(theme.warn(preflight.sourcePlan.warning));
  }
  const result = await installPluginWithHookFallback({
    snapshot,
    safetyOverrides,
    runtime,
    allowBundledFallback: preflight.sourcePlan?.allowBundledFallback,
    install,
    ...capabilityConsent,
    request: {
      ...(sourceRequest.source === "clawhub" || sourceRequest.source === "npm"
        ? {
            ...sourceRequest,
            ...(opts.expectedIntegrity ? { expectedIntegrity: opts.expectedIntegrity } : {}),
            ...(opts.expectedPluginId ? { expectedPluginId: opts.expectedPluginId } : {}),
          }
        : sourceRequest),
      ...(params.clawManaged ? { clawManaged: true } : {}),
    },
    logger: createPluginInstallLogger(runtime),
    confirmInstall: resolveClawHubInstallConfirmation(),
  });
  if (result.ok) {
    return;
  }
  if (result.warning) {
    runtime.log(theme.warn(result.warning));
  }
  if (!isClawHubBlockedCliFailure(result)) {
    runtime.error(result.error);
  }
  return runtime.exit(1);
}
