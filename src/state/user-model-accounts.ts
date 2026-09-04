import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { inlineAuthProfileCredentialSchema } from "../agents/auth-profiles/credential-schema.js";
import { coerceProfileUsageStats } from "../agents/auth-profiles/profile-usage-stats.js";
import type { AuthProfileCredential, ProfileUsageStats } from "../agents/auth-profiles/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { SECRET_STORE_VALUE_MAX_BYTES } from "../secrets/store/secret-store-validation-error.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { ensureSecretStoreSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { isUserModelAuthProfileId, parseUserModelAuthProfileId } from "./user-model-account-id.js";
import { selectResolvedUserProfileById } from "./user-profiles-internal.js";

const credentialSchema = inlineAuthProfileCredentialSchema.refine(
  (credential) => credential.copyToAgents !== true,
  "Personal model accounts cannot be copied to agent stores.",
);
const linksSchema = z.strictObject({
  version: z.literal(1),
  links: z.record(
    z.string(),
    z.strictObject({ authProfileId: z.string().min(1), updatedAt: z.number() }).nullable(),
  ),
});
const profileSchema = z.strictObject({
  version: z.literal(1),
  credential: credentialSchema,
  usageStats: z.unknown().transform(coerceProfileUsageStats).optional(),
});
type UserModelLinks = z.infer<typeof linksSchema>;
type AccountRecordName = "model-accounts" | `model-account:${string}`;

export type UserModelAuthProfile = {
  credential: AuthProfileCredential;
  usageStats?: ProfileUsageStats;
};

export type UserProfileAuthLink = { provider: string; authProfileId: string; updatedAt: number };
export type UserModelAccount = {
  authProfileId: string;
  provider: string;
  label: string;
  authType: AuthProfileCredential["type"];
  selected: boolean;
};

const MODEL_ACCOUNTS_PAGE_SIZE = 50;

function invalidAccounts(): Error {
  return new Error("Personal model account state is invalid; restore a verified state backup.");
}

function parseRecord<T>(value: string, schema: z.ZodType<T>): T {
  if (Buffer.byteLength(value, "utf8") > SECRET_STORE_VALUE_MAX_BYTES) {
    throw invalidAccounts();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidAccounts();
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw invalidAccounts();
  }
  return result.data;
}

function resolveOwner(db: DatabaseSync, profileId: string): string | undefined {
  if (!tableExists(db, "user_profiles")) {
    return undefined;
  }
  const profile = selectResolvedUserProfileById(db, profileId);
  // Profile display reads may return a stranded tombstone; it cannot own secrets.
  return profile && !profile.merged_into ? profile.id : undefined;
}

function requireOwner(db: DatabaseSync, profileId: string): string {
  const owner = resolveOwner(db, profileId);
  if (!owner) {
    throw new Error("Personal model account owner is unavailable; refresh Profile and try again.");
  }
  return owner;
}

function readRecord(db: DatabaseSync, owner: string, name: AccountRecordName): string | undefined {
  if (!tableExists(db, "secret_store_entries")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
      .selectFrom("secret_store_entries")
      .select(["value", "kind", "allowed_hosts"])
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", owner)
      .where("name", "=", name)
      .where("deleted_at_ms", "is", null),
  );
  if (!row) {
    return undefined;
  }
  if (row.kind !== "secret" || row.allowed_hosts !== null) {
    throw invalidAccounts();
  }
  return row.value;
}

function writeRecord(
  db: DatabaseSync,
  owner: string,
  name: AccountRecordName,
  value: string,
): void {
  if (Buffer.byteLength(value, "utf8") > SECRET_STORE_VALUE_MAX_BYTES) {
    throw new Error("Personal model account entry exceeds the 64 KiB secret-store limit.");
  }
  ensureSecretStoreSchema(db);
  const now = Date.now();
  const mutable = {
    value,
    kind: "secret",
    allowed_hosts: null,
    deleted_at_ms: null,
    updated_at_ms: now,
    updated_by: null,
  };
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
      .insertInto("secret_store_entries")
      .values({
        scope_kind: "identity",
        scope_id: owner,
        name,
        created_at_ms: now,
        ...mutable,
      })
      .onConflict((conflict) =>
        conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet(mutable),
      ),
  );
}

