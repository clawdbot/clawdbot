// Canonical additive schema for durable user profiles. Kept feature-local so
// ordinary shared-state opens do not create identity tables until they are used.
export const USER_PROFILES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT,
  avatar BLOB,
  avatar_mime TEXT,
  avatar_sha256 TEXT,
  merged_into TEXT,
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
`;
