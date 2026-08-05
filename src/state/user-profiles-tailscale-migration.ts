// Doctor-only repair for Tailscale provider logins written as email aliases.
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { classifyTailscaleLogin } from "./user-profiles-tailscale-login.js";
import { ensureUserProfilesSchema, type UserProfilesDatabase } from "./user-profiles.js";

type UserProfileIdentityMigrationResult = {
  changes: string[];
  warnings: string[];
};

export function migrateLegacyTailscaleProfileIdentities(
  options: OpenClawStateDatabaseOptions = {},
): UserProfileIdentityMigrationResult {
  const database = openOpenClawStateDatabase(options);
  if (!tableExists(database.db, "user_profile_emails")) {
    return { changes: [], warnings: [] };
  }
  const kysely = getNodeSqliteKysely<UserProfilesDatabase>(database.db);
  // Legacy aliases did not record auth provenance. Doctor intentionally applies
  // the current LoginName classifier while preserving any conflicting alias.
  const legacyRows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("user_profile_emails")
      .select(["email", "profile_id", "created_at"])
      .orderBy("email", "asc"),
  ).rows.flatMap((row) => {
    const classified = classifyTailscaleLogin(row.email);
    return classified.kind === "provider" ? [{ ...row, ...classified }] : [];
  });
  if (legacyRows.length === 0) {
    return { changes: [], warnings: [] };
  }

  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const transactionKysely = getNodeSqliteKysely<UserProfilesDatabase>(db);
      let migrated = 0;
      const warnings: string[] = [];
      for (const row of legacyRows) {
        executeSqliteQuerySync(
          db,
          transactionKysely
            .insertInto("user_profile_identities")
            .values({
              provider: row.provider,
              subject: row.subject,
              profile_id: row.profile_id,
              created_at: row.created_at,
            })
            .onConflict((conflict) => conflict.columns(["provider", "subject"]).doNothing()),
        );
        const identity = executeSqliteQueryTakeFirstSync(
          db,
          transactionKysely
            .selectFrom("user_profile_identities")
            .select("profile_id")
            .where("provider", "=", row.provider)
            .where("subject", "=", row.subject),
        );
        if (identity?.profile_id !== row.profile_id) {
          warnings.push(
            `Kept legacy profile login ${row.email}: ${row.provider} identity is already linked to another profile.`,
          );
          continue;
        }
        executeSqliteQuerySync(
          db,
          transactionKysely
            .deleteFrom("user_profile_emails")
            .where("email", "=", row.email)
            .where("profile_id", "=", row.profile_id),
        );
        migrated += 1;
      }
      return {
        changes:
          migrated > 0
            ? [
                `Moved ${migrated} legacy Tailscale provider ${migrated === 1 ? "identity" : "identities"} out of user profile email aliases.`,
              ]
            : [],
        warnings,
      };
    },
    options,
    { operationLabel: "user-profiles.migrate-legacy-identities" },
  );
}
