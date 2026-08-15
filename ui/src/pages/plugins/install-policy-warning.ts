import {
  type InstallPolicyWarningErrorDetails,
  readInstallPolicyWarningErrorDetails,
} from "../../../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import { GatewayRequestError } from "../../api/gateway.ts";

export type PluginInstallPolicyWarningDetails = InstallPolicyWarningErrorDetails;

export function readPluginInstallPolicyWarning(
  error: unknown,
): InstallPolicyWarningErrorDetails | undefined {
  if (!(error instanceof GatewayRequestError)) {
    return undefined;
  }
  return readInstallPolicyWarningErrorDetails(error.details);
}
