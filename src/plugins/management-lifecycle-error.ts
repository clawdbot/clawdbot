import type { CapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { PluginInstallSource } from "./install-channel-specs.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";

export class ManagedPluginLifecycleError extends Error {
  readonly kind: "invalid-request" | "unavailable";
  readonly code?: string;
  readonly installRejected?: boolean;
  readonly installSource?: PluginInstallSource;
  readonly version?: string;
  readonly warning?: string;
  readonly installPolicyWarning?: InstallPolicyWarningDetails;
  readonly capabilityConsent?: Omit<CapabilityConsentErrorDetails, "capabilityConsentCode">;

  constructor(
    message: string,
    details?: Partial<Omit<ManagedPluginLifecycleError, keyof Error>> & ErrorOptions,
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "ManagedPluginLifecycleError";
    this.kind = details?.kind ?? "invalid-request";
    this.code = details?.code;
    this.installRejected = details?.installRejected;
    this.installSource = details?.installSource;
    this.version = details?.version;
    this.warning = details?.warning;
    this.installPolicyWarning = details?.installPolicyWarning;
    this.capabilityConsent = details?.capabilityConsent;
  }
}
