/**
 * Runtime external auth profile overlays.
 * Combines provider plugin auth profiles with scoped external CLI credentials
 * and decides which runtime profiles may be persisted back to the store.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-external-auth.js";
import type { ProviderExternalAuthProfile } from "../../plugins/provider-external-auth.types.js";
import { isAmbientCredentialAllowedByProviderAuthPin } from "./ambient-auth.js";
import { cloneAuthProfileStore } from "./clone.js";
import { MINIMAX_CLI_PROFILE_ID } from "./constants.js";
import * as externalCliSync from "./external-cli-sync.js";
import {
  areOAuthCredentialsEquivalent,
  overlayRuntimeExternalOAuthProfiles,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import {
  getRuntimeExternalCliProfileIds,
  removeRuntimeExternalProfileReferences,
  setRuntimeExternalCliProfileIds,
} from "./runtime-external-profile-references.js";
import type { AuthProfileStore } from "./types.js";

type ExternalAuthProfileMap = Map<string, ProviderExternalAuthProfile>;
type ResolveExternalAuthProfiles = typeof resolveExternalAuthProfilesWithPlugins;
type ExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

let resolveExternalAuthProfilesForRuntime: ResolveExternalAuthProfiles | undefined;

/** Test-only resolver injection for provider external auth profiles. */
const testing = {
  resetResolveExternalAuthProfilesForTest(): void {
    resolveExternalAuthProfilesForRuntime = undefined;
  },
  setResolveExternalAuthProfilesForTest(resolver: ResolveExternalAuthProfiles): void {
    resolveExternalAuthProfilesForRuntime = resolver;
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.externalAuthTestApi")] =
    testing;
}

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

function resolveExplicitProfileIds(values: Iterable<string> | undefined): Set<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  return new Set(Array.from(values, (value) => value.trim()).filter((value) => value.length > 0));
}

function isExternalAuthProfileAllowed(
  profile: ProviderExternalAuthProfile,
  store: AuthProfileStore,
  config: OpenClawConfig | undefined,
  explicitProfileIds: ReadonlySet<string> | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  // A provider pin protects its declared auth from ambient takeover. Stored and explicitly
  // bound profiles deliberately keep precedence; see runtime-plan/prepare-auth.test.ts.
  if (store.profiles[profile.profileId] || explicitProfileIds?.has(profile.profileId)) {
    return true;
  }
  return isAmbientCredentialAllowedByProviderAuthPin({
    config,
    authAliasLookupParams: { env },
    provider: profile.credential.provider,
    type: profile.credential.type,
  });
}

function resolveExternalAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliOverlayOptions;
}): {
  profiles: ExternalAuthProfileMap;
  pluginProfileIds: ReadonlySet<string>;
  runtimeExternalCliProfileIds: ReadonlySet<string>;
} {
  const env = params.env ?? process.env;
  const resolveProfiles =
    resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
  const profiles = resolveProfiles({
    env,
    config: params.externalCli?.config,
    context: {
      config: params.externalCli?.config,
      agentDir: params.agentDir,
      workspaceDir: undefined,
      env,
      store: params.store,
    },
  });
  const externalCli = params.externalCli;
  const resolved = resolveExternalCliAuthProfileMap({ ...params, externalCli });
  const runtimeExternalCliProfileIds = new Set(
    [...resolved.values()]
      .filter((profile) => profile.persistence !== "persisted")
      .map((profile) => profile.profileId),
  );
  const pluginProfileIds = new Set<string>();
  const explicitProfileIds = resolveExplicitProfileIds(params.externalCli?.externalCliProfileIds);
  for (const rawProfile of profiles) {
    const profile = normalizeExternalAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    if (
      !isExternalAuthProfileAllowed(
        profile,
        params.store,
        params.externalCli?.config,
        explicitProfileIds,
        env,
      )
    ) {
      continue;
    }
    resolved.set(profile.profileId, profile);
    pluginProfileIds.add(profile.profileId);
    runtimeExternalCliProfileIds.delete(profile.profileId);
  }
  return { profiles: resolved, pluginProfileIds, runtimeExternalCliProfileIds };
}

