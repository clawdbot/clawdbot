import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SkillLibraryEntry } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { authorizeOperatorScopesForRequiredScope } from "../../gateway/method-scopes.js";
import { resolveOperatorRolePolicyForAssignment } from "../../gateway/operator-role-policy.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { selectResolvedUserProfileById } from "../../state/user-profiles-internal.js";
import { managedSkillCommandName } from "./command-name.js";
import { SkillLibraryError } from "./errors.js";

export type SkillLibraryAuthority = {
  /** Host-authenticated profile only. Neither session attribution nor model arguments qualify. */
  profileId?: string;
  namespace?: "personal";
  scopes: readonly string[];
  getConfig: () => OpenClawConfig;
  /** Must revalidate the admitted run/placement and request owner, synchronously at commit. */
  assertCurrent: () => void;
};
export type SkillLibraryRow = StateDatabase["skill_library_entries"];
export type SkillLibraryRevisionRow = StateDatabase["skill_library_revisions"];
export type SkillLibraryDatabase = Pick<
  StateDatabase,
  | "skill_library_entries"
  | "skill_library_revisions"
  | "skill_library_events"
  | "skill_library_uploads"
>;
export const skillLibraryDb = (db: DatabaseSync) => getNodeSqliteKysely<SkillLibraryDatabase>(db);
const ensured = new WeakSet<DatabaseSync>();

export function ensureSkillLibrarySchema(options: OpenClawStateDatabaseOptions): void {
  const { db } = openOpenClawStateDatabase(options);
  if (ensured.has(db)) {
    return;
  }
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS skill_library_entries (",
  );
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf("-- End profile-owned skill library.", start);
  if (start < 0 || end < start) {
    throw new Error("Canonical skill library schema missing.");
  }
  runOpenClawStateWriteTransaction(
    ({ db: transactionDb }) => {
      transactionDb.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end)); // sqlite-allow-raw -- canonical first-use additive DDL.
    },
    options,
    { operationLabel: "skills.library.schema" },
  );
  ensured.add(db);
}

export function readSkillLibraryStore<T>(
  read: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions,
): T | undefined {
  if (options.database) {
    return tableExists(options.database.db, "skill_library_entries")
      ? read(options.database.db)
      : undefined;
  }
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => (tableExists(db, "skill_library_entries") ? read(db) : undefined),
    options,
  );
}

export function resolveSkillLibraryActor(db: DatabaseSync, authority: SkillLibraryAuthority) {
  authority.assertCurrent();
  const profile =
    authority.profileId && tableExists(db, "user_profiles")
      ? selectResolvedUserProfileById(db, authority.profileId)
      : undefined;
  if (authority.profileId && !profile) {
    throw new SkillLibraryError(
      "AUTHORITY_EXPIRED",
      "Your Gateway profile is no longer available. Sign in again before accessing the library.",
    );
  }
  const ceiling = resolveOperatorRolePolicyForAssignment(
    profile?.id,
    profile?.role ?? null,
    authority.getConfig(),
  )?.scopes;
  const permits = (scope: "operator.read" | "operator.write" | "operator.admin") =>
    authorizeOperatorScopesForRequiredScope(scope, [...authority.scopes]).allowed &&
    (!ceiling || authorizeOperatorScopesForRequiredScope(scope, ceiling).allowed);
  return {
    profileId: profile?.id,
    admin: permits("operator.admin"),
    read: permits("operator.read") || permits("operator.write"),
    write: Boolean(profile) && permits("operator.write"),
  };
}

export function requireSkillLibraryProfile(
  db: DatabaseSync,
  authority: SkillLibraryAuthority,
): string {
  const actor = resolveSkillLibraryActor(db, authority);
  if (!actor.profileId) {
    throw new SkillLibraryError(
      "IDENTITY_REQUIRED",
      "Sign in with a durable Gateway profile to use a personal skill library. Shared-token administrators can use workspace skills.",
    );
  }
  if (!actor.write) {
    throw new SkillLibraryError("FORBIDDEN", "Your current Gateway role cannot change skills.");
  }
  return actor.profileId;
}

