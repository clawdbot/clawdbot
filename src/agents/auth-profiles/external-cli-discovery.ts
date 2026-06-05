/**
 * External CLI auth discovery mode helpers.
 * Converts provider/config lookup contexts into scoped discovery options for
 * auth profile store loading.
 */
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveExternalCliAuthScopeFromConfig,
  type ExternalCliAuthScope,
} from "./external-cli-scope.js";

/** External CLI auth discovery mode used while loading auth profile stores. */
export type ExternalCliAuthDiscovery =
  | {
      mode: "none";
      allowKeychainPrompt?: false;
      config?: OpenClawConfig;
    }
  | {
      mode: "existing";
      allowKeychainPrompt?: boolean;
      config?: OpenClawConfig;
    }
  | {
      mode: "scoped";
      allowKeychainPrompt?: boolean;
      config?: OpenClawConfig;
      providerIds?: Iterable<string>;
      profileIds?: Iterable<string>;
    };

type ProviderAuthDiscoveryParams = {
  cfg?: OpenClawConfig;
  provider: string;
  profileId?: string;
  preferredProfile?: string;
  allowKeychainPrompt?: boolean;
};

type ConfigStatusDiscoveryParams = {
  cfg: OpenClawConfig;
  allowKeychainPrompt?: false;
};

type ProviderSetDiscoveryParams = {
  cfg?: OpenClawConfig;
  providers: Iterable<string>;
  allowKeychainPrompt?: false;
};

function normalizeStringList(values: Iterable<string | undefined>): string[] {
  return normalizeTrimmedStringList([...values]);
}

/** Disables external CLI auth discovery. */
export function externalCliDiscoveryNone(params?: {
  config?: OpenClawConfig;
}): ExternalCliAuthDiscovery {
  return {
    mode: "none",
    allowKeychainPrompt: false,
    ...(params?.config ? { config: params.config } : {}),
  };
}

/** Allows discovery of already-existing external CLI auth profiles. */
export function externalCliDiscoveryExisting(params?: {
  config?: OpenClawConfig;
  allowKeychainPrompt?: boolean;
}): ExternalCliAuthDiscovery {
  return {
    mode: "existing",
    ...(params?.allowKeychainPrompt !== undefined
      ? { allowKeychainPrompt: params.allowKeychainPrompt }
      : {}),
    ...(params?.config ? { config: params.config } : {}),
  };
}

/** Allows external CLI auth discovery for specific providers and/or profiles. */
export function externalCliDiscoveryScoped(params: {
  config?: OpenClawConfig;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
  allowKeychainPrompt?: boolean;
}): ExternalCliAuthDiscovery {
  return {
    mode: "scoped",
    ...(params.allowKeychainPrompt !== undefined
      ? { allowKeychainPrompt: params.allowKeychainPrompt }
      : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.providerIds ? { providerIds: params.providerIds } : {}),
    ...(params.profileIds ? { profileIds: params.profileIds } : {}),
  };
}

/** Builds external CLI discovery options for a provider auth lookup. */
export function externalCliDiscoveryForProviderAuth(
  params: ProviderAuthDiscoveryParams,
): ExternalCliAuthDiscovery {
  const profileIds = normalizeStringList([params.profileId, params.preferredProfile]);
  return externalCliDiscoveryScoped({
    config: params.cfg,
    allowKeychainPrompt: params.allowKeychainPrompt ?? false,
    providerIds: [params.provider],
    ...(profileIds.length > 0 ? { profileIds } : {}),
  });
}

/** Builds external CLI discovery options for config status checks. */
export function externalCliDiscoveryForConfigStatus(
  params: ConfigStatusDiscoveryParams,
): ExternalCliAuthDiscovery {
  const scope = resolveExternalCliAuthScopeFromConfig(params.cfg);
  return externalCliDiscoveryFromScope({
    cfg: params.cfg,
    scope,
    allowKeychainPrompt: params.allowKeychainPrompt ?? false,
  });
}

/** Builds external CLI discovery options for a provider set. */
export function externalCliDiscoveryForProviders(
  params: ProviderSetDiscoveryParams,
): ExternalCliAuthDiscovery {
  const providers = normalizeStringList(params.providers);
  if (providers.length === 0) {
    return externalCliDiscoveryNone({ config: params.cfg });
  }
  return externalCliDiscoveryScoped({
    config: params.cfg,
    allowKeychainPrompt: params.allowKeychainPrompt ?? false,
    providerIds: providers,
  });
}

function externalCliDiscoveryFromScope(params: {
  cfg: OpenClawConfig;
  scope: ExternalCliAuthScope | undefined;
  allowKeychainPrompt: false;
}): ExternalCliAuthDiscovery {
  if (!params.scope) {
    return externalCliDiscoveryNone({ config: params.cfg });
  }
  return externalCliDiscoveryScoped({
    config: params.cfg,
    allowKeychainPrompt: params.allowKeychainPrompt,
    providerIds: params.scope.providerIds,
    profileIds: params.scope.profileIds,
  });
}
