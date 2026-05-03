import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { hasRuntimeAvailableProviderAuth } from "./model-auth.js";
import { normalizeProviderId } from "./model-selection.js";

export function hasAuthForModelProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (
    hasRuntimeAvailableProviderAuth({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
    })
  ) {
    return true;
  }
  const store =
    params.store ??
    (params.discoverExternalCliAuth === false
      ? ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
          allowKeychainPrompt: false,
        })
      : ensureAuthProfileStore(params.agentDir, {
          externalCli: externalCliDiscoveryForProviderAuth({ cfg: params.cfg, provider }),
        }));
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  return false;
}

export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): (provider: string) => boolean {
  const authCache = new Map<string, boolean>();
  return (provider: string) => {
    const key = normalizeProviderId(provider);
    const cached = authCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = hasAuthForModelProvider({
      provider: key,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      discoverExternalCliAuth: params.discoverExternalCliAuth,
    });
    authCache.set(key, value);
    return value;
  };
}
