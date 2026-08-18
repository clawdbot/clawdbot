import { createHash } from "node:crypto";
// Durable user profiles plus typed login identities in the shared state DB.
import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { sql } from "kysely";
import type { UserProfileGitHubIdentity } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { mergeUserPreferences } from "./user-preferences.js";
import {
  clearUserProfileGitHubIdentity,
  mergeUserProfileGitHubIdentity,
  selectUserProfileGitHubIdentities,
  setUserProfileGitHubIdentity,
  UserProfileGitHubIdentityConflictError,
} from "./user-profile-github-identity.js";
import {
  normalizeUserProfileAvatarMime,
  requireResolvedUserProfileById,
  selectResolvedUserProfileById,
  type UserProfileRow,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema, UserProfileNotFoundError } from "./user-profiles-schema.js";
import {
  fetchTailscaleAvatar,
  MAX_USER_PROFILE_AVATAR_BYTES,
  USER_PROFILE_AVATAR_MIME_TYPES,
  type TailscaleAvatarFetchOptions,
  type UserProfileAvatarMime,
} from "./user-profiles-tailscale-avatar.js";
import {
  classifyTailscaleLogin,
  type TailscaleProfileIdentity,
} from "./user-profiles-tailscale-login.js";

export { formatUserProfileAvatarEtag, getProfileAvatar } from "./user-profiles-internal.js";
export { hasMultipleSessionSharingIdentities, listProfiles } from "./user-profile-list.js";

type UserProfile = {
  id: string;
  displayName: string | null;
  avatarMime: UserProfileAvatarMime | null;
  mergedInto: string | null;
  createdAt: number;
  updatedAt: number;
};

type UserProfileListItem = UserProfile & {
  emails: string[];
  githubIdentity: UserProfileGitHubIdentity | null;
  hasAvatar: boolean;
};

type UserProfileDisplay = {
  id: string;
  displayName: string | null;
  avatarRevision: string;
  hasAvatar: boolean;
};

type UserProfileAvatarError =
  | { code: "avatar_too_large"; maxBytes: number }
  | { code: "unsupported_avatar_mime"; mime: string };

export { UserProfileGitHubIdentityConflictError };
export { UserProfileNotFoundError };

type UserProfileListRow = Pick<
  UserProfileRow,
  "id" | "display_name" | "avatar_mime" | "merged_into" | "created_at" | "updated_at"
> & {
  has_avatar: unknown;
};

const MAX_USER_PROFILE_DISPLAY_NAME_LENGTH = 256;

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("email must not be empty");
  }
  return normalized;
}

function normalizeInitialDisplayName(name: string | undefined): string | null {
  const normalized = name?.trim();
  return normalized ? normalized.slice(0, MAX_USER_PROFILE_DISPLAY_NAME_LENGTH) : null;
}

function toUserProfile(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarMime: normalizeUserProfileAvatarMime(row.avatar_mime),
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUserProfileListItem(
  row: UserProfileListRow,
  emails: string[],
  githubIdentity: UserProfileGitHubIdentity | null,
): UserProfileListItem {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarMime: normalizeUserProfileAvatarMime(row.avatar_mime),
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    emails,
    githubIdentity,
    hasAvatar: row.has_avatar === 1,
  };
}

function hasAvatarColumn() {
  return sql`CASE WHEN avatar IS NULL THEN 0 ELSE 1 END`.as("has_avatar");
}

function selectUserProfileListItemById(db: DatabaseSync, profileId: string): UserProfileListItem {
  const kysely = userProfilesDb(db);
  const profile = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profiles")
      .select([
        "id",
        "display_name",
        "avatar_mime",
        "merged_into",
        "created_at",
        "updated_at",
        hasAvatarColumn(),
      ])
      .where("id", "=", profileId),
  );
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  const emails = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profile_emails")
      .select("email")
      .where("profile_id", "=", profileId)
      .orderBy("email", "asc"),
  ).rows;
  return toUserProfileListItem(
    profile,
    emails.map((alias) => alias.email),
    selectUserProfileGitHubIdentities(db, [profileId]).get(profileId) ?? null,
  );
}

