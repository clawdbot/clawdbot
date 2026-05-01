import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveExternalCliAuthScopeFromConfig,
  type ExternalCliAuthScope,
} from "./external-cli-scope.js";

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
  return [...values]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

export function externalCliDiscoveryNone(params?: {
  config?: OpenClawConfig;
}): ExternalCliAuthDiscovery {
  return {
    mode: "none",
    allowKeychainPrompt: false,
    ...(params?.config ? { config: params.config } : {}),
  };
}

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
