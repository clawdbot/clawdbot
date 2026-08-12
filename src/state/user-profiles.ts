import { createHash } from "node:crypto";
// Durable user profiles plus typed login identities in the shared state DB.
import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { mergeUserPreferences } from "./user-preferences.js";
import { USER_PROFILES_SCHEMA_SQL } from "./user-profiles-schema.js";
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
  hasAvatar: boolean;
};

type UserProfileAvatar = {
  bytes: Uint8Array;
  mime: UserProfileAvatarMime;
  sha256: string;
  updatedAt: number;
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

export function formatUserProfileAvatarEtag(sha256: string, mime: UserProfileAvatarMime): string {
  return `"${sha256}-${mime.slice("image/".length)}"`;
}

export class UserProfileNotFoundError extends Error {
  constructor(profileId: string) {
    super(`user profile not found: ${profileId}`);
    this.name = "UserProfileNotFoundError";
  }
}

export type UserProfilesDatabase = {
  user_profiles: {
    id: string;
    display_name: string | null;
    avatar: Uint8Array | null;
    avatar_mime: string | null;
    avatar_sha256: string | null;
    merged_into: string | null;
    created_at: number;
    updated_at: number;
  };
  user_profile_emails: {
    email: string;
    profile_id: string;
    created_at: number;
  };
  user_profile_identities: {
    provider: string;
    subject: string;
    profile_id: string;
    created_at: number;
  };
};

type UserProfileRow = UserProfilesDatabase["user_profiles"];
type UserProfileListRow = Pick<
  UserProfileRow,
  "id" | "display_name" | "avatar_mime" | "merged_into" | "created_at" | "updated_at"
> & {
  has_avatar: unknown;
};

const ensuredDatabases = new WeakSet<DatabaseSync>();
const MAX_USER_PROFILE_DISPLAY_NAME_LENGTH = 256;

function profileDb(db: DatabaseSync) {
  return getNodeSqliteKysely<UserProfilesDatabase>(db);
}

export function ensureUserProfilesSchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(USER_PROFILES_SCHEMA_SQL);
    },
    options,
    { operationLabel: "user-profiles.schema.ensure" },
  );
  // Mark ensured only after the transaction commits; a rolled-back ensure must
  // retry the DDL on the next call instead of failing "no such table" forever.
  ensuredDatabases.add(database.db);
}

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

function toAvatarMime(value: string | null): UserProfileAvatarMime | null {
  return USER_PROFILE_AVATAR_MIME_TYPES.includes(value as UserProfileAvatarMime)
    ? (value as UserProfileAvatarMime)
    : null;
}

function toUserProfile(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarMime: toAvatarMime(row.avatar_mime),
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUserProfileListItem(row: UserProfileListRow, emails: string[]): UserProfileListItem {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarMime: toAvatarMime(row.avatar_mime),
    mergedInto: row.merged_into,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    emails,
    hasAvatar: row.has_avatar === 1,
  };
}

function hasAvatarColumn() {
  return sql`CASE WHEN avatar IS NULL THEN 0 ELSE 1 END`.as("has_avatar");
}

function selectUserProfileListItemById(db: DatabaseSync, profileId: string): UserProfileListItem {
  const kysely = profileDb(db);
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
  );
}

function selectProfileById(db: DatabaseSync, profileId: string): UserProfileRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    profileDb(db).selectFrom("user_profiles").selectAll().where("id", "=", profileId),
  );
}

function selectResolvedProfileById(
  db: DatabaseSync,
  profileId: string,
): UserProfileRow | undefined {
  const profile = selectProfileById(db, profileId);
  if (!profile?.merged_into) {
    return profile;
  }
  // Every merge re-points aliases and tombstones targeting its source, so this
  // one hop preserves durable references while the stored chain stays depth one.
  return selectProfileById(db, profile.merged_into) ?? profile;
}