/** Resolves a durable profile reference to its current one-hop merge head. */
export function resolveUserProfileId(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return selectResolvedUserProfileById(db, profileId)?.id;
}

/** Reads a profile's protocol-facing representation through its merge head. */
export function getUserProfileListItem(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return selectUserProfileListItemById(db, requireResolvedUserProfileById(db, profileId).id);
}

/** Reads merge-aware display data without exposing avatar content through list/RPC shapes. */
export function getUserProfileDisplay(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileDisplay {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profile = requireResolvedUserProfileById(db, profileId);
  const avatarMime = normalizeUserProfileAvatarMime(profile.avatar_mime);
  const avatarRevision =
    profile.avatar_sha256 && avatarMime
      ? `${profile.avatar_sha256}-${avatarMime.slice("image/".length)}`
      : String(profile.updated_at);
  return {
    id: profile.id,
    displayName: profile.display_name,
    avatarRevision,
    hasAvatar: profile.avatar !== null,
  };
}

function ensureProfileForEmailWithInitialName(
  email: string,
  initialDisplayName: string | null,
  options: OpenClawStateDatabaseOptions,
): UserProfile {
  const normalizedEmail = normalizeEmail(email);
  const profileId = generateSecureUuid();
  const now = Date.now();
  const displayName =
    initialDisplayName ??
    (normalizedEmail.split("@", 1)[0] || normalizedEmail).slice(
      0,
      MAX_USER_PROFILE_DISPLAY_NAME_LENGTH,
    );
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const existingAlias = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("profile_id")
          .where("email", "=", normalizedEmail),
      );
      if (existingAlias) {
        return toUserProfile(requireResolvedUserProfileById(db, existingAlias.profile_id));
      }
      const row: UserProfileRow = {
        id: profileId,
        display_name: displayName,
        avatar: null,
        avatar_mime: null,
        avatar_sha256: null,
        merged_into: null,
        created_at: now,
        updated_at: now,
      };
      executeSqliteQuerySync(db, kysely.insertInto("user_profiles").values(row));
      executeSqliteQuerySync(
        db,
        kysely.insertInto("user_profile_emails").values({
          email: normalizedEmail,
          profile_id: profileId,
          created_at: now,
        }),
      );
      return toUserProfile(row);
    },
    options,
    { operationLabel: "user-profiles.ensure" },
  );
}

/** Resolves an email alias or atomically creates its first durable profile. */
export function ensureProfileForEmail(
  email: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfile {
  return ensureProfileForEmailWithInitialName(email, null, options);
}

function ensureProfileForProviderIdentity(params: {
  provider: string;
  subject: string;
  initialDisplayName: string | null;
  options: OpenClawStateDatabaseOptions;
}): UserProfile {
  const profileId = generateSecureUuid();
  const now = Date.now();
  ensureUserProfilesSchema(params.options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const existingIdentity = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select("profile_id")
          .where("provider", "=", params.provider)
          .where("subject", "=", params.subject),
      );
      if (existingIdentity) {
        return toUserProfile(requireResolvedUserProfileById(db, existingIdentity.profile_id));
      }
      const row: UserProfileRow = {
        id: profileId,
        display_name: params.initialDisplayName,
        avatar: null,
        avatar_mime: null,
        avatar_sha256: null,
        merged_into: null,
        created_at: now,
        updated_at: now,
      };
      executeSqliteQuerySync(db, kysely.insertInto("user_profiles").values(row));
      executeSqliteQuerySync(
        db,
        kysely.insertInto("user_profile_identities").values({
          provider: params.provider,
          subject: params.subject,
          profile_id: profileId,
          canonical_login: null,
          created_at: now,
        }),
      );
      return toUserProfile(row);
    },
    params.options,
    { operationLabel: "user-profiles.ensure-identity" },
  );
}

