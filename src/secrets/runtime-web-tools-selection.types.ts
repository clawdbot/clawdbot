/** Typed credential ownership and unavailable-provider results for runtime web tools. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef, SecretRefSource } from "../config/types.secrets.js";
import type { SecretDegradationReason } from "./runtime-degraded-state.js";
import type {
  ResolverContext,
  SecretDefaults,
  SecretResolverWarningCode,
} from "./runtime-shared.js";
import type { RuntimeWebDiagnostic, RuntimeWebDiagnosticCode } from "./runtime-web-tools.types.js";

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

export type RuntimeWebSecretOwner = {
  providerId: string;
  path: string;
  ref: SecretRef;
  refKey: string;
  contractDigest: string;
  resolvedValue?: string;
  reason?: SecretDegradationReason;
  providerFailure?: { source: SecretRefSource; provider: string };
  restoreResolvedValue?: (value: string) => void;
};

export type RuntimeWebUnavailableProvider = RuntimeWebSecretOwner & {
  reason: SecretDegradationReason;
};

export type RuntimeWebProviderSelectionResult = {
  secretOwners: RuntimeWebSecretOwner[];
  unavailableProviders: RuntimeWebUnavailableProvider[];
};

/** Metadata fields shared by runtime web search and fetch provider selection. */
export type RuntimeWebProviderMetadataBase<TSource extends string> = {
  providerConfigured?: string;
  providerSource: "configured" | "auto-detect" | "none";
  selectedProvider?: string;
  selectedProviderKeySource?: TSource;
  diagnostics: RuntimeWebDiagnostic[];
};

/**
 * Parameters shared by web search/fetch provider selection after provider surface discovery.
 */
export type RuntimeWebProviderSelectionParams<
  TProvider extends {
    id: string;
    requiresCredential?: boolean;
  },
  TToolConfig extends Record<string, unknown> | undefined,
  TSource extends string,
  TMetadata extends RuntimeWebProviderMetadataBase<TSource>,
> = {
  scopePath: string;
  toolConfig: TToolConfig;
  enabled: boolean;
  providers: TProvider[];
  configuredProvider?: string;
  metadata: TMetadata;
  diagnostics: RuntimeWebDiagnostic[];
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  context: ResolverContext;
  defaults: SecretDefaults | undefined;
  /** Allow keyless providers to be selected when no provider is explicitly configured. */
  allowKeylessAutoSelect: boolean;
  /** Defer keyless providers until credential-bearing auto-detect candidates are exhausted. */
  deferKeylessFallback: boolean;
  /**
   * Provider IDs whose credentials stay active even when not selected because
   * they have enabled standalone tools that need the same credential.
   */
  standaloneToolProviderIds?: ReadonlySet<string>;
  /** Keep cold-start preparation alive when no configured provider ref can resolve. */
  allowUnavailableProviders?: boolean;
  onUnavailableProviders?: (error: RuntimeWebProviderUnavailableError) => void;
  noFallbackCode: RuntimeWebWarningCode;
  autoDetectSelectedCode: RuntimeWebWarningCode;
  /** Reads the primary credential location for a provider from source config. */
  readConfiguredCredential: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => unknown;
  readConfiguredCredentialFallback?: (params: {
    provider: TProvider;
    config: OpenClawConfig;
    toolConfig: TToolConfig;
  }) => { path: string; value: unknown } | undefined;
  /** Resolves inline/env/SecretRef credentials and reports the winning source. */
  resolveSecretInput: (
    params: RuntimeWebResolveSecretInputParams,
  ) => Promise<SecretResolutionResult<TSource>>;
  /** Writes the selected credential into the resolved runtime config snapshot. */
  setResolvedCredential: (params: {
    resolvedConfig: OpenClawConfig;
    provider: TProvider;
    value: string;
  }) => void;
  inactivePathsForProvider: (provider: TProvider) => string[];
  hasConfiguredSecretRef: (value: unknown, defaults: SecretDefaults | undefined) => boolean;
  mergeRuntimeMetadata?: (params: {
    provider: TProvider;
    metadata: TMetadata;
    toolConfig: TToolConfig;
    selectedResolution?: SecretResolutionResult<TSource>;
  }) => Promise<void>;
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
