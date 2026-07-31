/** Config document that owns a registered secret-bearing target. */
export type SecretTargetConfigFile = "openclaw.json" | "auth-profiles.json"; // pragma: allowlist secret
/** Storage shape used by a target: inline SecretInput or a sibling `*Ref` field. */
export type SecretTargetShape = "secret_input" | "sibling_ref"; // pragma: allowlist secret
/** Resolved value shape accepted by runtime and apply validation. */
export type SecretTargetExpected = "string" | "string-or-object"; // pragma: allowlist secret
/** Auth profile families that have separate secret target coverage. */
type AuthProfileType = "api_key" | "token";

/**
 * Registry metadata for one configurable secret-bearing value.
 */
export type SecretTargetRegistryEntry = {
  /** Stable id used by plans, audits, docs, and targeted discovery filters. */
  id: string;
  /** Plan/configure target family; aliases keep CLI-facing names additive. */
  targetType: string;
  targetTypeAliases?: string[];
  /** Config document where the value is discovered or rewritten. */
  configFile: SecretTargetConfigFile;
  /** Dot-path pattern for the secret-bearing value; `*` captures path segments. */
  pathPattern: string;
  /** Optional sibling SecretRef path materialized from the same captures as `pathPattern`. */
  refPathPattern?: string;
  /** Whether the registered value stores a SecretInput directly or via a sibling ref field. */
  secretShape: SecretTargetShape;
  /** Runtime value shape accepted after SecretRef resolution. */
  expectedResolvedValue: SecretTargetExpected;
  /** Enables `openclaw secrets apply` targeting for this entry. */
  includeInPlan: boolean;
  /** Enables interactive/non-interactive configure candidate generation. */
  includeInConfigure: boolean;
  /** Enables plaintext/unresolved-ref audit scanning. */
  includeInAudit: boolean;
  /** Captured path segment that names the owning provider, when applicable. */
  providerIdPathSegmentIndex?: number;
  /** Captured path segment that names the owning account/profile, when applicable. */
  accountIdPathSegmentIndex?: number;
  /** Auth-profile family for auth-profiles.json entries. */
  authProfileType?: AuthProfileType;
  /** Enables provider-shadowing diagnostics for provider-auth surfaces with fallback order. */
  trackProviderShadowing?: boolean;
};

/**
 * Concrete plan/config target after registry pattern matching and capture resolution.
 */
export type ResolvedPlanTarget = {
  entry: SecretTargetRegistryEntry;
  /** Concrete path to the secret-bearing value in the owning config document. */
  pathSegments: string[];
  /** Concrete sibling SecretRef path when `entry.secretShape` is `sibling_ref`. */
  refPathSegments?: string[];
  /** Provider id captured from `pathSegments`, if the registry entry declares one. */
  providerId?: string;
  /** Account/profile id captured from `pathSegments`, if the registry entry declares one. */
  accountId?: string;
};

/**
 * A configured secret target discovered during audit/config scanning.
 */
export type DiscoveredConfigSecretTarget = {
  entry: SecretTargetRegistryEntry;
  /** Dot path for display, audit output, and CLI targeting. */
  path: string;
  pathSegments: string[];
  /** Dot path to the sibling SecretRef field when the entry uses one. */
  refPath?: string;
  refPathSegments?: string[];
  /** Current value at `pathSegments`; may be plaintext, SecretInput, object, or unset. */
  value: unknown;
  /** Current value at `refPathSegments`, present only for sibling-ref entries. */
  refValue?: unknown;
  providerId?: string;
  accountId?: string;
};
