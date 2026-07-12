// Doctor cleanup for per-agent OAuth profiles shadowing fresher main-agent credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveAgentDir,
  resolveDefaultAgentDir,
  listAgentEntries,
} from "../../../agents/agent-scope.js";
import {
  isLegacyOAuthRef,
  LEGACY_OAUTH_REF_PROVIDER,
} from "../../../agents/auth-profiles/legacy-oauth-ref.js";
import {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptMainStoreOAuthIdentity,
} from "../../../agents/auth-profiles/oauth-shared.js";
import { resolveAuthStorePath } from "../../../agents/auth-profiles/paths.js";
import { loadPersistedAuthProfileStore } from "../../../agents/auth-profiles/persisted.js";
import { updateAuthProfileStoreWithLock } from "../../../agents/auth-profiles/store.js";
import type { AuthProfileStore, OAuthCredential } from "../../../agents/auth-profiles/types.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { shortenHomePath } from "../../../utils.js";

type StaleOAuthProfileShadow = {
  agentDir: string;
  authPath: string;
  profileId: string;
};

async function loadRawAuthProfileStore(authPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(authPath, "utf8")) as unknown;
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function hasLegacyOAuthSidecarRef(raw: Record<string, unknown> | null, profileId: string): boolean {
  if (!raw || !isRecord(raw.profiles)) {
    return false;
  }
  const profile = raw.profiles[profileId];
  if (!isRecord(profile)) {
    return false;
  }
  // Removal-only guard for #79006 sidecar OAuth profiles. Do not add OS-level
  // keychain integrations; doctor must migrate these profiles, not delete them.
  return (
    profile.type === "oauth" &&
    profile.provider === LEGACY_OAUTH_REF_PROVIDER &&
    isLegacyOAuthRef(profile.oauthRef)
  );
}

async function collectStateAgentDirs(env: NodeJS.ProcessEnv): Promise<string[]> {
  const agentsRoot = path.join(resolveStateDir(env), "agents");
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(agentsRoot, entry.name, "agent"));
}

async function collectCandidateAgentDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const dirs = new Set<string>();
  for (const entry of listAgentEntries(cfg)) {
    const id = entry.id?.trim();
    if (id) {
      dirs.add(path.resolve(resolveAgentDir(cfg, id, env)));
    }
  }
  for (const agentDir of await collectStateAgentDirs(env)) {
    dirs.add(path.resolve(agentDir));
  }
  return [...dirs].toSorted((left, right) => left.localeCompare(right));
}

function shouldRemoveLocalOAuthShadow(params: {
  local: OAuthCredential;
  main: OAuthCredential | undefined;
  now: number;
}): boolean {
  const { local, main, now } = params;
  if (!main || main.type !== "oauth" || local.provider !== main.provider) {
    return false;
  }
  if (!isSafeToAdoptMainStoreOAuthIdentity(local, main)) {
    return false;
  }
  if (areOAuthCredentialsEquivalent(local, main)) {
    return true;
  }
  if (!hasUsableOAuthCredential(main, now)) {
    return false;
  }
  if (!hasUsableOAuthCredential(local, now)) {
    return true;
  }
  const localExpires = Number.isFinite(local.expires) ? local.expires : 0;
  const mainExpires = Number.isFinite(main.expires) ? main.expires : 0;
  return mainExpires >= localExpires;
}

/** Find local OAuth profiles that safely inherit fresher main-agent credentials instead. */
export async function scanStaleOAuthProfileShadows(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<StaleOAuthProfileShadow[]> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const mainAgentDir = resolveDefaultAgentDir({}, env);
  const mainAuthPath = path.resolve(resolveAuthStorePath(mainAgentDir));
  const mainStore = loadPersistedAuthProfileStore(mainAgentDir);
  if (!mainStore) {
    return [];
  }
  const hits: StaleOAuthProfileShadow[] = [];
  for (const agentDir of await collectCandidateAgentDirs(params.cfg, env)) {
    const authPath = path.resolve(resolveAuthStorePath(agentDir));
    if (authPath === mainAuthPath) {
      continue;
    }
    const rawLocalStore = await loadRawAuthProfileStore(authPath);
    const localStore = loadPersistedAuthProfileStore(agentDir);
    if (!localStore) {
      continue;
    }
    for (const [profileId, local] of Object.entries(localStore.profiles)) {
      if (local.type !== "oauth") {
        continue;
      }
      if (hasLegacyOAuthSidecarRef(rawLocalStore, profileId)) {
        continue;
      }
      const main = mainStore.profiles[profileId];
      if (
        shouldRemoveLocalOAuthShadow({
          local,
          main: main?.type === "oauth" ? main : undefined,
          now,
        })
      ) {
        hits.push({ agentDir, authPath, profileId });
      }
    }
  }
  return hits;
}

