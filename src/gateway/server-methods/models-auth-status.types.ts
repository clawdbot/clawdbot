import type {
  AuthProfileHealthStatus,
  AuthProviderHealthStatus,
} from "../../agents/auth-health.js";
import type { AuthCredentialReasonCode } from "../../agents/auth-profiles/credential-state.js";
import type {
  ProviderUsageBilling,
  ProviderUsageCostHistory,
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../../infra/provider-usage.types.js";

/** Time-bounded credential expiry projected to gateway clients. */
export type ModelAuthExpiry = {
  at: number;
  remainingMs: number;
  label: string;
};

export type ModelAuthUsage = {
  providerId: UsageProviderId;
  refreshedAt?: number;
  windows: UsageWindow[];
  /** Endpoint-declared scope; credential binding alone does not establish it. */
  usageScope?: ProviderUsageSnapshot["usageScope"];
  summary?: string;
  plan?: string;
  billing?: ProviderUsageBilling[];
  costHistory?: ProviderUsageCostHistory;
  accountEmail?: string;
  error?: string;
};

export type ModelAuthStatusProfile = {
  profileId: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: AuthCredentialReasonCode;
  expiry?: ModelAuthExpiry;
  /** True only for saved OAuth/token profiles this gateway can remove. */
  logoutSupported?: boolean;
  /** Credential refresh is owned by an external CLI rather than OpenClaw. */
  externallyManaged?: boolean;
  /** Where the effective credential came from. */
  source?: "config" | "external" | "inherited" | "saved";
  displayName?: string;
  email?: string;
  lastUsedAt?: number;
  /** Provider quota and billing facts returned for this exact credential. */
  usage?: ModelAuthUsage;
  /** This account's usage cache is refreshing in the background. */
  usageRefreshPending?: true;
};

export type ModelAuthStatusProvider = {
  provider: string;
  /** Canonical credential owner used for profile ordering mutations. */
  authProvider?: string;
  displayName: string;
  status: AuthProviderHealthStatus;
  expiry?: ModelAuthExpiry;
  profiles: ModelAuthStatusProfile[];
  /** Explicit stored/config priority. Omitted when selection is automatic. */
  profileOrder?: string[];
  /** True when the selected agent owns a stored priority override that can be reset. */
  profileOrderStored?: boolean;
  /** Present when configuration, rather than the auth store, owns priority. */
  profileOrderLocked?: "auth-config" | "provider-config";
  apiKey?: {
    source: "config" | "env";
    envVar?: string;
  };
  usage?: ModelAuthUsage;
  /** Exact saved account that produced usage; absent for independent provider reads. */
  usageProfileId?: string;
  /** Separately fetched usage retained alongside the selected account summary. */
  independentUsage?: ModelAuthUsage;
  /** Endpoint-declared scope of usage; absent means unknown. */
  usageScope?: ProviderUsageSnapshot["usageScope"];
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
  /** Account or independent provider usage is still refreshing its cache. */
  usageRefreshPending?: boolean;
};

export type ModelAuthLogoutResult = {
  provider: string;
  removedProfiles: string[];
  abortedRunIds: string[];
};

export type ModelAuthOrderSetResult = {
  provider: string;
  profileIds: string[] | null;
  /** The order was saved, but its runtime publication could not complete. */
  warning?: string;
};
