/** Doctor-owned migration for legacy external CLI profile metadata and credentials. */
import { isDeepStrictEqual } from "node:util";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  isUsablePersistedExternalCliProfileCredential,
  listConfiguredExternalCliProfileMetadataIds,
  normalizeExternalCliProfileMetadata,
} from "../agents/auth-profiles/external-cli-profile-metadata.js";
import { resolveExternalCliAuthProfiles } from "../agents/auth-profiles/external-cli-sync.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { runAuthProfileWriteTransaction } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAuthProfileRepairCandidates } from "./doctor-auth-legacy-paths.js";

type DoctorExternalCliProfileMigration = {
  changes: string[];
  warnings: string[];
  configChanged: boolean;
};

/**
 * Doctor is the sole durable migration owner. Runtime recognizes this legacy
 * spelling only to keep a live install recoverable until this repair is run.
 */
export function maybeMigrateExternalCliProfileMetadata(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): DoctorExternalCliProfileMigration {
  const env = params.env ?? process.env;
  const profiles = params.cfg.auth?.profiles;
  const profileIds = listConfiguredExternalCliProfileMetadataIds(profiles);
  if (profileIds.length === 0 || !profiles) {
    return { changes: [], warnings: [], configChanged: false };
  }

  const pendingMetadata = new Map(
    profileIds.flatMap((profileId) => {
      const canonical = normalizeExternalCliProfileMetadata(profileId, profiles[profileId]);
      return canonical ? [[profileId, canonical] as const] : [];
    }),
  );
  const migrationSucceeded = new Map(
    [...pendingMetadata.keys()].map((profileId) => [profileId, true]),
  );
  let candidateCount = 0;

  const changes: string[] = [];
  const warnings: string[] = [];
  for (const candidate of listAuthProfileRepairCandidates(params.cfg, env)) {
    candidateCount += 1;
    const existing: AuthProfileStore = loadPersistedAuthProfileStore(candidate.agentDir) ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    const imported = resolveExternalCliAuthProfiles(existing, {
      profileIds,
      allowKeychainPrompt: false,
    }).filter((profile) => profile.persistence === "persisted");
    const importedProfileIds = new Set(imported.map((profile) => profile.profileId));
    const importedCredentials = new Map(
      imported.map((profile) => [profile.profileId, profile.credential] as const),
    );
    for (const profileId of pendingMetadata.keys()) {
      if (
        !isUsablePersistedExternalCliProfileCredential(
          profileId,
          importedCredentials.get(profileId),
        ) &&
        !isUsablePersistedExternalCliProfileCredential(profileId, existing.profiles[profileId])
      ) {
        migrationSucceeded.set(profileId, false);
      }
    }
    const next = {
      ...existing,
      profiles: {
        ...existing.profiles,
        ...Object.fromEntries(imported.map((profile) => [profile.profileId, profile.credential])),
      },
    };
    try {
      if (!isDeepStrictEqual(next, existing)) {
        runAuthProfileWriteTransaction(candidate.agentDir, (database) => {
          const authoritative =
            loadPersistedAuthProfileStore(candidate.agentDir, { database }) ??
            ({ version: AUTH_STORE_VERSION, profiles: {} } as const);
          if (!isDeepStrictEqual(authoritative, existing)) {
            throw new Error("auth profile store changed during external CLI migration");
          }
          saveAuthProfileStore(next, candidate.agentDir, { syncExternalCli: false }, database);
        });
        changes.push(
          `Persisted external CLI OAuth credentials for ${candidate.agentDir ?? "main"}.`,
        );
      }
    } catch (error) {
      for (const profileId of importedProfileIds) {
        migrationSucceeded.set(profileId, false);
      }
      warnings.push(
        `Could not persist external CLI OAuth credentials for ${candidate.agentDir ?? "main"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let configChanged = false;
  for (const [profileId, canonical] of pendingMetadata) {
    if (candidateCount === 0 || !migrationSucceeded.get(profileId)) {
      warnings.push(
        `Kept legacy external CLI metadata for ${profileId}: identity-complete OAuth credentials were not saved for every auth profile store.`,
      );
      continue;
    }
    const current = profiles[profileId];
    if (current && (current.provider !== canonical.provider || current.mode !== canonical.mode)) {
      profiles[profileId] = { ...current, ...canonical };
      configChanged = true;
    }
  }
  if (configChanged) {
    changes.unshift("Migrated legacy external CLI auth.profiles metadata to OAuth.");
  }
  return { changes, warnings, configChanged };
}
