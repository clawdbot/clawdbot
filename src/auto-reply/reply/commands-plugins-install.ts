import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import {
  formatPluginCapabilityConsentLines,
  resolvePluginCapabilityConsentCliOptions,
} from "../../cli/plugin-capability-consent.js";
import { resolvePluginInstallSourcePlan } from "../../cli/plugin-install-plan.js";
import { createPluginInstallLogger } from "../../cli/plugins-command-helpers.js";
import { resolvePendingPluginCapabilityReview } from "../../plugins/capability-consent.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../../plugins/clawhub.js";
import type { ConfigSnapshotForInstallPersist } from "../../plugins/install-persistence.js";
import {
  formatNonClawHubInstallWarning,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  type NonClawHubInstallSourceClass,
} from "../../plugins/install-provenance.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { installManagedPluginSource } from "../../plugins/management-service.js";

export function formatPluginCommandCapabilityConsentError(
  error: unknown,
  retryCommand: string,
): string | null {
  if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
    return null;
  }
  const review = resolvePendingPluginCapabilityReview(error.capabilityConsent.pluginId);
  if (review?.reviewToken !== error.capabilityConsent.reviewToken) {
    return null;
  }
  return [
    ...formatPluginCapabilityConsentLines(review),
    `Review these capabilities, then rerun ${stripAnsi(retryCommand)} --accept-capabilities to continue.`,
  ].join("\n");
}

function resolveNonClawHubChatInstallAcknowledgement(params: {
  force: boolean;
  sourceClass: NonClawHubInstallSourceClass;
  spec: string;
}): { ok: true; warning: string } | { ok: false; error: string } {
  const warning = formatNonClawHubInstallWarning(params);
  if (params.force) {
    return { ok: true, warning };
  }
  return {
    ok: false,
    error: `${warning}\nReview the source, then rerun this chat command with ${NON_CLAWHUB_INSTALL_FORCE_FLAG} to continue.`,
  };
}

export async function installPluginFromPluginsCommand(params: {
  raw: string;
  acceptCapabilities: boolean;
  force: boolean;
  snapshot: ConfigSnapshotForInstallPersist;
}): Promise<
  { ok: true; pluginId: string; warnings?: readonly string[] } | { ok: false; error: string }
> {
  const installMode = params.force ? "update" : "install";
  const plan = resolvePluginInstallSourcePlan({ raw: params.raw, mode: installMode });
  if (!plan.ok) {
    return { ok: false, error: plan.error.replace(/^Plugin path not found:/, "Path not found:") };
  }
  const acknowledgement = plan.acknowledgement
    ? resolveNonClawHubChatInstallAcknowledgement({
        force: params.force,
        ...plan.acknowledgement,
      })
    : null;
  if (acknowledgement && !acknowledgement.ok) {
    return acknowledgement;
  }
  const warnings: string[] = [];
  const logger = createPluginInstallLogger();
  const clawhub = plan.request.source === "clawhub";
  let result: Awaited<ReturnType<typeof installManagedPluginSource>>;
  try {
    result = await installManagedPluginSource({
      request: plan.request,
      snapshot: params.snapshot,
      ...resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: params.acceptCapabilities,
        action: "install",
        allowPrompt: false,
      }),
      logger: clawhub
        ? {
            info: logger.info,
            warn: (message) => {
              warnings.push(stripAnsi(message));
              logger.warn(message);
            },
            terminalLinks: false,
          }
        : logger,
    });
  } catch (error) {
    const forceFlag = params.force ? " --force" : "";
    const consentError = formatPluginCommandCapabilityConsentError(
      error,
      `/plugins install ${params.raw}${forceFlag}`,
    );
    if (consentError) {
      return { ok: false, error: consentError };
    }
    throw error;
  }
  if (!result.ok) {
    const warning = "warning" in result ? result.warning : warnings.join("\n");
    const warningPrefix = warning ? `${warning} ` : "";
    if (
      clawhub &&
      result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED
    ) {
      return {
        ok: false,
        error: `${warningPrefix}${result.error} The /plugins chat command cannot acknowledge ClawHub risk; run the local openclaw plugins install command with --acknowledge-clawhub-risk from a trusted shell after reviewing the warning.`,
      };
    }
    return { ok: false, error: `${warningPrefix}${result.error}` };
  }
  warnings.push(...(result.warnings ?? []));
  if (acknowledgement?.ok) {
    warnings.push(acknowledgement.warning);
  }
  return {
    ok: true,
    pluginId: result.pluginId,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
