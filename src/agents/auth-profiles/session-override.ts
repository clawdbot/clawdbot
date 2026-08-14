/**
 * Session-level auth profile override rotation.
 * Keeps automatic profile choice stable within a session while still rotating
 * across new sessions, compactions, provider changes, and cooldowns.
 */
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  isConfiguredAwsSdkAuthProfileForProvider,
  isStoredCredentialCompatibleWithAuthProvider,
  resolveAuthProfileOrder,
} from "../auth-profiles/order.js";
import { ensureAuthProfileStore, hasAnyAuthProfileStoreSource } from "../auth-profiles/store.js";
import {
  isActiveUnusableWindow,
  isModelScopedCooldownReason,
} from "../auth-profiles/usage-state.js";
import { isProfileInCooldown } from "../auth-profiles/usage.js";

const sessionAccessorLoader = createLazyImportLoader(
  () => import("../../config/sessions/session-accessor.js"),
);

// Session accessor writes are lazy-loaded so read-only auth resolution paths do
// not import persistence code unless an override must be updated.
function loadSessionAccessor() {
  return sessionAccessorLoader.load();
}

type SessionAuthProfileOverrideState = Pick<
  SessionEntry,
  "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
>;
type SessionAuthProfileOverrideSnapshot = SessionAuthProfileOverrideState &
  Pick<SessionEntry, "sessionId">;

function applySessionAuthProfileOverrideState(
  entry: SessionEntry,
  state: SessionAuthProfileOverrideState,
  updatedAt: number,
): void {
  if (state.authProfileOverride === undefined) {
    delete entry.authProfileOverride;
  } else {
    entry.authProfileOverride = state.authProfileOverride;
  }
  if (state.authProfileOverrideSource === undefined) {
    delete entry.authProfileOverrideSource;
  } else {
    entry.authProfileOverrideSource = state.authProfileOverrideSource;
  }
  if (state.authProfileOverrideCompactionCount === undefined) {
    delete entry.authProfileOverrideCompactionCount;
  } else {
    entry.authProfileOverrideCompactionCount = state.authProfileOverrideCompactionCount;
  }
  entry.updatedAt = Math.max(entry.updatedAt ?? 0, updatedAt);
}

function matchesSessionAuthProfileOverrideSnapshot(
  entry: SessionEntry,
  snapshot: SessionAuthProfileOverrideSnapshot,
): boolean {
  return (
    entry.sessionId === snapshot.sessionId &&
    entry.authProfileOverride === snapshot.authProfileOverride &&
    entry.authProfileOverrideSource === snapshot.authProfileOverrideSource &&
    entry.authProfileOverrideCompactionCount === snapshot.authProfileOverrideCompactionCount
  );
}

function synchronizeSessionEntry(entry: SessionEntry, latest: SessionEntry): void {
  for (const key of Object.keys(entry)) {
    if (!Object.hasOwn(latest, key)) {
      Reflect.deleteProperty(entry, key);
    }
  }
  Object.assign(entry, latest);
}

async function persistSessionAuthProfileOverrideState(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  state: SessionAuthProfileOverrideState;
  storePath?: string;
  expectedSnapshot?: SessionAuthProfileOverrideSnapshot;
}): Promise<SessionEntry | undefined> {
  const { sessionEntry, sessionStore, sessionKey, state, storePath, expectedSnapshot } = params;
  const updatedAt = Date.now();
  if (!storePath) {
    if (expectedSnapshot && !Object.hasOwn(sessionStore, sessionKey)) {
      return undefined;
    }
    const latest = sessionStore[sessionKey] ?? sessionEntry;
    if (expectedSnapshot && !matchesSessionAuthProfileOverrideSnapshot(latest, expectedSnapshot)) {
      synchronizeSessionEntry(sessionEntry, latest);
      return latest;
    }
    const target = expectedSnapshot ? latest : sessionEntry;
    applySessionAuthProfileOverrideState(target, state, updatedAt);
    if (target !== sessionEntry) {
      synchronizeSessionEntry(sessionEntry, target);
    }
    sessionStore[sessionKey] = target;
    return target;
  }
  if (!expectedSnapshot) {
    applySessionAuthProfileOverrideState(sessionEntry, state, updatedAt);
    sessionStore[sessionKey] = sessionEntry;
  }
  const persisted = await (
    await loadSessionAccessor()
  ).patchSessionEntryCore(
    { storePath, sessionKey },
    (current) => {
      // Compare inside the canonical SQLite writer so a concurrent /model pin
      // cannot be erased by a stale automatic-selection snapshot.
      if (
        expectedSnapshot &&
        !matchesSessionAuthProfileOverrideSnapshot(current, expectedSnapshot)
      ) {
        return null;
      }
      return {
        ...state,
        updatedAt: Math.max(current.updatedAt ?? 0, updatedAt),
      };
    },
    expectedSnapshot ? undefined : { fallbackEntry: sessionEntry },
  );
  if (persisted) {
    if (expectedSnapshot) {
      synchronizeSessionEntry(sessionEntry, persisted);
    }
    sessionStore[sessionKey] = persisted;
  }
  return persisted ?? (expectedSnapshot ? undefined : sessionEntry);
}

