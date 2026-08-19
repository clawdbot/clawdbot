import type { DatabaseSync } from "node:sqlite";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/users.js";
import type { UserProfileGitHubIdentity } from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { mutateUserPreference, selectUserPreferenceValues } from "./user-preferences.js";
import {
  requireResolvedUserProfileById,
  selectResolvedUserProfileById,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";

const GITHUB_PROVIDER = "github";
const LEGACY_GITHUB_ATTRIBUTION_PROVIDER = "github-attribution";
const GITHUB_LOGIN_SUBJECT_PREFIX = "login:";

type StoredGitHubIdentity = {
  accountId: number;
  login: string;
};

function parseStoredGitHubIdentity(row: {
  subject: string | null | undefined;
  canonical_login: string | null | undefined;
}): StoredGitHubIdentity | null {
  const accountId = Number(row.subject);
  const login = row.canonical_login ? normalizeGitHubLogin(row.canonical_login) : undefined;
  return login && Number.isSafeInteger(accountId) && accountId > 0 ? { accountId, login } : null;
}

function toPublicGitHubIdentity(identity: StoredGitHubIdentity): UserProfileGitHubIdentity {
  return {
    login: identity.login,
    profileUrl: `https://github.com/${identity.login}`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${identity.accountId}?v=4`,
  };
}

function selectStoredGitHubIdentities(
  db: DatabaseSync,
  profileIds?: readonly string[],
): Map<string, StoredGitHubIdentity> {
  if (profileIds?.length === 0) {
    return new Map();
  }
  let query = userProfilesDb(db)
    .selectFrom("user_profile_identities")
    .select(["profile_id", "subject", "canonical_login"])
    .where("provider", "=", GITHUB_PROVIDER)
    .where("canonical_login", "is not", null);
  if (profileIds) {
    query = query.where("profile_id", "in", [...profileIds]);
  }
  const rows = executeSqliteQuerySync(db, query).rows;
  return new Map(
    rows.flatMap((row) => {
      const identity = parseStoredGitHubIdentity(row);
      return identity ? [[row.profile_id, identity] as const] : [];
    }),
  );
}

function deleteProfileGitHubIdentities(
  db: DatabaseSync,
  profileIds: readonly string[],
  keepSubject?: string,
): void {
  if (profileIds.length === 0) {
    return;
  }
  let query = userProfilesDb(db)
    .deleteFrom("user_profile_identities")
    .where("provider", "=", GITHUB_PROVIDER)
    .where("profile_id", "in", [...profileIds])
    .where("canonical_login", "is not", null);
  if (keepSubject) {
    query = query.where("subject", "!=", keepSubject);
  }
  executeSqliteQuerySync(db, query);
}

export function githubAuthenticationSubject(login: string): string {
  const normalized = login.trim().toLowerCase();
  if (!normalized) {
    throw new TypeError("GitHub login is invalid");
  }
  // Login aliases and immutable numeric account IDs share one SQLite keyspace.
  return `${GITHUB_LOGIN_SUBJECT_PREFIX}${normalized}`;
}

export function selectUserProfileGitHubIdentities(
  db: DatabaseSync,
  profileIds?: readonly string[],
): Map<string, UserProfileGitHubIdentity> {
  return new Map(
    [...selectStoredGitHubIdentities(db, profileIds)].map(([profileId, identity]) => [
      profileId,
      toPublicGitHubIdentity(identity),
    ]),
  );
}

/** Resolves bounded participants only when verified identity and public credit opt-in agree. */
export function resolveUserProfileGitHubAttribution(
  profileIds: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Map<string, StoredGitHubIdentity | null> {
  if (profileIds.length === 0) {
    return new Map();
  }
  const database = openOpenClawStateDatabase(options);
  ensureUserProfilesSchema(options, database);
  const { db } = database;
  const profiles = executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .selectFrom("user_profiles")
      .select(["id", "merged_into"])
      .where("id", "in", [...profileIds]),
  ).rows;
  const canonicalBySource = new Map(
    profiles.map((profile) => [profile.id, profile.merged_into ?? profile.id] as const),
  );
  const canonicalIds = [...new Set(canonicalBySource.values())];
  const identities = selectStoredGitHubIdentities(db, canonicalIds);
  const preferences = selectUserPreferenceValues(db, canonicalIds, GIT_COAUTHOR_PREFERENCE_KEY);
  return new Map(
    [...canonicalBySource].map(([sourceId, canonicalId]) => [
      sourceId,
      preferences.get(canonicalId) === true ? (identities.get(canonicalId) ?? null) : null,
    ]),
  );
}

/** Keeps GitHub consent attached only to the immutable account that survives a profile merge. */
export function prepareUserProfileGitHubMerge(
  db: DatabaseSync,
  sourceProfileIds: readonly string[],
  targetProfileId: string,
): void {
  const identities = selectStoredGitHubIdentities(db, [targetProfileId, ...sourceProfileIds]);
  const targetIdentity = identities.get(targetProfileId);
  const survivingSourceProfileId = targetIdentity
    ? undefined
    : sourceProfileIds.find((profileId) => identities.has(profileId));
  const survivingAccountId =
    targetIdentity?.accountId ??
    (survivingSourceProfileId ? identities.get(survivingSourceProfileId)?.accountId : undefined);
  for (const sourceProfileId of sourceProfileIds) {
    const sourceIdentity = identities.get(sourceProfileId);
    if (!sourceIdentity || sourceIdentity.accountId !== survivingAccountId) {
      mutateUserPreference(db, sourceProfileId, GIT_COAUTHOR_PREFERENCE_KEY);
    }
  }
  deleteProfileGitHubIdentities(
    db,
    sourceProfileIds.filter((profileId) => profileId !== survivingSourceProfileId),
  );
}

export function applyVerifiedGitHubIdentity(params: {
  db: DatabaseSync;
  profileId: string;
  identity: { accountId: number; login: string };
  mergeProfiles: (sourceProfileId: string, targetProfileId: string) => void;
}): string {
  if (!Number.isSafeInteger(params.identity.accountId) || params.identity.accountId <= 0) {
    throw new TypeError("GitHub account id must be a positive safe integer");
  }
  const login = normalizeGitHubLogin(params.identity.login);
  if (!login) {
    throw new TypeError("GitHub login is invalid");
  }
  const db = params.db;
  const kysely = userProfilesDb(db);
  const currentProfileId = requireResolvedUserProfileById(db, params.profileId).id;
  const subject = String(params.identity.accountId);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("user_profile_identities")
      .select("profile_id")
      .where("provider", "=", GITHUB_PROVIDER)
      .where("subject", "=", subject)
      .where("canonical_login", "is not", null),
  );
  const targetProfileId = existing
    ? (selectResolvedUserProfileById(db, existing.profile_id)?.id ?? currentProfileId)
    : currentProfileId;
  const currentIdentity = selectStoredGitHubIdentities(db, [currentProfileId]).get(
    currentProfileId,
  );
  if (
    targetProfileId === currentProfileId &&
    currentIdentity?.accountId !== params.identity.accountId
  ) {
    mutateUserPreference(db, targetProfileId, GIT_COAUTHOR_PREFERENCE_KEY);
  }

  const migrationProfileIds = [...new Set([currentProfileId, targetProfileId])];
  const legacyRows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("user_profile_identities")
      .select(["profile_id", "subject", "canonical_login"])
      .where("provider", "=", LEGACY_GITHUB_ATTRIBUTION_PROVIDER)
      .where("profile_id", "in", migrationProfileIds),
  ).rows;
  const legacyOptIn = legacyRows.some(
    (row) => parseStoredGitHubIdentity(row)?.accountId === params.identity.accountId,
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("user_profile_identities")
      .where("provider", "=", LEGACY_GITHUB_ATTRIBUTION_PROVIDER)
      .where("profile_id", "in", migrationProfileIds),
  );
  if (
    legacyOptIn &&
    !selectUserPreferenceValues(db, [targetProfileId], GIT_COAUTHOR_PREFERENCE_KEY).has(
      targetProfileId,
    )
  ) {
    mutateUserPreference(db, targetProfileId, GIT_COAUTHOR_PREFERENCE_KEY, true);
  }

  if (currentProfileId !== targetProfileId) {
    params.mergeProfiles(currentProfileId, targetProfileId);
  }
  deleteProfileGitHubIdentities(db, [targetProfileId], subject);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("user_profile_identities")
      .values({
        provider: GITHUB_PROVIDER,
        subject,
        profile_id: targetProfileId,
        canonical_login: login,
        created_at: Date.now(),
      })
      .onConflict((conflict) =>
        conflict.columns(["provider", "subject"]).doUpdateSet({
          profile_id: targetProfileId,
          canonical_login: login,
        }),
      ),
  );
  return targetProfileId;
}