function removeStaleProfilesFromStore(params: {
  store: AuthProfileStore;
  mainStore: AuthProfileStore;
  profileIds: Set<string>;
  now: number;
}): { store: AuthProfileStore; removedProfileIds: string[] } {
  const removedProfileIds: string[] = [];
  const profiles = { ...params.store.profiles };
  const usageStats = params.store.usageStats ? { ...params.store.usageStats } : undefined;
  const order = params.store.order ? { ...params.store.order } : undefined;
  const lastGood = params.store.lastGood ? { ...params.store.lastGood } : undefined;
  for (const profileId of params.profileIds) {
    const local = profiles[profileId];
    const main = params.mainStore.profiles[profileId];
    if (
      local?.type !== "oauth" ||
      !shouldRemoveLocalOAuthShadow({
        local,
        main: main?.type === "oauth" ? main : undefined,
        now: params.now,
      })
    ) {
      continue;
    }
    delete profiles[profileId];
    if (usageStats) {
      delete usageStats[profileId];
    }
    if (lastGood) {
      for (const [provider, lastGoodProfileId] of Object.entries(lastGood)) {
        if (lastGoodProfileId === profileId) {
          delete lastGood[provider];
        }
      }
    }
    if (order) {
      for (const [provider, profileIds] of Object.entries(order)) {
        const nextProfileIds = profileIds.filter((entry) => entry !== profileId);
        if (nextProfileIds.length > 0) {
          order[provider] = nextProfileIds;
        } else {
          delete order[provider];
        }
      }
    }
    removedProfileIds.push(profileId);
  }
  return {
    store: {
      ...params.store,
      profiles,
      ...(usageStats && Object.keys(usageStats).length > 0
        ? { usageStats }
        : { usageStats: undefined }),
      ...(lastGood && Object.keys(lastGood).length > 0 ? { lastGood } : { lastGood: undefined }),
      ...(order && Object.keys(order).length > 0 ? { order } : { order: undefined }),
    },
    removedProfileIds,
  };
}

function formatProfileList(profileIds: string[]): string {
  return profileIds.length === 1
    ? expectDefined(profileIds[0], "profile ids entry at 0")
    : `${profileIds.length} profiles`;
}

async function repairStaleOAuthProfilesForAgent(params: {
  agentDir: string;
  mainStore: AuthProfileStore;
  profileIds: Set<string>;
  now: number;
}): Promise<
  { status: "changed"; removedProfileIds: string[] } | { status: "missing" | "unchanged" }
> {
  const rawStore = await loadRawAuthProfileStore(resolveAuthStorePath(params.agentDir));
  const profileIds = new Set(
    [...params.profileIds].filter((profileId) => !hasLegacyOAuthSidecarRef(rawStore, profileId)),
  );
  if (profileIds.size === 0) {
    return { status: "unchanged" };
  }
  if (!loadPersistedAuthProfileStore(params.agentDir)) {
    return { status: "missing" };
  }
  let sawStore = false;
  let removedProfileIds: string[] = [];
  await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      sawStore = true;
      const result = removeStaleProfilesFromStore({
        store,
        mainStore: params.mainStore,
        profileIds,
        now: params.now,
      });
      if (result.removedProfileIds.length === 0) {
        return false;
      }
      removedProfileIds = result.removedProfileIds;
      Object.assign(store, result.store);
      return true;
    },
  });
  if (!sawStore) {
    return { status: "missing" };
  }
  return removedProfileIds.length > 0
    ? { status: "changed", removedProfileIds }
    : { status: "unchanged" };
}

/** Format warnings for stale per-agent OAuth profile shadows. */
export function collectStaleOAuthProfileShadowWarnings(params: {
  hits: StaleOAuthProfileShadow[];
  doctorFixCommand: string;
}): string[] {
  return params.hits.map(
    (hit) =>
      `- ${shortenHomePath(hit.authPath)} has stale OAuth auth profile ${hit.profileId}; it shadows the fresher main-agent credential. Run "${params.doctorFixCommand}" to remove the local shadow and inherit main auth.`,
  );
}

/** Remove stale per-agent OAuth profile shadows after rechecking each locked store. */
export async function repairStaleOAuthProfileShadows(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const hits = await scanStaleOAuthProfileShadows({ ...params, env, now });
  const changes: string[] = [];
  const warnings: string[] = [];
  const byAgentDir = new Map<string, StaleOAuthProfileShadow[]>();
  for (const hit of hits) {
    const existing = byAgentDir.get(hit.agentDir) ?? [];
    existing.push(hit);
    byAgentDir.set(hit.agentDir, existing);
  }
  for (const [agentDir, agentHits] of byAgentDir) {
    const mainStore = loadPersistedAuthProfileStore(resolveDefaultAgentDir({}, env));
    if (!mainStore) {
      continue;
    }
    const profileIds = new Set(agentHits.map((hit) => hit.profileId));
    try {
      const repair = await repairStaleOAuthProfilesForAgent({
        agentDir,
        mainStore,
        profileIds,
        now,
      });
      if (repair.status === "changed") {
        changes.push(
          `Removed stale OAuth auth profile shadow ${formatProfileList(
            repair.removedProfileIds.toSorted(),
          )} from ${shortenHomePath(resolveAuthStorePath(agentDir))}; this agent now inherits main auth.`,
        );
      }
    } catch (error) {
      warnings.push(
        `Failed to remove stale OAuth auth profile shadow from ${shortenHomePath(
          resolveAuthStorePath(agentDir),
        )}: ${String(error)}`,
      );
    }
  }
  return { changes, warnings };
}

export const testing = {
  removeStaleProfilesFromStore,
  repairStaleOAuthProfilesForAgent,
};