function readLinks(db: DatabaseSync, owner: string): UserModelLinks {
  const raw = readRecord(db, owner, "model-accounts");
  return raw === undefined ? { version: 1, links: {} } : parseRecord(raw, linksSchema);
}

function writeLinks(db: DatabaseSync, owner: string, links: UserModelLinks): void {
  writeRecord(db, owner, "model-accounts", JSON.stringify(linksSchema.parse(links)));
}

function readProfile(
  db: DatabaseSync,
  owner: string,
  authProfileId: string,
): UserModelAuthProfile | undefined {
  if (!isUserModelAuthProfileId(authProfileId)) {
    return undefined;
  }
  const raw = readRecord(db, owner, `model-account:${authProfileId}`);
  if (raw === undefined) {
    return undefined;
  }
  const { credential, usageStats } = parseRecord(raw, profileSchema);
  if (credential.type === "oauth") {
    registerSecretValueForRedaction(credential.access);
    registerSecretValueForRedaction(credential.refresh);
    if (credential.idToken) {
      registerSecretValueForRedaction(credential.idToken);
    }
  } else if (credential.type === "token") {
    registerSecretValueForRedaction(credential.token);
  } else {
    registerSecretValueForRedaction(credential.key);
  }
  return { credential, usageStats };
}

function writeProfile(
  db: DatabaseSync,
  owner: string,
  authProfileId: string,
  profile: UserModelAuthProfile,
): void {
  const record = profileSchema.parse({ version: 1, ...profile });
  writeRecord(db, owner, `model-account:${authProfileId}`, JSON.stringify(record));
}

function accountLinks(record: UserModelLinks): UserProfileAuthLink[] {
  return Object.entries(record.links)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([provider, link]) => (link ? [{ provider, ...link }] : []));
}

function credentialOwner(db: DatabaseSync, authProfileId: string): string | undefined {
  const locator = parseUserModelAuthProfileId(authProfileId);
  return locator ? resolveOwner(db, locator.ownerProfileId) : undefined;
}

/** A locator identifies a record; only its current identity owner can newly select it. */
export function isUserModelAuthProfileOwner(
  params: { profileId: string; authProfileId: string },
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const owner = resolveOwner(db, params.profileId);
      if (
        !owner ||
        credentialOwner(db, params.authProfileId) !== owner ||
        !tableExists(db, "secret_store_entries")
      ) {
        return false;
      }
      return Boolean(
        executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
            .selectFrom("secret_store_entries")
            .select("name")
            .where("scope_kind", "=", "identity")
            .where("scope_id", "=", owner)
            .where("name", "=", `model-account:${params.authProfileId}`)
            .where("deleted_at_ms", "is", null),
        ),
      );
    }, options) ?? false
  );
}

function accountSummary(
  authProfileId: string,
  value: string,
  links: UserModelLinks,
): UserModelAccount {
  const { credential } = parseRecord(value, profileSchema);
  return {
    authProfileId,
    provider: credential.provider,
    label: (
      credential.displayName?.trim() ||
      credential.email?.trim() ||
      credential.provider
    ).slice(0, 256),
    authType: credential.type,
    selected: links.links[credential.provider]?.authProfileId === authProfileId,
  };
}

/** Owner-only control-plane inventory; runtime selection never enumerates private accounts. */
export function listUserModelAccounts(
  params: { profileId: string; cursor?: string },
  options: OpenClawStateDatabaseOptions = {},
): { accounts: UserModelAccount[]; nextCursor?: string } {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const owner = requireOwner(db, params.profileId);
      if (!tableExists(db, "secret_store_entries")) {
        return { accounts: [] };
      }
      const links = readLinks(db, owner);
      let query = getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db)
        .selectFrom("secret_store_entries")
        .select(["name", "value", "kind", "allowed_hosts"])
        .where("scope_kind", "=", "identity")
        .where("scope_id", "=", owner)
        .where("name", "like", "model-account:%")
        .where("deleted_at_ms", "is", null)
        .orderBy("name")
        .limit(MODEL_ACCOUNTS_PAGE_SIZE + 1);
      if (params.cursor) {
        query = query.where("name", ">", `model-account:${params.cursor}`);
      }
      const rows = executeSqliteQuerySync(db, query).rows;
      const accounts = rows.slice(0, MODEL_ACCOUNTS_PAGE_SIZE).map((row) => {
        if (row.kind !== "secret" || row.allowed_hosts !== null) {
          throw invalidAccounts();
        }
        return accountSummary(row.name.slice("model-account:".length), row.value, links);
      });
      const last = accounts.at(-1);
      return {
        accounts,
        ...(rows.length > MODEL_ACCOUNTS_PAGE_SIZE && last
          ? { nextCursor: last.authProfileId }
          : {}),
      };
    }, options) ?? { accounts: [] }
  );
}

