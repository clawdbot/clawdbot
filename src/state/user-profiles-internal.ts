import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  ensureUserProfilesSchema,
  type UserProfilesDatabase,
  UserProfileNotFoundError,
} from "./user-profiles-schema.js";
import {
  USER_PROFILE_AVATAR_MIME_TYPES,
  type UserProfileAvatarMime,
} from "./user-profiles-tailscale-avatar.js";

export type UserProfileRow = UserProfilesDatabase["user_profiles"];
type UserProfileAvatar = {
  bytes: Uint8Array;
  mime: UserProfileAvatarMime;
  sha256: string;
  updatedAt: number;
};

export function userProfilesDb(db: DatabaseSync) {
  return getNodeSqliteKysely<UserProfilesDatabase>(db);
}

export function normalizeUserProfileAvatarMime(value: string | null): UserProfileAvatarMime | null {
  return USER_PROFILE_AVATAR_MIME_TYPES.find((candidate) => candidate === value) ?? null;
}

function selectUserProfileById(db: DatabaseSync, profileId: string): UserProfileRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    userProfilesDb(db).selectFrom("user_profiles").selectAll().where("id", "=", profileId),
  );
}

export function selectResolvedUserProfileById(
  db: DatabaseSync,
  profileId: string,
): UserProfileRow | undefined {
  const profile = selectUserProfileById(db, profileId);
  if (!profile?.merged_into) {
    return profile;
  }
  // Merge writers repoint aliases and existing tombstones, so durable profile
  // references need exactly one hop to reach the canonical row.
  return selectUserProfileById(db, profile.merged_into) ?? profile;
}

export function requireResolvedUserProfileById(
  db: DatabaseSync,
  profileId: string,
): UserProfileRow {
  const profile = selectResolvedUserProfileById(db, profileId);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return profile;
}

export function formatUserProfileAvatarEtag(sha256: string, mime: UserProfileAvatarMime): string {
  return `"${sha256}-${mime.slice("image/".length)}"`;
}

export function getProfileAvatar(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAvatar | undefined {
  ensureUserProfilesSchema(options);
  const profile = selectResolvedUserProfileById(openOpenClawStateDatabase(options).db, profileId);
  const mime = normalizeUserProfileAvatarMime(profile?.avatar_mime ?? null);
  return profile?.avatar && mime && profile.avatar_sha256
    ? { bytes: profile.avatar, mime, sha256: profile.avatar_sha256, updatedAt: profile.updated_at }
    : undefined;
}
