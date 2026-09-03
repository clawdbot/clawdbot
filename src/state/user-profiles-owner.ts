import type { DatabaseSync } from "node:sqlite";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitUserProfilesChanged } from "./user-profile-events.js";
import { type UserProfileRow, userProfilesDb } from "./user-profiles-internal.js";

const log = createSubsystemLogger("state/user-profiles");
// A dot keeps the local owner outside Tailscale's provider-suffix namespace.
const OWNER_PROVIDER = "gateway.local";
const OWNER_SUBJECT = "owner";

/** Queue roster invalidation only for actual changes, after the owning transaction commits. */
export function ensureGatewayOwnerProfileRow(
  db: DatabaseSync,
  displayName: string | null,
): UserProfileRow {
  const kysely = userProfilesDb(db);
  const now = Date.now();
  const owner = executeSqliteQueryTakeFirstSync(
    db,
    kysely.selectFrom("user_profiles").selectAll().where("id", "=", GATEWAY_OWNER_PROFILE_ID),
  );
  const identified = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profiles")
      .innerJoin(
        "user_profile_identities",
        "user_profile_identities.profile_id",
        "user_profiles.id",
      )
      .selectAll("user_profiles")
      .where("provider", "=", OWNER_PROVIDER)
      .where("subject", "=", OWNER_SUBJECT),
  );
  // Old merges moved the owner identity to the person. The raw canonical row wins;
  // only an unmerged legacy UUID owner may be reused when no canonical row exists.
  const existing = owner ?? (identified?.merged_into ? undefined : identified);
  const repaired = Boolean(
    owner?.merged_into || identified?.merged_into || (owner && identified?.id !== owner.id),
  );
  const row: UserProfileRow = existing
    ? {
        ...existing,
        merged_into: null,
        display_name:
          existing.display_name?.trim() || !displayName ? existing.display_name : displayName,
      }
    : {
        id: GATEWAY_OWNER_PROFILE_ID,
        display_name: displayName,
        avatar: null,
        avatar_mime: null,
        avatar_sha256: null,
        merged_into: null,
        created_at: now,
        updated_at: now,
      };
  if (!existing) {
    executeSqliteQuerySync(db, kysely.insertInto("user_profiles").values(row));
  } else if (existing.merged_into || row.display_name !== existing.display_name) {
    row.updated_at = now;
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("user_profiles")
        .set({ merged_into: null, display_name: row.display_name, updated_at: now })
        .where("id", "=", row.id),
    );
  }
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({
        provider: OWNER_PROVIDER,
        subject: OWNER_SUBJECT,
        profile_id: row.id,
        canonical_login: null,
        created_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["provider", "subject"]).doUpdateSet({ profile_id: row.id }),
      ),
  );
  if (
    !existing ||
    existing.merged_into ||
    row.display_name !== existing.display_name ||
    identified?.id !== row.id
  ) {
    deferSqlitePostCommitPublication(db, emitUserProfilesChanged);
  }
  if (repaired) {
    deferSqlitePostCommitPublication(db, () =>
      log.warn(
        "Restored the shared gateway owner profile; personal emails, roles, and GitHub identities remain with the person.",
      ),
    );
  }
  return row;
}