export function readUserModelAccountSummary(
  params: { profileId: string; authProfileId: string },
  options: OpenClawStateDatabaseOptions = {},
): UserModelAccount | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    const owner = resolveOwner(db, params.profileId);
    if (!owner || credentialOwner(db, params.authProfileId) !== owner) {
      return undefined;
    }
    const value = readRecord(db, owner, `model-account:${params.authProfileId}`);
    return value === undefined
      ? undefined
      : accountSummary(params.authProfileId, value, readLinks(db, owner));
  }, options);
}

/** Only an explicitly selected credential is loaded; no personal account enumeration. */
export function readUserModelAuthProfile(
  authProfileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserModelAuthProfile | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    const owner = credentialOwner(db, authProfileId);
    return owner ? readProfile(db, owner, authProfileId) : undefined;
  }, options);
}

/** The canonical OAuth/usage owners mutate one exact private credential under the DB lock. */
export function updateUserModelAuthProfile(
  authProfileId: string,
  update: (profile: UserModelAuthProfile) => boolean,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = credentialOwner(db, authProfileId);
      const current = owner ? readProfile(db, owner, authProfileId) : undefined;
      if (!owner || !current) {
        return false;
      }
      const provider = current.credential.provider;
      if (!update(current)) {
        return false;
      }
      if (current.credential.provider !== provider) {
        throw new Error("A personal model account refresh cannot change its provider.");
      }
      writeProfile(db, owner, authProfileId, current);
      return true;
    },
    options,
    { operationLabel: "users.model-accounts.update" },
  );
}

/** Credential and selection commit together, after revalidating the live authorization. */
export function connectUserModelAccount(
  params: {
    ownerProfileId: string;
    credential: AuthProfileCredential;
    assertCurrent: () => void;
    matchesCredential?: (credential: AuthProfileCredential) => boolean;
  },
  options: OpenClawStateDatabaseOptions = {},
): { authProfileId: string; links: UserProfileAuthLink[] } {
  const credential = credentialSchema.parse(params.credential);
  const candidate = withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    const record = readLinks(db, params.ownerProfileId);
    const id = record.links[credential.provider]?.authProfileId;
    const profile = id ? readProfile(db, params.ownerProfileId, id) : undefined;
    return id && profile ? { id, credential: profile.credential } : undefined;
  }, options);
  // Provider identity comparison runs before BEGIN. The writer below only
  // replaces the exact credential and selection this comparison inspected.
  const replacement =
    candidate?.credential.provider === credential.provider &&
    params.matchesCredential?.(candidate.credential)
      ? candidate
      : undefined;
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = requireOwner(db, params.ownerProfileId);
      if (owner !== params.ownerProfileId) {
        throw new Error("Personal model account owner changed; refresh Profile and try again.");
      }
      const record = readLinks(db, owner);
      const canReplace =
        replacement &&
        record.links[credential.provider]?.authProfileId === replacement.id &&
        JSON.stringify(readProfile(db, owner, replacement.id)?.credential) ===
          JSON.stringify(replacement.credential);
      const authProfileId = canReplace ? replacement.id : `personal:${owner}:${randomUUID()}`;
      record.links[credential.provider] = { authProfileId, updatedAt: Date.now() };
      params.assertCurrent();
      writeProfile(db, owner, authProfileId, { credential });
      writeLinks(db, owner, record);
      return { authProfileId, links: accountLinks(record) };
    },
    options,
    { operationLabel: "users.model-accounts.connect" },
  );
}

