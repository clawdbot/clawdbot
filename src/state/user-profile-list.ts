import { sql } from "kysely";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { selectUserProfileGitHubIdentities } from "./user-profile-github-identity.js";
import { normalizeUserProfileAvatarMime, userProfilesDb } from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";

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
            "created_at",
            "updated_at",
            sql`CASE WHEN avatar IS NULL THEN 0 ELSE 1 END`.as("has_avatar"),
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
      return profiles.map((profile) => ({
        id: profile.id,
        displayName: profile.display_name,
        avatarMime: normalizeUserProfileAvatarMime(profile.avatar_mime),
        mergedInto: profile.merged_into,
        createdAt: profile.created_at,
        updatedAt: profile.updated_at,
        emails: emailsByProfile.get(profile.id) ?? [],
        githubIdentity: githubIdentities.get(profile.id) ?? null,
        hasAvatar: profile.has_avatar === 1,
      }));
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
