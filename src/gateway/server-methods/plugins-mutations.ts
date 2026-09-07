// Gateway handlers for durable plugin lifecycle mutations.
import { buildCapabilityConsentErrorDetails } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  isClawHubTrustErrorCode,
  validatePluginsInstallParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  readInstallPolicyWarningErrorDetails,
} from "../../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import {
  installManagedPlugin,
  setManagedPluginEnabled,
} from "../../plugins/management-mutations.js";
import { uninstallManagedPlugin } from "../../plugins/management-uninstall.js";
import { buildGatewayReloadPlan } from "../config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../config-reload-settings.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function pluginPolicyRestartRequired(params: {
  config: OpenClawConfig;
  changedPaths: readonly string[];
}): boolean {
  const plan = buildGatewayReloadPlan([...params.changedPaths]);
  const mode = resolveGatewayReloadSettings(params.config).mode;
  return plan.restartGateway || mode === "off";
}

export const pluginMutationHandlers: GatewayRequestHandlers = {
  "plugins.install": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsInstallParams, "plugins.install", respond)) {
      return;
    }
    try {
      const result = await installManagedPlugin({ request: params });
      respond(
        true,
        {
          ok: true,
          plugin: result.plugin,
          restartRequired: true,
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      const trustCode =
        lifecycleError?.code && isClawHubTrustErrorCode(lifecycleError.code)
          ? lifecycleError.code
          : undefined;
      const trustDetails = lifecycleError
        ? buildClawHubTrustErrorDetails({
            ...(trustCode ? { code: trustCode } : {}),
            ...(lifecycleError.version ? { version: lifecycleError.version } : {}),
            ...(lifecycleError.warning ? { warning: lifecycleError.warning } : {}),
          })
        : undefined;
      const installPolicyDetails = lifecycleError?.installPolicyWarning
        ? readInstallPolicyWarningErrorDetails({
            installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
            ...lifecycleError.installPolicyWarning,
          })
        : undefined;
      const capabilityConsentDetails = lifecycleError?.capabilityConsent
        ? buildCapabilityConsentErrorDetails(lifecycleError.capabilityConsent)
        : undefined;
      const details = capabilityConsentDetails ?? installPolicyDetails ?? trustDetails;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatErrorMessage(error),
          details ? { details } : undefined,
        ),
      );
    }
  },
  "plugins.uninstall": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsUninstallParams, "plugins.uninstall", respond)) {
      return;
    }
    try {
      const result = await uninstallManagedPlugin({ pluginId: params.pluginId });
      respond(
        true,
        {
          ok: true,
          pluginId: result.pluginId,
          restartRequired: true,
          removed: result.removed,
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatErrorMessage(error),
        ),
      );
    }
  },
  "plugins.setEnabled": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validatePluginsSetEnabledParams, "plugins.setEnabled", respond)
    ) {
      return;
    }
    try {
      const result = await setManagedPluginEnabled({
        pluginId: params.pluginId,
        enabled: params.enabled,
        ...(params.acknowledgeCapabilities
          ? { acknowledgeCapabilities: params.acknowledgeCapabilities }
          : {}),
      });
      respond(
        true,
        {
          ok: true,
          plugin: result.plugin,
          restartRequired: pluginPolicyRestartRequired({
            config: context.getRuntimeConfig(),
            changedPaths: result.changedPaths,
          }),
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatErrorMessage(error),
          lifecycleError?.capabilityConsent
            ? { details: buildCapabilityConsentErrorDetails(lifecycleError.capabilityConsent) }
            : undefined,
        ),
      );
    }
  },
};