// Current session overrides are only valid when the selected provider can use
// that profile, including configured aws-sdk profiles without stored secrets.
function isProfileForProvider(params: {
  cfg: OpenClawConfig;
  providers: readonly string[];
  profileId: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): boolean {
  const entry = params.store.profiles[params.profileId];
  if (entry) {
    if (!entry.provider) {
      return false;
    }
    return params.providers.some((provider) =>
      isStoredCredentialCompatibleWithAuthProvider({
        cfg: params.cfg,
        provider,
        credential: entry,
      }),
    );
  }
  return params.providers.some((provider) =>
    isConfiguredAwsSdkAuthProfileForProvider({
      cfg: params.cfg,
      provider,
      profileId: params.profileId,
    }),
  );
}

function uniqueProviders(provider: string, acceptedProviderIds?: readonly string[]): string[] {
  const providers = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized) {
      providers.add(normalized);
    }
  };
  const candidates =
    acceptedProviderIds && acceptedProviderIds.length > 0 ? acceptedProviderIds : [provider];
  candidates.forEach(push);
  return [...providers];
}

function isProfileGloballyInCooldown(
  store: ReturnType<typeof ensureAuthProfileStore>,
  profileId: string,
): boolean {
  if (!isProfileInCooldown(store, profileId)) {
    return false;
  }
  const usage = store.usageStats?.[profileId];
  if (!usage) {
    return true;
  }
  const now = Date.now();
  return (
    isActiveUnusableWindow(usage.disabledUntil, now) ||
    (isActiveUnusableWindow(usage.blockedUntil, now) &&
      (usage.blockedScope !== "model" || !usage.blockedModel)) ||
    (isActiveUnusableWindow(usage.cooldownUntil, now) &&
      (!isModelScopedCooldownReason(usage.cooldownReason) || !usage.cooldownModel))
  );
}

/** Clears an auth-profile override from a session and persists it when possible. */
export async function clearSessionAuthProfileOverride(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
}) {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  await persistSessionAuthProfileOverrideState({
    sessionEntry,
    sessionStore,
    sessionKey,
    state: {
      authProfileOverride: undefined,
      authProfileOverrideSource: undefined,
      authProfileOverrideCompactionCount: undefined,
    },
    storePath,
  });
}

