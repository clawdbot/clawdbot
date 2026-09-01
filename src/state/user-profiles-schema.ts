import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

// Canonical additive schema for durable user profiles. Kept feature-local so
// ordinary shared-state opens do not create identity tables until they are used.
const USER_PROFILES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT,
  avatar BLOB,
  avatar_mime TEXT,
  avatar_sha256 TEXT,
  merged_into TEXT,
  role TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS user_profile_emails (
  email TEXT NOT NULL PRIMARY KEY,
  profile_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_profile_emails_profile_id
  ON user_profile_emails(profile_id);

CREATE TABLE IF NOT EXISTS user_profile_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  canonical_login TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_user_profile_identities_profile_id
  ON user_profile_identities(profile_id);
`;

export type UserProfilesDatabase = {
  user_profiles: {
    id: string;
    display_name: string | null;
    avatar: Uint8Array | null;
    avatar_mime: string | null;
    avatar_sha256: string | null;
    merged_into: string | null;
    role?: string | null;
    created_at: number;
    updated_at: number;
  };
  user_profile_emails: { email: string; profile_id: string; created_at: number };
  user_profile_identities: {
    provider: string;
    subject: string;
    profile_id: string;
    canonical_login: string | null;
    created_at: number;
  };
};

export class UserProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`user profile not found: ${profileId}`);
    this.name = "UserProfileNotFoundError";
  }
}

const ensuredDatabases = new WeakSet<DatabaseSync>();
const roleEnsuredDatabases = new WeakSet<DatabaseSync>();

export function ensureUserProfilesSchema(
  options: OpenClawStateDatabaseOptions,
  database = openOpenClawStateDatabase(options),
): void {
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  let hasRoleColumn = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(USER_PROFILES_SCHEMA_SQL); // sqlite-allow-raw -- Canonical feature-local additive DDL.
      ensureColumn(db, "user_profile_identities", "canonical_login TEXT");
      hasRoleColumn = tableHasColumn(db, "user_profiles", "role");
    },
    options,
    { operationLabel: "user-profiles.schema.ensure" },
  );
  // A rolled-back ensure must retry rather than caching a missing table/column.
  ensuredDatabases.add(database.db);
  if (hasRoleColumn) {
    roleEnsuredDatabases.add(database.db);
  }
}

export function ensureUserProfileRoleSchema(
  options: OpenClawStateDatabaseOptions,
  database = openOpenClawStateDatabase(options),
): void {
  if (roleEnsuredDatabases.has(database.db)) {
    return;
  }
  ensureUserProfilesSchema(options, database);
  if (roleEnsuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => ensureColumn(db, "user_profiles", "role TEXT"),
    options,
    { operationLabel: "user-profiles.role.schema.ensure" },
  );
  // Cache only a committed ensure so rolled-back additions remain retryable.
  roleEnsuredDatabases.add(database.db);
}

export function hasEnsuredUserProfileRoleSchema(database: DatabaseSync): boolean {
  return roleEnsuredDatabases.has(database);
}
