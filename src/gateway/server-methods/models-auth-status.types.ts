import type {
  AuthProfileHealthStatus,
  AuthProviderHealthStatus,
} from "../../agents/auth-health.js";
import type { AuthCredentialReasonCode } from "../../agents/auth-profiles/credential-state.js";
import type { SecretRefSource } from "../../config/types.secrets.js";
import type {
  ProviderUsageBilling,
  UsageProviderId,
  UsageWindow,
} from "../../infra/provider-usage.types.js";

/** Time-bounded credential expiry projected to gateway clients. */
export type ModelAuthExpiry = {
  at: number;
  remainingMs: number;
  label: string;
};

export type ModelAuthStatusProfile = {
  profileId: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: AuthCredentialReasonCode;
  /** Non-secret reference identity for an unresolved credential. */
  secretRef?: { source: SecretRefSource; id: string };
  expiry?: ModelAuthExpiry;
  /** True only for saved profiles this gateway can remove. */
  logoutSupported?: boolean;
  /** Credential refresh is owned by an external CLI rather than OpenClaw. */
  externallyManaged?: boolean;
  /** Where the effective credential came from. */
  source?: "config" | "external" | "inherited" | "saved";
  displayName?: string;
  email?: string;
  lastUsedAt?: number;
};

export type ModelAuthStatusProvider = {
  provider: string;
  /** Canonical credential owner used for profile ordering mutations. */
  authProvider?: string;
  displayName: string;
  status: AuthProviderHealthStatus;
  expiry?: ModelAuthExpiry;
  profiles: ModelAuthStatusProfile[];
  /** Native runtime that owns prepared authentication without creating an auth profile. */
  agentRuntime?: { id: string; source: "auth" };
  /** Explicit stored/config priority. Omitted when selection is automatic. */
  profileOrder?: string[];
  /** True when the priority is a stored override that can be reset. */
  profileOrderStored?: boolean;
  /** Present when configuration, rather than the auth store, owns priority. */
  profileOrderLocked?: "auth-config" | "provider-config";
  apiKey?: {
    source: "config" | "env";
    envVar?: string;
  };
  usage?: {
    /** Normalized provider id the usage payload was fetched under. */
    providerId: UsageProviderId;
    windows: UsageWindow[];
    summary?: string;
    plan?: string;
    billing?: ProviderUsageBilling[];
    accountEmail?: string;
  };
};

export type ModelProviderCapability = {
  provider: string;
  apiKeySupported: boolean;
  quickApiKeySetup: boolean;
  accessOptions?: Array<{
    id: string;
    label: string;
    mode: "login" | "setup";
  }>;
};

export type ModelAuthStatusResult = {
  /** Snapshot build time, ms since epoch. 0 = never loaded (UI fallback sentinel). */
  ts: number;
  providers: ModelAuthStatusProvider[];
  /** Missing preparation is unknown auth health, not a failed Gateway connection. */
  unavailable?: {
    code: "PREPARED_MODEL_AUTH_UNAVAILABLE";
    message: string;
  };
  /** Process-stable provider setup capabilities from the active plugin generation. */
  providerCapabilities?: ModelProviderCapability[];
};

export type ModelAuthLogoutResult = {
  provider: string;
  removedProfiles: string[];
  abortedRunIds: string[];
};

export type ModelAuthOrderSetResult = {
  provider: string;
  profileIds: string[] | null;
};