export function listUserProfileAuthLinks(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAuthLink[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const owner = resolveOwner(db, profileId);
      return owner ? accountLinks(readLinks(db, owner)) : [];
    }, options) ?? []
  );
}

export function resolveUserProfileAuthLink(
  params: { profileId: string; providers: readonly string[] },
  options: OpenClawStateDatabaseOptions = {},
): string | undefined {
  const links = listUserProfileAuthLinks(params.profileId, options);
  for (const provider of params.providers) {
    const link = links.find((candidate) => candidate.provider === provider);
    if (link) {
      return link.authProfileId;
    }
  }
  return undefined;
}

export function setUserProfileAuthLink(
  params: {
    profileId: string;
    provider: string;
    authProfileId: string;
    assertCurrent?: () => void;
  },
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAuthLink[] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = requireOwner(db, params.profileId);
      const record = readLinks(db, owner);
      if (
        isUserModelAuthProfileId(params.authProfileId) &&
        (credentialOwner(db, params.authProfileId) !== owner ||
          readProfile(db, owner, params.authProfileId)?.credential.provider !== params.provider)
      ) {
        throw new Error("Personal model account does not belong to this profile and provider.");
      }
      record.links[params.provider] = {
        authProfileId: params.authProfileId,
        updatedAt: Date.now(),
      };
      params.assertCurrent?.();
      writeLinks(db, owner, record);
      return accountLinks(record);
    },
    options,
    { operationLabel: "users.model-accounts.link" },
  );
}

export function clearUserProfileAuthLink(
  params: { profileId: string; provider: string; assertCurrent?: () => void },
  options: OpenClawStateDatabaseOptions = {},
): UserProfileAuthLink[] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = requireOwner(db, params.profileId);
      const record = readLinks(db, owner);
      // Keep an explicit disconnect so a later identity merge cannot resurrect a link.
      // Existing sessions retain their exact credential; new sessions use shared defaults.
      record.links[params.provider] = null;
      params.assertCurrent?.();
      writeLinks(db, owner, record);
      return accountLinks(record);
    },
    options,
    { operationLabel: "users.model-accounts.unlink" },
  );
}

/** Transfer only the current live source; never adopt secrets stranded on old aliases. */
export function mergeUserModelAccounts(db: DatabaseSync, source: string, target: string): void {
  if (!tableExists(db, "secret_store_entries")) {
    return;
  }
  if (requireOwner(db, source) !== source || requireOwner(db, target) !== target) {
    throw new Error("Personal model account merge requires current profile owners.");
  }
  const sourceRecord = readLinks(db, source);
  const targetRecord = readLinks(db, target);
  if (Object.keys(sourceRecord.links).length > 0) {
    writeLinks(db, target, {
      version: 1,
      links: { ...sourceRecord.links, ...targetRecord.links },
    });
  }
  const query = getNodeSqliteKysely<Pick<DB, "secret_store_entries">>(db);
  // Keep exact credential IDs for old session pins without loading every token
  // into memory or combining individually bounded secrets into one larger value.
  executeSqliteQuerySync(
    db,
    query
      .insertInto("secret_store_entries")
      .columns([
        "scope_kind",
        "scope_id",
        "name",
        "value",
        "kind",
        "allowed_hosts",
        "created_at_ms",
        "updated_at_ms",
        "updated_by",
        "deleted_at_ms",
      ])
      .expression(
        query
          .selectFrom("secret_store_entries")
          .select((eb) => [
            "scope_kind",
            eb.val(target).as("scope_id"),
            "name",
            "value",
            "kind",
            "allowed_hosts",
            "created_at_ms",
            "updated_at_ms",
            "updated_by",
            "deleted_at_ms",
          ])
          .where("scope_kind", "=", "identity")
          .where("scope_id", "=", source)
          .where("name", "like", "model-account:%"),
      )
      .onConflict((conflict) => conflict.columns(["scope_kind", "scope_id", "name"]).doNothing()),
  );
  executeSqliteQuerySync(
    db,
    query
      .deleteFrom("secret_store_entries")
      .where("scope_kind", "=", "identity")
      .where("scope_id", "=", source)
      .where((eb) =>
        eb.or([eb("name", "=", "model-accounts"), eb("name", "like", "model-account:%")]),
      ),
  );
}
