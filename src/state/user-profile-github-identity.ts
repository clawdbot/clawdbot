import type { DatabaseSync } from "node:sqlite";
import type { UserProfileGitHubIdentity } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  requireResolvedUserProfileById,
  selectResolvedUserProfileById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";

const GITHUB_ATTRIBUTION_PROVIDER = "github-attribution";

type UserProfileGitHubAttributionIdentity = {
  accountId: number;
  login: string;
};

export class UserProfileGitHubIdentityConflictError extends Error {
  constructor() {
    super("this GitHub account is already linked to another OpenClaw profile");
    this.name = "UserProfileGitHubIdentityConflictError";
  }
}

function parseStoredGitHubIdentity(row: {
  subject: string | null | undefined;
  canonical_login: string | null | undefined;
}): UserProfileGitHubAttributionIdentity | null {
  const accountId = Number(row.subject);
  const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
  return login && Number.isSafeInteger(accountId) && accountId > 0 ? { accountId, login } : null;
}

function toPublicGitHubIdentity(
  identity: UserProfileGitHubAttributionIdentity | null,
): UserProfileGitHubIdentity | null {
  if (!identity) {
    return null;
  }
  return {
    login: identity.login,
    profileUrl: `https://github.com/${identity.login}`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${identity.accountId}?v=4`,
  };
}

export function selectUserProfileGitHubIdentities(
  db: DatabaseSync,
  profileIds?: readonly string[],
): Map<string, UserProfileGitHubIdentity> {
  let query = userProfilesDb(db)
    .selectFrom("user_profile_identities")
    .select(["profile_id", "subject", "canonical_login"])
    .where("provider", "=", GITHUB_ATTRIBUTION_PROVIDER)
    .where("canonical_login", "is not", null);
  if (profileIds) {
    query = query.where("profile_id", "in", [...profileIds]);
  }
  const rows = executeSqliteQuerySync(db, query).rows;
  return new Map(
    rows.flatMap((row) => {
      const identity = toPublicGitHubIdentity(parseStoredGitHubIdentity(row));
      return identity ? [[row.profile_id, identity] as const] : [];
    }),
  );
}

/** Resolves a bounded profile snapshot and its internal Git attribution in two batched reads. */
export function resolveUserProfileGitHubAttribution(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Map<string, UserProfileGitHubAttributionIdentity | null> {
  if (profileIds.length === 0) {
    return new Map();
  }
  const database = openOpenClawStateDatabase(options);
  ensureUserProfilesSchema(options, database);
  const { db } = database;
  const kysely = userProfilesDb(db);
  const sources = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profiles")
      .select(["id", "merged_into"])
      .where("id", "in", [...profileIds]),
  ).rows;
  const canonicalBySource = new Map(
    sources.map((profile) => [profile.id, profile.merged_into ?? profile.id] as const),
  );
  const canonicalIds = [...new Set(canonicalBySource.values())];
  const canonicalRows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profiles as profile")
      .leftJoin("user_profile_identities as identity", (join) =>
        join
          .onRef("identity.profile_id", "=", "profile.id")
          .on("identity.provider", "=", GITHUB_ATTRIBUTION_PROVIDER),
      )
      .select([
        "profile.id as profile_id",
        "identity.subject as subject",
        "identity.canonical_login as canonical_login",
      ])
      .where("profile.id", "in", canonicalIds),
  ).rows;
  const identityByCanonical = new Map(
    canonicalRows.map((row) => [row.profile_id, parseStoredGitHubIdentity(row)] as const),
  );
  return new Map(
    [...canonicalBySource].flatMap(([sourceId, canonicalId]) =>
      identityByCanonical.has(canonicalId)
        ? [[sourceId, identityByCanonical.get(canonicalId) ?? null] as const]
        : [],
    ),
  );
}

export function mergeUserProfileGitHubIdentity(
  db: DatabaseSync,
  sourceProfileIds: readonly string[],
  targetProfileId: string,
): void {
  const kysely = userProfilesDb(db);
  if (!selectUserProfileGitHubIdentities(db, [targetProfileId]).has(targetProfileId)) {
    return;
  }
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("user_profile_identities")
      .where("provider", "=", GITHUB_ATTRIBUTION_PROVIDER)
      .where("profile_id", "in", sourceProfileIds)
      .where("canonical_login", "is not", null),
  );
}

function mutateUserProfileGitHubIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions,
  operationLabel: string,
  mutate: (db: DatabaseSync, canonicalProfileId: string, now: number) => void,
): string {
  ensureUserProfilesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const canonicalProfileId = requireResolvedUserProfileById(db, profileId).id;
      const now = Date.now();
      mutate(db, canonicalProfileId, now);
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .updateTable("user_profiles")
          .set({ updated_at: now })
          .where("id", "=", canonicalProfileId),
      );
      return canonicalProfileId;
    },
    options,
    { operationLabel },
  );
}

export function setUserProfileGitHubIdentity(
  profileId: string,
  identity: { accountId: number; login: string },
  options: OpenClawStateDatabaseOptions,
): string {
  if (!Number.isSafeInteger(identity.accountId) || identity.accountId <= 0) {
    throw new TypeError("GitHub account id must be a positive safe integer");
  }
  const login = normalizeGitHubLogin(identity.login);
  if (!login) {
    throw new TypeError("GitHub login is invalid");
  }
  return mutateUserProfileGitHubIdentity(
    profileId,
    options,
    "user-profiles.set-github-identity",
    (db, canonicalProfileId, now) => {
      const kysely = userProfilesDb(db);
      const subject = String(identity.accountId);
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("user_profile_identities")
          .select("profile_id")
          .where("provider", "=", GITHUB_ATTRIBUTION_PROVIDER)
          .where("subject", "=", subject),
      );
      if (
        existing &&
        selectResolvedUserProfileById(db, existing.profile_id)?.id !== canonicalProfileId
      ) {
        throw new UserProfileGitHubIdentityConflictError();
      }
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("user_profile_identities")
          .where("provider", "=", GITHUB_ATTRIBUTION_PROVIDER)
          .where("profile_id", "=", canonicalProfileId)
          .where("canonical_login", "is not", null),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("user_profile_identities")
          .values({
            provider: GITHUB_ATTRIBUTION_PROVIDER,
            subject,
            profile_id: canonicalProfileId,
            canonical_login: login,
            created_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["provider", "subject"]).doUpdateSet({
              profile_id: canonicalProfileId,
              canonical_login: login,
            }),
          ),
      );
    },
  );
}

export function clearUserProfileGitHubIdentity(
  profileId: string,
  options: OpenClawStateDatabaseOptions,
): string {
  return mutateUserProfileGitHubIdentity(
    profileId,
    options,
    "user-profiles.clear-github-identity",
    (db, canonicalProfileId) => {
      executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .deleteFrom("user_profile_identities")
          .where("provider", "=", GITHUB_ATTRIBUTION_PROVIDER)
          .where("profile_id", "=", canonicalProfileId)
          .where("canonical_login", "is not", null),
      );
    },
  );
}
