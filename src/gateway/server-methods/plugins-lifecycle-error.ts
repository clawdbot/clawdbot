import { buildCapabilityConsentErrorDetails } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  isClawHubTrustErrorCode,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  readInstallPolicyWarningErrorDetails,
} from "../../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import {
  projectPluginRuntimeFailure,
  type PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";

export function pluginLifecycleError(error: unknown, application?: PluginRuntimeApplication) {
  const failure = projectPluginRuntimeFailure(error, application);
  const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
  const trustCode =
    lifecycleError?.code && isClawHubTrustErrorCode(lifecycleError.code)
      ? lifecycleError.code
      : undefined;
  const installDetails = lifecycleError?.capabilityConsent
    ? buildCapabilityConsentErrorDetails(lifecycleError.capabilityConsent)
    : lifecycleError?.installPolicyWarning
      ? readInstallPolicyWarningErrorDetails({
          installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
          ...lifecycleError.installPolicyWarning,
        })
      : lifecycleError
        ? buildClawHubTrustErrorDetails({
            ...(trustCode ? { code: trustCode } : {}),
            ...(lifecycleError.version ? { version: lifecycleError.version } : {}),
            ...(lifecycleError.warning ? { warning: lifecycleError.warning } : {}),
          })
        : undefined;
  const metadata =
    installDetails ??
    (lifecycleError?.installRejected
      ? {
          pluginInstallRejected: true,
          ...(lifecycleError.code ? { pluginInstallCode: lifecycleError.code } : {}),
          ...(lifecycleError.installSource
            ? { pluginInstallSource: lifecycleError.installSource }
            : {}),
        }
      : undefined);
  const details = failure.runtime
    ? {
        ...metadata,
        runtime: failure.runtime,
        ...(failure.runtimeAttempt ? { runtimeAttempt: failure.runtimeAttempt } : {}),
      }
    : metadata;
  return errorShape(
    lifecycleError?.kind === "invalid-request"
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    failure.message,
    details ? { details } : undefined,
  );
}
