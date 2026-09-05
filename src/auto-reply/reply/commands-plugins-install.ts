import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { captureAgentPluginRuntimeRefresh } from "../../agents/plugin-runtime-refresh.js";
import {
  formatPluginCapabilityConsentLines,
  resolvePluginCapabilityConsentCliOptions,
} from "../../cli/plugin-capability-consent.js";
import { resolvePendingPluginCapabilityReview } from "../../plugins/capability-consent.js";
import {
  formatNonClawHubInstallWarning,
  NON_CLAWHUB_INSTALL_FORCE_FLAG,
  type NonClawHubInstallSourceClass,
} from "../../plugins/install-provenance.js";
import { resolvePluginInstallSourcePlan } from "../../plugins/install-source-plan.js";
import {
  capturePluginRuntimeApplications,
  PluginRuntimeApplicationError,
  projectPluginRuntimeFailure,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { installManagedPlugin } from "../../plugins/management-mutations.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";

/** Bind chat mutations to the admitted Gateway; recheck after consent and persistence await points. */
export function resolvePluginCommandRuntimeApply(): PluginLifecycleRuntimeApply {
  const scope = getPluginRuntimeGatewayRequestScope();
  const resolve = scope?.resolveGatewayContext ?? scope?.context?.resolveGatewayContext;
  const admitted = resolve?.();
  const apply = admitted?.applyPluginLifecycleChange;
  if (!admitted || !apply) {
    throw new Error(
      "Plugin changes require an active Gateway. Retry this command after reconnecting.",
    );
  }
  const refresh = captureAgentPluginRuntimeRefresh();
  refresh.assertCurrent();
  return async (params) => {
    if (resolve?.() !== admitted) {
      throw new Error("Gateway changed during the plugin operation. Reconnect and retry.");
    }
    try {
      const application = await apply(params);
      refresh.request(application);
      return application;
    } catch (error) {
      if (error instanceof PluginRuntimeApplicationError && error.details.committed) {
        refresh.request(error.details);
      }
      throw error;
    }
  };
}

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
  applyRuntime: PluginLifecycleRuntimeApply;
}): Promise<
  | {
      ok: true;
      pluginId: string;
      warnings?: readonly string[];
      application?: PluginRuntimeApplication;
    }
  | { ok: false; error: string }
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
  const captured = capturePluginRuntimeApplications(params.applyRuntime);
  try {
    const result = await installManagedPlugin({
      request: plan.request,
      applyRuntime: captured.applyRuntime,
      ...resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: params.acceptCapabilities,
        action: "install",
        allowPrompt: false,
      }),
    });
    return {
      ok: true,
      pluginId: result.plugin.id,
      application: result.application,
      warnings: [
        ...(result.warnings ?? []),
        ...(plan.warning ? [plan.warning] : []),
        ...(acknowledgement?.ok ? [acknowledgement.warning] : []),
      ].map(stripAnsi),
    };
  } catch (error) {
    const forceFlag = params.force ? " --force" : "";
    const { message } = projectPluginRuntimeFailure(error, captured.application);
    const failure =
      error instanceof ManagedPluginLifecycleError && error.warning
        ? `${error.warning} ${message}`
        : message;
    return {
      ok: false,
      error:
        formatPluginCommandCapabilityConsentError(
          error,
          `/plugins install ${params.raw}${forceFlag}`,
        ) ?? stripAnsi(failure),
    };
  }
}
