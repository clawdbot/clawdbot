import type { DatabaseSync } from "node:sqlite";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { emitUserProfilesChanged } from "./user-profile-events.js";
import { type UserProfileRow, userProfilesDb } from "./user-profiles-internal.js";
import { UserProfileOwnerError } from "./user-profiles-schema.js";

// A dot keeps the local owner outside Tailscale's provider-suffix namespace.
const OWNER_PROVIDER = "gateway.local";
const OWNER_SUBJECT = "owner";

/** Read raw rows: the shared owner must never inherit a person through a merge. */
export function readGatewayOwnerProfileRows(db: DatabaseSync) {
  const kysely = userProfilesDb(db);
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
  return { owner, identified };
}

/** Queue roster invalidation only for actual changes, after the owning transaction commits. */
export function ensureGatewayOwnerProfileRow(
  db: DatabaseSync,
  displayName: string | null,
): UserProfileRow {
  const { owner, identified } = readGatewayOwnerProfileRows(db);
  if (
    owner?.merged_into ||
    identified?.merged_into ||
    (owner && identified && owner.id !== identified.id)
  ) {
    throw new UserProfileOwnerError("repair-required");
  }
  const kysely = userProfilesDb(db);
  const now = Date.now();
  const existing = owner ?? identified;
  const row: UserProfileRow = existing
    ? {
        ...existing,
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
  } else if (row.display_name !== existing.display_name) {
    row.updated_at = now;
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("user_profiles")
        .set({ display_name: row.display_name, updated_at: now })
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
      .onConflict((conflict) => conflict.columns(["provider", "subject"]).doNothing()),
  );
  if (!existing || row.display_name !== existing.display_name || !identified) {
    deferSqlitePostCommitPublication(db, emitUserProfilesChanged);
  }
  return row;
}
