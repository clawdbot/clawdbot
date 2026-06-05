/**
 * Shared auth profile data contracts.
 * These types describe credential payloads, runtime selection state, and repair
 * results consumed by providers, sessions, doctor, and plugin-facing seams.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SecretRef } from "../../config/types.secrets.js";
import type { LegacyOAuthRef } from "./legacy-oauth-ref.js";

/** Provider identifier recorded on auth profile credentials. */
export type OAuthProvider = string;

/** Refreshable OAuth credential fields persisted for provider auth profiles. */
export type OAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  provider?: OAuthProvider;
  email?: string;
  enterpriseUrl?: string;
  projectId?: string;
  accountId?: string;
  chatgptPlanType?: string;
  idToken?: string;
};

/** API-key credential with optional secret reference indirection. */
export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
  /** Explicit opt-out for copying this profile when creating another agent. */
  copyToAgents?: boolean;
  email?: string;
  displayName?: string;
  /** Optional provider-specific metadata (e.g., account IDs, gateway IDs). */
  metadata?: Record<string, string>;
};

/** Static token credential that OpenClaw does not refresh. */
export type TokenCredential = {
  /**
   * Static bearer-style token (often OAuth access token / PAT).
   * Not refreshable by OpenClaw (unlike `type: "oauth"`).
   */
  type: "token";
  provider: string;
  token?: string;
  tokenRef?: SecretRef;
  /** Explicit opt-out for copying this profile when creating another agent. */
  copyToAgents?: boolean;
  /** Optional expiry timestamp (ms since epoch). */
  expires?: number;
  email?: string;
  displayName?: string;
};

/** Refreshable OAuth credential plus provider metadata and legacy references. */
export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  oauthRef?: LegacyOAuthRef;
  clientId?: string;
  /**
   * OAuth refresh tokens are not portable by default. Provider-owned flows may
   * set this only when copying refresh material across agents is known safe.
   */
  copyToAgents?: boolean;
  email?: string;
  displayName?: string;
};

/** Credential variants supported by auth profiles. */
export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

/** Closed reasons that drive cooldown, disable, and failure counters. */
export type AuthProfileFailureReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "overloaded"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "empty_response"
  | "no_error_details"
  | "unclassified"
  | "unknown";

/** Profile-wide blocked reason reported by provider usage probes. */
export type AuthProfileBlockedReason = "subscription_limit";
/** Source that marked a profile as blocked. */
export type AuthProfileBlockedSource = "codex_rate_limits" | "wham";

/** Per-profile usage statistics for round-robin and cooldown tracking */
export type ProfileUsageStats = {
  lastUsed?: number;
  blockedUntil?: number;
  blockedReason?: AuthProfileBlockedReason;
  blockedSource?: AuthProfileBlockedSource;
  blockedModel?: string;
  cooldownUntil?: number;
  cooldownReason?: AuthProfileFailureReason;
  cooldownModel?: string;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
};

/** Durable, non-secret auth profile selection state. */
export type AuthProfileState = {
  /**
   * Optional per-agent preferred profile order overrides.
   * This lets you lock/override auth rotation for a specific agent without
   * changing the global config.
   */
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  /** Usage statistics per profile for round-robin rotation */
  usageStats?: Record<string, ProfileUsageStats>;
};

/** Persisted credential payload without runtime-only selection state. */
export type AuthProfileSecretsStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
};

/** Persisted runtime-state payload with a schema version. */
export type AuthProfileStateStore = {
  version: number;
} & AuthProfileState;

/** Effective in-memory auth store combining credentials, state, and overlays. */
export type AuthProfileStore = AuthProfileSecretsStore &
  AuthProfileState & {
    /** Runtime-only provenance for external OAuth profiles overlaid onto this store. */
    runtimeExternalProfileIds?: string[];
    /** True when the runtime external profile set was freshly resolved, even if empty. */
    runtimeExternalProfileIdsAuthoritative?: boolean;
  };

/** Result returned by config/store auth profile id repair. */
export type AuthProfileIdRepairResult = {
  config: OpenClawConfig;
  changes: string[];
  migrated: boolean;
  fromProfileId?: string;
  toProfileId?: string;
};
