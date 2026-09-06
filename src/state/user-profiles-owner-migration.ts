// Doctor owns repair of merged shared owners; connection-time resolution fails closed.
import type { DatabaseSync } from "node:sqlite";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { emitUserProfilesChanged, publishUserProfileAliasChange } from "./user-profile-events.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import { readGatewayOwnerProfileRows } from "./user-profiles-owner.js";

function ownerRepairRequired(db: DatabaseSync): boolean {
  if (!tableExists(db, "user_profiles") || !tableExists(db, "user_profile_identities")) {
    return false;
  }
  const { owner, identified } = readGatewayOwnerProfileRows(db);
  return Boolean(
    owner?.merged_into || identified?.merged_into || (owner && identified?.id !== owner.id),
  );
}

export function repairMergedGatewayOwnerProfile(
  options: OpenClawStateDatabaseOptions & { shouldRepair: boolean },
): { repaired: boolean; changes: string[]; warnings: string[] } {
  const unchanged = { repaired: false, changes: [], warnings: [] };
  if (!withExistingOpenClawStateDatabaseReadOnly(({ db }) => ownerRepairRequired(db), options)) {
    return unchanged;
  }
  if (!options.shouldRepair) {
    return {
      ...unchanged,
      warnings: [
        "The shared gateway owner profile requires repair. Run openclaw doctor --fix, then reconnect.",
      ],
    };
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Recheck under the writer lock; an earlier preview is not authority to mutate.
      if (!ownerRepairRequired(db)) {
        return unchanged;
      }
      const { owner } = readGatewayOwnerProfileRows(db);
      const kysely = userProfilesDb(db);
      const now = Date.now();
      if (owner) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ merged_into: null, updated_at: now })
            .where("id", "=", GATEWAY_OWNER_PROFILE_ID),
        );
        if (owner.merged_into) {
          deferSqlitePostCommitPublication(db, publishUserProfileAliasChange);
        }
      } else {
        // A merged legacy UUID is a person's tombstone, never a reusable owner head.
        executeSqliteQuerySync(
          db,
          kysely.insertInto("user_profiles").values({
            id: GATEWAY_OWNER_PROFILE_ID,
            display_name: null,
            avatar: null,
            avatar_mime: null,
            avatar_sha256: null,
            merged_into: null,
            created_at: now,
            updated_at: now,
          }),
        );
      }
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("user_profile_identities")
          .values({
            provider: "gateway.local",
            subject: "owner",
            profile_id: GATEWAY_OWNER_PROFILE_ID,
            canonical_login: null,
            created_at: now,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["provider", "subject"])
              .doUpdateSet({ profile_id: GATEWAY_OWNER_PROFILE_ID }),
          ),
      );
      deferSqlitePostCommitPublication(db, emitUserProfilesChanged);
      return {
        repaired: true,
        changes: [
          "Restored gateway-owner as the shared owner and repaired its local identity; personal emails, roles, and GitHub identities remain with the person.",
        ],
        warnings: [],
      };
    },
    options,
    { operationLabel: "user-profiles.repair-merged-owner" },
  );
}
