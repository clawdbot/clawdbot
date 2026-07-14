// Defines external auth contracts for provider plugins.
import type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";
import type { ModelProviderAuthMode, ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInputMode } from "./provider-auth-types.js";

export type ProviderAuthOptionBag = {
  token?: string;
  tokenProvider?: string;
  secretInputMode?: SecretInputMode;
  [key: string]: unknown;
};

/** Context for resolving synthetic provider credentials from config. */
export type ProviderResolveSyntheticAuthContext = {
  config?: OpenClawConfig;
  provider: string;
  providerConfig?: ModelProviderConfig;
};

/** Synthetic provider credential returned by plugin auth helpers. */
export type ProviderSyntheticAuthResult = {
  apiKey: string;
  source: string;
  mode: Exclude<ModelProviderAuthMode, "aws-sdk">;
  expiresAt?: number;
};

/** Context for resolving external provider auth profiles. */
export type ProviderResolveExternalAuthProfilesContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  store: AuthProfileStore;
};

/** OAuth-specific external auth profile resolution context. */
export type ProviderResolveExternalOAuthProfilesContext =
  ProviderResolveExternalAuthProfilesContext;

/** External auth profile credential resolved for a provider. */
export type ProviderExternalAuthProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

/** OAuth-specific provider external auth profile alias. */
export type ProviderExternalOAuthProfile = ProviderExternalAuthProfile;
