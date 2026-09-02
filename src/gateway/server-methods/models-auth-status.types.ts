import type {
  AuthProfileHealthStatus,
  AuthProviderHealthStatus,
} from "../../agents/auth-health.js";
import type { AuthCredentialReasonCode } from "../../agents/auth-profiles/credential-state.js";
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
  expiry?: ModelAuthExpiry;
  /** True only for saved OAuth/token profiles this gateway can remove. */
  logoutSupported?: boolean;
};

export type ModelAuthStatusProvider = {
  provider: string;
  displayName: string;
  status: AuthProviderHealthStatus;
  expiry?: ModelAuthExpiry;
  profiles: ModelAuthStatusProfile[];
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