function requireResolvedProfileById(db: DatabaseSync, profileId: string): UserProfileRow {
  const profile = selectResolvedProfileById(db, profileId);
  if (!profile) {
    throw new UserProfileNotFoundError(profileId);
  }
  return profile;
}

/** Resolves a durable profile reference to its current one-hop merge head. */
export function resolveUserProfileId(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return selectResolvedProfileById(db, profileId)?.id;
}

/** Reads a profile's protocol-facing representation through its merge head. */
export function getUserProfileListItem(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileListItem {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  return selectUserProfileListItemById(db, requireResolvedProfileById(db, profileId).id);
}

/** Reads merge-aware display data without exposing avatar content through list/RPC shapes. */
export function getUserProfileDisplay(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileDisplay {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profile = requireResolvedProfileById(db, profileId);
  const avatarMime = toAvatarMime(profile.avatar_mime);
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
      const kysely = profileDb(db);
      const existingAlias = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_emails")
          .select("profile_id")
          .where("email", "=", normalizedEmail),
      );
      if (existingAlias) {
        return toUserProfile(requireResolvedProfileById(db, existingAlias.profile_id));
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
      const kysely = profileDb(db);
      const existingIdentity = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select("profile_id")
          .where("provider", "=", params.provider)
          .where("subject", "=", params.subject),
      );
      if (existingIdentity) {
        return toUserProfile(requireResolvedProfileById(db, existingIdentity.profile_id));
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
    return toUserProfile(requireResolvedProfileById(db, profileId));
  }
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const profile = requireResolvedProfileById(db, profileId);
      if (profile.display_name !== null) {
        return toUserProfile(profile);
      }
      executeSqliteQuerySync(
        db,
        profileDb(db)
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
  const beforeFetch = requireResolvedProfileById(db, params.profileId);
  if (beforeFetch.avatar !== null || !params.profilePic) {
    return toUserProfile(beforeFetch);
  }
  const avatar = await fetchTailscaleAvatar(params.profilePic, params.fetchOptions);
  if (!avatar) {
    return toUserProfile(requireResolvedProfileById(db, params.profileId));
  }
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db: transactionDb }) => {
      const profile = requireResolvedProfileById(transactionDb, params.profileId);
      if (profile.avatar !== null) {
        return toUserProfile(profile);
      }
      const sha256 = createHash("sha256").update(avatar.bytes).digest("hex");
      executeSqliteQuerySync(
        transactionDb,
        profileDb(transactionDb)
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
      const kysely = profileDb(db);
      const target = requireResolvedProfileById(db, targetProfileId);
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
      const profile = requireResolvedProfileById(db, profileId);
      executeSqliteQuerySync(
        db,
        profileDb(db)
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
      const profile = requireResolvedProfileById(db, profileId);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      executeSqliteQuerySync(
        db,
        profileDb(db)
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

export function getProfileAvatar(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAvatar | undefined {
  ensureUserProfilesSchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const profile = selectResolvedProfileById(db, profileId);
  if (!profile?.avatar || !profile.avatar_mime || !profile.avatar_sha256) {
    return undefined;
  }
  const mime = toAvatarMime(profile.avatar_mime);
  return mime
    ? { bytes: profile.avatar, mime, sha256: profile.avatar_sha256, updatedAt: profile.updated_at }
    : undefined;
}

export function listProfiles(options: OpenClawStateDatabaseOptions = {}): UserProfileListItem[] {
  ensureUserProfilesSchema(options);
  const database = openOpenClawStateDatabase(options);
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const kysely = profileDb(database.db);
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
            hasAvatarColumn(),
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
      const emailsByProfile = new Map<string, string[]>();
      for (const email of emails) {
        const list = emailsByProfile.get(email.profile_id) ?? [];
        list.push(email.email);
        emailsByProfile.set(email.profile_id, list);
      }
      return profiles.map((profile) =>
        toUserProfileListItem(profile, emailsByProfile.get(profile.id) ?? []),
      );
    },
    { databaseLabel: database.path, operationLabel: "user-profiles.list" },
  );
}