/** Resolves and optionally rotates the session auth-profile override. */
export async function resolveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  provider: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
  acceptedProviderIds?: string[];
}): Promise<string | undefined> {
  const {
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return sessionEntry?.authProfileOverride;
  }

  const hasConfiguredAuthProfiles =
    Boolean(params.cfg.auth?.profiles && Object.keys(params.cfg.auth.profiles).length > 0) ||
    Boolean(params.cfg.auth?.order && Object.keys(params.cfg.auth.order).length > 0);
  if (
    !sessionEntry.authProfileOverride?.trim() &&
    !hasConfiguredAuthProfiles &&
    !hasAnyAuthProfileStoreSource(agentDir)
  ) {
    return undefined;
  }

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const providers = uniqueProviders(provider, params.acceptedProviderIds);
  const order = [
    ...new Set(
      providers.flatMap((candidateProvider) =>
        resolveAuthProfileOrder({ cfg, store, provider: candidateProvider }),
      ),
    ),
  ];
  let current = sessionEntry.authProfileOverride?.trim();
  const source = resolveSessionAuthProfileOverrideSource(sessionEntry);

  const currentProfileId = current;
  if (
    currentProfileId &&
    !store.profiles[currentProfileId] &&
    !providers.some((candidateProvider) =>
      isConfiguredAwsSdkAuthProfileForProvider({
        cfg,
        provider: candidateProvider,
        profileId: currentProfileId,
      }),
    )
  ) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (current && !isProfileForProvider({ cfg, providers, profileId: current, store })) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  // Explicit user pins are strict until the profile disappears or changes provider.
  if (source === "user" && current) {
    return current;
  }

  // Automatic pins must stay inside the currently configured rotation order.
  if (current && order.length > 0 && !order.includes(current)) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (order.length === 0) {
    return undefined;
  }

  if (order.every((profileId) => isProfileGloballyInCooldown(store, profileId))) {
    // An automatic pin must not trap later turns on an unavailable provider.
    if (current) {
      const latest = await persistSessionAuthProfileOverrideState({
        sessionEntry,
        sessionStore,
        sessionKey,
        state: {
          authProfileOverride: undefined,
          authProfileOverrideSource: undefined,
          authProfileOverrideCompactionCount: undefined,
        },
        storePath,
        expectedSnapshot: {
          sessionId: sessionEntry.sessionId,
          authProfileOverride: sessionEntry.authProfileOverride,
          authProfileOverrideSource: sessionEntry.authProfileOverrideSource,
          authProfileOverrideCompactionCount: sessionEntry.authProfileOverrideCompactionCount,
        },
      });
      const latestProfileId = latest?.authProfileOverride;
      const latestSource = resolveSessionAuthProfileOverrideSource(latest);
      return latestProfileId &&
        latestSource === "user" &&
        isProfileForProvider({ cfg, providers, profileId: latestProfileId, store })
        ? latestProfileId
        : undefined;
    }
    return undefined;
  }

  const isProfileUnavailableForSessionModel = (profileId: string) =>
    isProfileInCooldown(store, profileId, undefined, sessionEntry.model);
  const pickFirstAvailable = () =>
    order.find((profileId) => !isProfileUnavailableForSessionModel(profileId)) ?? order[0];
  const pickNextAvailable = (active: string) => {
    const startIndex = order.indexOf(active);
    if (startIndex < 0) {
      return pickFirstAvailable();
    }
    for (let offset = 1; offset <= order.length; offset += 1) {
      const candidate = order[(startIndex + offset) % order.length];
      if (candidate && !isProfileUnavailableForSessionModel(candidate)) {
        return candidate;
      }
    }
    return order[startIndex] ?? order[0];
  };

  const compactionCount = sessionEntry.compactionCount ?? 0;
  const storedCompaction =
    typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? sessionEntry.authProfileOverrideCompactionCount
      : compactionCount;
  const replacementForUnusableCurrent =
    current && isProfileUnavailableForSessionModel(current)
      ? order.find(
          (profileId) => profileId !== current && !isProfileUnavailableForSessionModel(profileId),
        )
      : undefined;
  if (replacementForUnusableCurrent) {
    current = undefined;
  }

  let next = current;
  if (replacementForUnusableCurrent) {
    next = replacementForUnusableCurrent;
  } else if (isNewSession) {
    next = current ? pickNextAvailable(current) : pickFirstAvailable();
  } else if (current && compactionCount > storedCompaction) {
    next = pickNextAvailable(current);
  } else if (!current || isProfileUnavailableForSessionModel(current)) {
    next = pickFirstAvailable();
  }

  if (!next) {
    return current;
  }
  const shouldPersist =
    next !== sessionEntry.authProfileOverride ||
    sessionEntry.authProfileOverrideSource !== "auto" ||
    sessionEntry.authProfileOverrideCompactionCount !== compactionCount;
  if (shouldPersist) {
    await persistSessionAuthProfileOverrideState({
      sessionEntry,
      sessionStore,
      sessionKey,
      state: {
        authProfileOverride: next,
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: compactionCount,
      },
      storePath,
    });
  }

  return next;
}