function adoptDisplayNameIfEmpty(
  profileId: string,
  displayName: string | null,
  options: OpenClawStateDatabaseOptions,
): UserProfile {
  if (!displayName) {
    const { db } = openOpenClawStateDatabase(options);
    return toUserProfile(requireResolvedUserProfileById(db, profileId));
  }
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileById(db, profileId);
      if (profile.display_name !== null) {
        return toUserProfile(profile);
      }
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ display_name: displayName, updated_at: now })
          .where("id", "=", profile.id),
      );
      return toUserProfile({ ...profile, display_name: displayName, updated_at: now });
    },
    options,
    { operationLabel: "user-profiles.adopt-display-name" },
  );
}

async function adoptAvatarIfEmpty(params: {
  profileId: string;
  profilePic: string | undefined;
  options: OpenClawStateDatabaseOptions;
  fetchOptions: TailscaleAvatarFetchOptions;
}): Promise<UserProfile> {
  const { db } = openOpenClawStateDatabase(params.options);
  const beforeFetch = requireResolvedUserProfileById(db, params.profileId);
  if (beforeFetch.avatar !== null || !params.profilePic) {
    return toUserProfile(beforeFetch);
  }
  const avatar = await fetchTailscaleAvatar(params.profilePic, params.fetchOptions);
  if (!avatar) {
    return toUserProfile(requireResolvedUserProfileById(db, params.profileId));
  }
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db: transactionDb }) => {
      const profile = requireResolvedUserProfileById(transactionDb, params.profileId);
      if (profile.avatar !== null) {
        return toUserProfile(profile);
      }
      const sha256 = createHash("sha256").update(avatar.bytes).digest("hex");
      executeSqliteQuerySync(
        transactionDb,
        userProfilesDb(transactionDb)
          .updateTable("user_profiles")
          .set({
            avatar: avatar.bytes,
            avatar_mime: avatar.mime,
            avatar_sha256: sha256,
            updated_at: now,
          })
          .where("id", "=", profile.id),
      );
      return toUserProfile({
        ...profile,
        avatar: avatar.bytes,
        avatar_mime: avatar.mime,
        avatar_sha256: sha256,
        updated_at: now,
      });
    },
    params.options,
    { operationLabel: "user-profiles.adopt-avatar" },
  );
}

/** Resolves a verified Tailscale login and adopts its display name into an empty field. */
export function ensureProfileForTailscaleIdentity(
  identity: TailscaleProfileIdentity,
  options: OpenClawStateDatabaseOptions = {},
): UserProfile {
  const classified = classifyTailscaleLogin(identity.login);
  if (classified.kind === "invalid") {
    throw new TypeError("Tailscale login must contain a nonempty subject and suffix");
  }
  const displayName = normalizeInitialDisplayName(identity.name);
  const resolved =
    classified.kind === "email"
      ? ensureProfileForEmailWithInitialName(classified.email, displayName, options)
      : ensureProfileForProviderIdentity({
          provider: classified.provider,
          subject: classified.subject,
          initialDisplayName: displayName,
          options,
        });
  return adoptDisplayNameIfEmpty(resolved.id, displayName, options);
}

/** Best-effort avatar adoption runs after authentication so remote I/O cannot delay login. */
export async function adoptTailscaleProfileAvatar(
  profileId: string,
  profilePic: string | undefined,
  options: OpenClawStateDatabaseOptions = {},
  fetchOptions: TailscaleAvatarFetchOptions = {},
): Promise<UserProfile> {
  return await adoptAvatarIfEmpty({
    profileId,
    profilePic,
    options,
    fetchOptions,
  });
}

