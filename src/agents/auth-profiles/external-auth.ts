import type { ProviderExternalAuthProfile } from "../../plugins/provider-external-auth.types.js";
import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import * as externalCliSync from "./external-cli-sync.js";
import {
  overlayRuntimeExternalOAuthProfiles,
  shouldPersistRuntimeExternalOAuthProfile,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalAuthProfileMap = Map<string, ProviderExternalAuthProfile>;
type ResolveExternalAuthProfiles = typeof resolveExternalAuthProfilesWithPlugins;
type ExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

let resolveExternalAuthProfilesForRuntime: ResolveExternalAuthProfiles | undefined;

export const __testing = {
  resetResolveExternalAuthProfilesForTest(): void {
    resolveExternalAuthProfilesForRuntime = undefined;
  },
  setResolveExternalAuthProfilesForTest(resolver: ResolveExternalAuthProfiles): void {
    resolveExternalAuthProfilesForRuntime = resolver;
  },
};

function normalizeExternalAuthProfile(
  profile: ProviderExternalAuthProfile,
): ProviderExternalAuthProfile | null {
  if (!profile?.profileId || !profile.credential) {
    return null;
  }
  return {
    ...profile,
    persistence: profile.persistence ?? "runtime-only",
  };
}

function resolveExternalAuthProfileMap(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliOverlayOptions;
}): ExternalAuthProfileMap {
  const env = params.env ?? process.env;
  const resolveProfiles =
    resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
  const profiles = resolveProfiles({
    env,
    context: {
      config: undefined,
      agentDir: params.agentDir,
      workspaceDir: undefined,
      env,
      store: params.store,
    },
  });

  const resolved: ExternalAuthProfileMap = new Map();
  const cliProfiles =
    externalCliSync.resolveExternalCliAuthProfiles?.(params.store, {
      allowKeychainPrompt: params.externalCli?.allowKeychainPrompt,
      providerIds: params.externalCli?.externalCliProviderIds,
      profileIds: params.externalCli?.externalCliProfileIds,
    }) ?? [];
  for (const profile of cliProfiles) {
    resolved.set(profile.profileId, {
      profileId: profile.profileId,
      credential: profile.credential,
      persistence: "runtime-only",
    });
  }
  for (const rawProfile of profiles) {
    const profile = normalizeExternalAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    resolved.set(profile.profileId, profile);
  }
  return resolved;
}

function listRuntimeExternalAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliOverlayOptions;
}): RuntimeExternalOAuthProfile[] {
  return Array.from(
    resolveExternalAuthProfileMap({
      store: params.store,
      agentDir: params.agentDir,
      env: params.env,
      externalCli: params.externalCli,
    }).values(),
  );
}

export function overlayExternalAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
): AuthProfileStore {
  const profiles = listRuntimeExternalAuthProfiles({
    store,
    agentDir: params?.agentDir,
    env: params?.env,
    externalCli: params,
  });
  return overlayRuntimeExternalOAuthProfiles(store, profiles);
}

export function shouldPersistExternalAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
}): boolean {
  const profiles = listRuntimeExternalAuthProfiles({
    store: params.store,
    agentDir: params.agentDir,
    env: params.env,
    externalCli: {
      externalCliProviderIds: params.externalCliProviderIds,
      externalCliProfileIds: params.externalCliProfileIds,
    },
  });
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles,
  });
}

// Compat aliases while file/function naming catches up.
export const overlayExternalOAuthProfiles = overlayExternalAuthProfiles;
export const shouldPersistExternalOAuthProfile = shouldPersistExternalAuthProfile;
