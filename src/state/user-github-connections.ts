import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  PersonalGitHubStateError,
  readPersonalGitHubSecret,
  writePersonalGitHubSecret,
} from "../secrets/store/secret-store-hidden-github.js";
import {
  githubOAuthTimestamp as timestamp,
  githubOAuthSecret as secret,
  githubOAuthProfileId as profileId,
  githubOAuthScopes as scopes,
  githubOAuthRefreshFields,
  githubOAuthDeviceFields,
  validGitHubDeviceTiming,
} from "../shared/github-oauth-values.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { selectResolvedUserProfileById } from "./user-profiles-internal.js";
import type { UserProfilesDatabase } from "./user-profiles-schema.js";

const tokenPair = z.strictObject({
  accessToken: secret,
  refreshToken: secret,
  tokenType: z.literal("bearer"),
  scopes,
  expiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
  refreshTokenExpiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
});
const deviceFields = {
  requestId: z.string().uuid(),
  createdAtMs: timestamp,
  expiresAtMs: timestamp,
};
const device = z.strictObject({
  ...deviceFields,
  kind: z.literal("device"),
  ...githubOAuthDeviceFields,
  candidate: z.strictObject({ profileId, tokens: tokenPair, receivedAtMs: timestamp }).optional(),
});
const connected = z.strictObject({
  kind: z.literal("connected"),
  profileId,
  ...githubOAuthRefreshFields,
  refreshFailure: z.enum(["expired", "failed"]).optional(),
  refresh: z
    .strictObject({
      operationId: z.string().uuid(),
      tokens: tokenPair.optional(),
      receivedAtMs: timestamp.optional(),
    })
    .optional(),
});
const connectionSchema = z
  .strictObject({
    version: z.literal(1),
    generation: z.string().uuid(),
    selection: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("disconnected") }),
      connected,
    ]),
    pending: z
      .discriminatedUnion("kind", [
        z.strictObject({ ...deviceFields, kind: z.literal("starting") }),
        device,
      ])
      .optional(),
  })
  .superRefine((record, ctx) => {
    const pending = record.pending;
    if (pending && !validGitHubDeviceTiming(pending)) {
      ctx.addIssue({ code: "custom", message: "Invalid device timing" });
    }
    const selection = record.selection;
    if (
      selection.kind === "connected" &&
      (selection.refreshExpiresAtMs <= selection.accessExpiresAtMs ||
        Boolean(selection.refresh?.tokens) !== (selection.refresh?.receivedAtMs !== undefined))
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid refresh state" });
    }
  });

export type UserGitHubConnection = z.infer<typeof connectionSchema>;
export type UserGitHubConnected = z.infer<typeof connected>;
export type UserGitHubDevice = z.infer<typeof device>;

const retirementObservers = new Set<(profileIds: readonly string[]) => void>();
export function observeUserGitHubProfileRetirement(
  observer: (profileIds: readonly string[]) => void,
): () => void {
  retirementObservers.add(observer);
  return () => {
    retirementObservers.delete(observer);
  };
}

function retireAfterCommit(db: DatabaseSync, ids: string[]): void {
  if (ids.length > 0) {
    deferSqlitePostCommitPublication(db, () => {
      for (const observer of retirementObservers) {
        observer(ids);
      }
    });
  }
}

function parseConnection(raw: string): UserGitHubConnection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PersonalGitHubStateError();
  }
  const result = connectionSchema.safeParse(parsed);
  if (!result.success) {
    throw new PersonalGitHubStateError();
  }
  const record = result.data;
  if (record.pending?.kind === "device") {
    registerSecretValueForRedaction(record.pending.deviceCode);
    if (record.pending.candidate) {
      registerTokens(record.pending.candidate.tokens);
    }
  }
  if (record.selection.kind === "connected") {
    registerSecretValueForRedaction(record.selection.refreshToken);
    if (record.selection.refresh?.tokens) {
      registerTokens(record.selection.refresh.tokens);
    }
  }
  return record;
}

function registerTokens(tokens: z.infer<typeof tokenPair>): void {
  registerSecretValueForRedaction(tokens.accessToken);
  registerSecretValueForRedaction(tokens.refreshToken);
}

/** Display fallback to a tombstone is never credential ownership. */
export function resolvePersonalGitHubOwner(
  profile: string,
  db = openOpenClawStateDatabase().db,
): string | undefined {
  if (!tableExists(db, "user_profiles")) {
    return undefined;
  }
  const resolved = selectResolvedUserProfileById(db, profile);
  return resolved && !resolved.merged_into ? resolved.id : undefined;
}

function requireOwner(db: DatabaseSync, owner: string): void {
  if (resolvePersonalGitHubOwner(owner, db) !== owner) {
    throw new Error("Personal GitHub owner changed; reconnect and try again.");
  }
}

function readConnection(db: DatabaseSync, owner: string): UserGitHubConnection | undefined {
  const raw = readPersonalGitHubSecret(db, owner);
  return raw === undefined ? undefined : parseConnection(raw);
}

export function readUserGitHubConnection(
  owner: string,
  database?: OpenClawStateDatabaseOptions,
): UserGitHubConnection | undefined {
  const db = openOpenClawStateDatabase(database).db;
  requireOwner(db, owner);
  return readConnection(db, owner);
}