function resolveAllowedExternalCliAuthProfiles(params: {
  store: AuthProfileStore;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliOverlayOptions;
}): ProviderExternalAuthProfile[] {
  const env = params.env ?? process.env;
  const explicitProfileIds = resolveExplicitProfileIds(params.externalCli?.externalCliProfileIds);
  const cliProfiles =
    externalCliSync.resolveExternalCliAuthProfiles?.(params.store, {
      allowKeychainPrompt: params.externalCli?.allowKeychainPrompt,
      providerIds: params.externalCli?.externalCliProviderIds,
      profileIds: explicitProfileIds,
    }) ?? [];
  return cliProfiles.flatMap((profile) =>
    isExternalAuthProfileAllowed(
      profile,
      params.store,
      params.externalCli?.config,
      explicitProfileIds,
      env,
    )
      ? [
          {
            profileId: profile.profileId,
            credential: profile.credential,
            persistence: profile.persistence ?? "runtime-only",
          },
        ]
      : [],
  );
}

function resolveExternalCliAuthProfileMap(params: {
  store: AuthProfileStore;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliOverlayOptions;
}): ExternalAuthProfileMap {
  return new Map(
    resolveAllowedExternalCliAuthProfiles(params).map((profile) => [profile.profileId, profile]),
  );
}

/** List runtime-only and persisted external auth profiles for this store. */
export function listRuntimeExternalAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  externalCli?: ExternalCliOverlayOptions;
}): RuntimeExternalOAuthProfile[] {
  return Array.from(
    resolveExternalAuthProfiles({
      store: params.store,
      agentDir: params.agentDir,
      env: params.env,
      externalCli: params.externalCli,
    }).profiles.values(),
  );
}

function hasPersistableExternalCliSyncCandidate(
  store: AuthProfileStore,
  params?: ExternalCliOverlayOptions,
): boolean {
  if (params?.externalCliProviderIds || params?.externalCliProfileIds) {
    return true;
  }
  // MiniMax keeps its persisted external profile fresh without an explicit scope.
  for (const profileId of [MINIMAX_CLI_PROFILE_ID]) {
    const credential = store.profiles[profileId];
    if (credential?.type === "oauth") {
      return true;
    }
  }
  return false;
}

function hasScopedExternalCliOverlay(params?: ExternalCliOverlayOptions): boolean {
  return Boolean(params?.externalCliProviderIds || params?.externalCliProfileIds);
}

/** Overlay external auth profiles onto a cloned auth store for runtime use. */
export function overlayExternalAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
): AuthProfileStore {
  const scoped = hasScopedExternalCliOverlay(params);
  const runtimeExternalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
  // Provider hooks are authoritative on every combined refresh. Remove their previous
  // generation-owned rows before reevaluating them, while limiting CLI removal to its scope.
  const refreshedProfileIds = new Set(
    (store.runtimeExternalProfileIds ?? []).filter(
      (profileId) => !runtimeExternalCliProfileIds.has(profileId),
    ),
  );
  for (const profileId of runtimeExternalCliProfileIds) {
    if (
      scoped &&
      externalCliSync.isExternalCliAuthProfileInScope({
        store,
        profileId,
        providerIds: params?.externalCliProviderIds,
        profileIds: params?.externalCliProfileIds,
      })
    ) {
      refreshedProfileIds.add(profileId);
    }
  }
  const base = removeRuntimeExternalProfileReferences({ store, profileIds: refreshedProfileIds });
  const resolved = resolveExternalAuthProfiles({
    store: base,
    agentDir: params?.agentDir,
    env: params?.env,
    externalCli: params,
  });
  const next = overlayRuntimeExternalOAuthProfiles(base, resolved.profiles.values(), {
    runtimeExternalProfileIdsAuthoritative: !scoped,
  });
  const retainedCliProfileIds = getRuntimeExternalCliProfileIds(base).filter(
    (profileId) => !resolved.pluginProfileIds.has(profileId),
  );
  setRuntimeExternalCliProfileIds(next, [
    ...retainedCliProfileIds,
    ...resolved.runtimeExternalCliProfileIds,
  ]);
  return next;
}

/** Persist safe external CLI OAuth profiles that own their local profile slot. */
export function syncPersistedExternalCliAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv } & ExternalCliOverlayOptions,
): AuthProfileStore {
  if (!hasPersistableExternalCliSyncCandidate(store, params)) {
    return store;
  }
  const persistedProfiles = resolveAllowedExternalCliAuthProfiles({
    store,
    env: params?.env,
    externalCli: params,
  }).filter((profile) => profile.persistence === "persisted");
  if (persistedProfiles.length === 0) {
    return store;
  }

  let next: AuthProfileStore | undefined;
  for (const profile of persistedProfiles) {
    const target = next ?? store;
    const existing = target.profiles[profile.profileId];
    if (existing?.type === "oauth" && areOAuthCredentialsEquivalent(existing, profile.credential)) {
      continue;
    }
    next ??= cloneAuthProfileStore(store);
    next.profiles[profile.profileId] = profile.credential;
  }
  return next ?? store;
}