export function selectSkillLibraryRow(
  db: DatabaseSync,
  skillId: string,
): SkillLibraryRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    skillLibraryDb(db)
      .selectFrom("skill_library_entries")
      .selectAll()
      .where("skill_id", "=", skillId),
  );
}
export function selectSkillLibraryRevision(
  db: DatabaseSync,
  skillId: string,
  revision: string,
): SkillLibraryRevisionRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    skillLibraryDb(db)
      .selectFrom("skill_library_revisions")
      .selectAll()
      .where("skill_id", "=", skillId)
      .where("revision", "=", revision),
  );
}

function canonicalOwner(db: DatabaseSync, owner: string | null): string | null {
  return owner && tableExists(db, "user_profiles")
    ? (selectResolvedUserProfileById(db, owner)?.id ?? owner)
    : owner;
}

export function projectSkillLibraryEntry(
  db: DatabaseSync,
  row: SkillLibraryRow,
  authority: SkillLibraryAuthority,
  revision = row.current_revision,
  selectedBySession = false,
): SkillLibraryEntry | undefined {
  const actor = resolveSkillLibraryActor(db, authority);
  const owner = canonicalOwner(db, row.owner_profile_id);
  if (
    !actor.read ||
    (!selectedBySession &&
      !actor.admin &&
      owner !== actor.profileId &&
      !row.shared &&
      owner !== null)
  ) {
    return undefined;
  }
  const metadata = selectSkillLibraryRevision(db, row.skill_id, revision);
  if (!metadata) {
    return undefined;
  }
  return {
    skillId: row.skill_id,
    slug: row.slug,
    name: managedSkillCommandName(row.slug, row.skill_id),
    ownerLabel:
      owner === null ? "Team" : (selectResolvedUserProfileById(db, owner)?.display_name ?? owner),
    description: metadata.description,
    ownerProfileId: owner,
    authorProfileId: row.author_profile_id,
    shared: row.shared === 1,
    enabled: row.enabled === 1,
    removed: row.removed === 1,
    revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canEdit:
      actor.write &&
      ((authority.namespace !== "personal" && actor.admin) ||
        (owner !== null && actor.profileId === owner)),
  };
}

export function requireSkillLibraryEntry(
  db: DatabaseSync,
  skillId: string,
  authority: SkillLibraryAuthority,
  write = false,
): SkillLibraryEntry {
  const row = selectSkillLibraryRow(db, skillId);
  const entry = row && projectSkillLibraryEntry(db, row, authority);
  if (!entry) {
    throw new SkillLibraryError("NOT_FOUND", "Skill not found in your accessible library.");
  }
  if (write && !entry.canEdit) {
    requireSkillLibraryProfile(db, authority);
    throw new SkillLibraryError(
      "FORBIDDEN",
      authority.namespace === "personal"
        ? "Personal authoring can change only your own skills. Use the administrator UI or CLI for team management."
        : "Only the skill's owner or a Gateway administrator can change it.",
    );
  }
  if (write && entry.removed) {
    throw new SkillLibraryError(
      "NOT_FOUND",
      "Removed skills cannot be edited or selected again; pinned revisions remain available to their sessions.",
    );
  }
  return entry;
}

export function assertSkillLibraryRevision(entry: SkillLibraryEntry, expected: string | null) {
  if (entry.revision !== expected) {
    throw new SkillLibraryError(
      "CONFLICT",
      "Skill changed. Read the current revision and review your edit before saving again.",
      entry.revision,
    );
  }
}

export function assertSkillLibraryNameAvailable(
  db: DatabaseSync,
  owner: string | null,
  slug: string,
  exceptId?: string,
) {
  const rows = executeSqliteQuerySync(
    db,
    skillLibraryDb(db)
      .selectFrom("skill_library_entries")
      .selectAll()
      .where("slug", "=", slug)
      .where("removed", "=", 0),
  ).rows;
  if (
    rows.some(
      (row) => row.skill_id !== exceptId && canonicalOwner(db, row.owner_profile_id) === owner,
    )
  ) {
    throw new SkillLibraryError(
      "NAME_CONFLICT",
      `A skill named "${slug}" already exists in this library. Choose a different slug; existing skills were preserved.`,
    );
  }
}

export function recordSkillLibraryEvent(
  db: DatabaseSync,
  skillId: string,
  revision: string,
  action: string,
  actorProfileId: string,
) {
  executeSqliteQuerySync(
    db,
    skillLibraryDb(db).insertInto("skill_library_events").values({
      event_id: randomUUID(),
      skill_id: skillId,
      revision,
      action,
      actor_profile_id: actorProfileId,
      created_at: Date.now(),
    }),
  );
}
