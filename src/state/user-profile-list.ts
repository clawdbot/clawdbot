import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { selectUserProfileGitHubIdentities } from "./user-profile-github-identity.js";
import {
  selectResolvedUserProfile,
  selectResolvedUserProfileById,
  normalizeUserProfileAvatarMime,
  userProfileAvatarPresence,
  userProfilesDb,
} from "./user-profiles-internal.js";
import {
  ensureUserProfilesSchema,
  UserProfileNotFoundError,
  hasEnsuredUserProfileRoleSchema,
} from "./user-profiles-schema.js";

export function listProfiles(options: OpenClawStateDatabaseOptions = {}) {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const kysely = userProfilesDb(database.db);
      const profiles = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profiles")
          .select([
            "id",
            "display_name",
            "avatar_mime",
            "merged_into",
            ...(hasEnsuredUserProfileRoleSchema(database.db) ? (["role"] as const) : []),
            "created_at",
            "updated_at",
            userProfileAvatarPresence,
          ])
          .orderBy("created_at", "asc")
          .orderBy("id", "asc"),
      ).rows;
      const emails = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("user_profile_emails")
          .select(["profile_id", "email"])
          .orderBy("email", "asc"),
      ).rows;
      const githubIdentities = selectUserProfileGitHubIdentities(database.db);
      const emailsByProfile = new Map<string, string[]>();
      for (const email of emails) {
        const list = emailsByProfile.get(email.profile_id) ?? [];
        list.push(email.email);
        emailsByProfile.set(email.profile_id, list);
      }
      return profiles.map((profile) =>
        Object.assign(
          {
            id: profile.id,
            displayName: profile.display_name,
            avatarMime: normalizeUserProfileAvatarMime(profile.avatar_mime),
            mergedInto: profile.merged_into,
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
            emails: emailsByProfile.get(profile.id) ?? [],
            githubIdentity: githubIdentities.get(profile.id) ?? null,
            hasAvatar: profile.has_avatar === 1,
          },
          profile.role ? { role: profile.role } : {},
        ),
      );
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.list" },
  );
}

/** True when session-sharing policy can distinguish at least two durable people. */
export function hasMultipleSessionSharingIdentities(
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profiles = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select("id")
      .where("merged_into", "is", null)
      .limit(2),
  ).rows;
  return profiles.length >= 2;
}

type UserProfileDisplay = {
  id: string;
  displayName: string | null;
  avatarRevision: string;
  hasAvatar: boolean;
};

// Profile writers publish a version after commit; handle replacement drops the whole snapshot.
// Bound callers per handle so lists and broadcasts share facts without retaining past users forever.
const profileAliasSnapshots = new WeakMap<
  DatabaseSync,
  {
    version: number;
    callers: Map<string, ReadonlySet<string>>;
  }
>();

/** Existing one-hop aliases are identity facts; this read never creates profile storage. */
export function readUserProfileAliases(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  const opened = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const version = readUserProfileVersion();
  let snapshot =
    opened && !opened.db.isTransaction ? profileAliasSnapshots.get(opened.db) : undefined;
  if (snapshot?.version !== version) {
    snapshot = undefined;
  }
  const cached = snapshot?.callers.get(profileId);
  if (cached) {
    return cached;
  }
  const aliases =
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "user_profiles")) {
        return new Set([profileId]);
      }
      const canonicalId = selectResolvedUserProfileById(db, profileId)?.id;
      if (!canonicalId) {
        return new Set([profileId]);
      }
      return new Set([
        profileId,
        ...executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .selectFrom("user_profiles")
            .select("id")
            .where((eb) =>
              eb.or([eb("id", "=", canonicalId), eb("merged_into", "=", canonicalId)]),
            ),
        ).rows.map((row) => row.id),
      ]);
    }, options) ?? new Set([profileId]);
  if (opened && !opened.db.isTransaction) {
    snapshot ??= { version, callers: new Map() };
    snapshot.callers.set(profileId, aliases);
    if (snapshot.callers.size > 128) {
      const oldest = snapshot.callers.keys().next().value;
      if (oldest !== undefined) {
        snapshot.callers.delete(oldest);
      }
    }
    profileAliasSnapshots.set(opened.db, snapshot);
  }
  return aliases;
}

const userProfileDisplaySelection = [
  "id",
  "display_name",
  "avatar_mime",
  "avatar_sha256",
  "merged_into",
  "updated_at",
  userProfileAvatarPresence,
] as const;

/** Reads merge-aware display data without loading avatar bytes. */
export function getUserProfileDisplay(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileDisplay {
  const profile = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "user_profiles")) {
      return undefined;
    }
    return selectResolvedUserProfile(
      db,
      profileId,
      userProfilesDb(db).selectFrom("user_profiles").select(userProfileDisplaySelection),
    );
  }, options);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  const avatarMime = normalizeUserProfileAvatarMime(profile.avatar_mime);
  const avatarRevision =
    profile.avatar_sha256 && avatarMime
      ? `${profile.avatar_sha256}-${avatarMime.slice("image/".length)}`
      : String(profile.updated_at);
  return {
    id: profile.id,
    displayName: profile.display_name,
    avatarRevision,
    hasAvatar: profile.has_avatar === 1,
  };
}