/** Links an email to a profile and retains an aliasless prior profile as a merge tombstone. */
export function linkEmail(
  email: string,
  targetProfileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  const normalizedEmail = normalizeEmail(email);
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = userProfilesDb(db);
      const target = requireResolvedUserProfileById(db, targetProfileId);
      const existingAlias = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("profile_id")
          .where("email", "=", normalizedEmail),
      );
      if (!existingAlias) {
        executeSqliteQuerySync(
          db,
          kysely.insertInto("user_profile_emails").values({
            email: normalizedEmail,
            profile_id: target.id,
            created_at: now,
          }),
        );
        executeSqliteQuerySync(
          db,
          kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", target.id),
        );
        return selectUserProfileListItemById(db, target.id);
      }
      if (existingAlias.profile_id === target.id) {
        return selectUserProfileListItemById(db, target.id);
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("user_profile_emails")
          .set({ profile_id: target.id })
          .where("email", "=", normalizedEmail),
      );
      const remainingAliases = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("email")
          .where("profile_id", "=", existingAlias.profile_id),
      ).rows;
      executeSqliteQuerySync(
        db,
        kysely.updateTable("user_profiles").set({ updated_at: now }).where("id", "=", target.id),
      );
      if (remainingAliases.length === 0) {
        const mergeSourceIds = [
          existingAlias.profile_id,
          ...executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("user_profiles")
              .select("id")
              .where("merged_into", "=", existingAlias.profile_id),
          ).rows.map((row) => row.id),
        ];
        for (const sourceProfileId of mergeSourceIds) {
          mergeUserPreferences(db, sourceProfileId, target.id);
        }
        mergeUserProfileGitHubIdentity(db, mergeSourceIds, target.id);
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profile_identities")
            .set({ profile_id: target.id })
            .where("profile_id", "in", mergeSourceIds),
        );
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ merged_into: target.id, updated_at: now })
            .where("id", "=", existingAlias.profile_id),
        );
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ merged_into: target.id, updated_at: now })
            .where("merged_into", "=", existingAlias.profile_id),
        );
      } else {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("user_profiles")
            .set({ updated_at: now })
            .where("id", "=", existingAlias.profile_id),
        );
      }
      return selectUserProfileListItemById(db, target.id);
    },
    options,
    { operationLabel: "user-profiles.link-email" },
  );
}

export function setDisplayName(
  profileId: string,
  name: string | null,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  const now = Date.now();
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileById(db, profileId);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ display_name: name, updated_at: now })
          .where("id", "=", profile.id),
      );
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-display-name" },
  );
}

export function setGitHubIdentity(
  profileId: string,
  identity: { accountId: number; login: string },
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  const canonicalProfileId = setUserProfileGitHubIdentity(profileId, identity, options);
  return selectUserProfileListItemById(openOpenClawStateDatabase(options).db, canonicalProfileId);
}

export function clearGitHubIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  const canonicalProfileId = clearUserProfileGitHubIdentity(profileId, options);
  return selectUserProfileListItemById(openOpenClawStateDatabase(options).db, canonicalProfileId);
}

/** Stores a bounded, allowlisted avatar without ever leaving the write transaction async. */
export function setAvatar(
  profileId: string,
  bytes: Uint8Array,
  mime: string,
  options: OpenClawStateDatabaseOptions = {},
): Result<UserProfileListItem, UserProfileAvatarError> {
  if (bytes.byteLength > MAX_USER_PROFILE_AVATAR_BYTES) {
    return err({ code: "avatar_too_large", maxBytes: MAX_USER_PROFILE_AVATAR_BYTES });
  }
  if (!USER_PROFILE_AVATAR_MIME_TYPES.includes(mime as UserProfileAvatarMime)) {
    return err({ code: "unsupported_avatar_mime", mime });
  }
  const now = Date.now();
  ensureUserProfilesSchema(options);
  const value = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedUserProfileById(db, profileId);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ avatar: bytes, avatar_mime: mime, avatar_sha256: sha256, updated_at: now })
          .where("id", "=", profile.id),
      );
      return selectUserProfileListItemById(db, profile.id);
    },
    options,
    { operationLabel: "user-profiles.set-avatar" },
  );
  return ok(value);
}