export function updateUserGitHubConnection(
  owner: string,
  update: (current: UserGitHubConnection | undefined) => UserGitHubConnection,
  assertCurrent: () => void,
  database?: OpenClawStateDatabaseOptions,
): UserGitHubConnection {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requireOwner(db, owner);
      const current = readConnection(db, owner);
      const next = parseConnection(JSON.stringify(update(current)));
      assertCurrent();
      writePersonalGitHubSecret(db, owner, JSON.stringify(next));
      const retained = new Set(connectionProfiles(next));
      retireAfterCommit(
        db,
        connectionProfiles(current).filter((id) => !retained.has(id)),
      );
      return next;
    },
    database,
    { operationLabel: "users.github.update" },
  );
}

export function disconnectedUserGitHubConnection(): UserGitHubConnection {
  return { version: 1, generation: randomUUID(), selection: { kind: "disconnected" } };
}

export function disconnectUserGitHubConnection(owner: string, assertCurrent: () => void): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      requireOwner(db, owner);
      const previous = readConnectionForReplacement(db, owner);
      assertCurrent();
      writePersonalGitHubSecret(db, owner, JSON.stringify(disconnectedUserGitHubConnection()));
      retireAfterCommit(db, connectionProfiles(previous));
    },
    undefined,
    { operationLabel: "users.github.disconnect" },
  );
}

function connectionProfiles(record: UserGitHubConnection | undefined): string[] {
  return [
    ...(record?.selection.kind === "connected" ? [record.selection.profileId] : []),
    ...(record?.pending?.kind === "device" && record.pending.candidate
      ? [record.pending.candidate.profileId]
      : []),
  ];
}

// Only explicit replacement may repair corruption. A broken merge target must
// count as disconnected state so it never adopts the source's credentials.
function readConnectionForReplacement(db: DatabaseSync, owner: string) {
  try {
    return readConnection(db, owner);
  } catch (error) {
    if (!(error instanceof PersonalGitHubStateError)) {
      throw error;
    }
    return disconnectedUserGitHubConnection();
  }
}

/** Transfer only this live source, never credentials stranded on historical aliases. */
export function mergeUserGitHubConnection(db: DatabaseSync, source: string, target: string): void {
  requireOwner(db, source);
  requireOwner(db, target);
  const sourceRecord = readConnectionForReplacement(db, source);
  const targetRecord = readConnectionForReplacement(db, target);
  const selected = targetRecord ?? sourceRecord;
  if (!selected) {
    return;
  }
  const next: UserGitHubConnection = { ...selected, generation: randomUUID(), pending: undefined };
  writePersonalGitHubSecret(db, target, JSON.stringify(next));
  if (sourceRecord) {
    writePersonalGitHubSecret(db, source, null);
  }
  const retained = new Set(connectionProfiles(next));
  retireAfterCommit(
    db,
    [...connectionProfiles(sourceRecord), ...connectionProfiles(targetRecord)].filter(
      (id) => !retained.has(id),
    ),
  );
}

/** A remote rotation may follow an exact transferred operation; this never authorizes an action. */
export function updateUserGitHubRefresh(params: {
  owner: string;
  profileId: string;
  operationId: string;
  update: (selection: UserGitHubConnected) => UserGitHubConnected;
}): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const owner = resolvePersonalGitHubOwner(params.owner, db);
      if (!owner) {
        return false;
      }
      const record = readConnection(db, owner);
      const selection = record?.selection;
      if (
        !record ||
        selection?.kind !== "connected" ||
        selection.profileId !== params.profileId ||
        selection.refresh?.operationId !== params.operationId
      ) {
        return false;
      }
      const next = parseConnection(
        JSON.stringify({ ...record, selection: params.update(selection) }),
      );
      writePersonalGitHubSecret(db, owner, JSON.stringify(next));
      return true;
    },
    undefined,
    { operationLabel: "users.github.refresh" },
  );
}

export function listUserGitHubConnections(): Array<{
  owner: string;
  connection: UserGitHubConnection;
}> {
  const db = openOpenClawStateDatabase().db;
  if (!tableExists(db, "secret_store_entries") || !tableExists(db, "user_profiles")) {
    return [];
  }
  const query = getNodeSqliteKysely<
    Pick<DB, "secret_store_entries"> & Pick<UserProfilesDatabase, "user_profiles">
  >(db);
  return executeSqliteQuerySync(
    db,
    query
      .selectFrom("secret_store_entries")
      .innerJoin("user_profiles", "user_profiles.id", "secret_store_entries.scope_id")
      .select(["scope_id", "value"])
      .where("scope_kind", "=", "identity")
      .where("name", "=", "github-connection")
      .where("kind", "=", "secret")
      .where("allowed_hosts", "is", null)
      .where("deleted_at_ms", "is", null)
      .where("merged_into", "is", null)
      .orderBy("scope_id"),
  ).rows.flatMap((row) => {
    try {
      return [{ owner: row.scope_id, connection: parseConnection(row.value) }];
    } catch {
      return [];
    }
  });
}
