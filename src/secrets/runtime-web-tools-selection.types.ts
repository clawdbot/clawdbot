/** Typed credential ownership and unavailable-provider results for runtime web tools. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef, SecretRefSource } from "../config/types.secrets.js";
import type { SecretDegradationReason } from "./runtime-degraded-state.js";
import type { SecretResolverWarningCode } from "./runtime-shared.js";
import type { RuntimeWebDiagnosticCode } from "./runtime-web-tools.types.js";

export type RuntimeWebWarningCode = Extract<RuntimeWebDiagnosticCode, SecretResolverWarningCode>;

export type RuntimeWebResolveSecretInputParams = {
  providerId: string;
  value: unknown;
  path: string;
  envVars: string[];
  contractDigest: string;
};

export type SecretResolutionResult<TSource extends string> = {
  value?: string;
  source: TSource;
  secretRefConfigured: boolean;
  secretRef?: SecretRef;
  secretRefKey?: string;
  unresolvedRefReason?: SecretDegradationReason;
  fallbackEnvVar?: string;
};

export type RuntimeWebSecretRef = {
  path: string;
  ref: SecretRef;
  refKey: string;
  resolvedValue?: string;
  restoreResolvedValue?: (value: string) => void;
};

export type RuntimeWebSecretOwner = {
  providerId: string;
  contractDigest: string;
  refs: RuntimeWebSecretRef[];
};

export type RuntimeWebUnavailableProvider = RuntimeWebSecretRef & {
  providerId: string;
  contractDigest: string;
  reason: SecretDegradationReason;
  providerFailure?: { source: SecretRefSource; provider: string };
};

export type RuntimeWebProviderSelectionResult = {
  secretOwners: RuntimeWebSecretOwner[];
  unavailableProviders: RuntimeWebUnavailableProvider[];
};

export type RuntimeWebConfiguredSecretInput = {
  path: string;
  value: unknown;
  setResolvedValue: (configTarget: OpenClawConfig, value: string) => void;
};

/** Carries typed web-provider ownership through strict reload failures. */
export class RuntimeWebProviderUnavailableError extends Error {
  readonly unavailableProviders: RuntimeWebUnavailableProvider[];

  constructor(
    code: RuntimeWebWarningCode,
    reason: SecretDegradationReason,
    unavailableProviders: RuntimeWebUnavailableProvider[],
  ) {
    super(`[${code}] ${reason}`);
    this.name = "RuntimeWebProviderUnavailableError";
    this.unavailableProviders = unavailableProviders;
  }
}
