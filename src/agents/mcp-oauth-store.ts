// Canonical MCP OAuth session state. Legacy JSON import belongs to doctor only.
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";

type McpOAuthDatabase = Pick<OpenClawStateKyselyDatabase, "mcp_oauth_stores">;

const MCP_OAUTH_STORE_FORMAT_VERSION = 1;
const UNINITIALIZED_STORE_FIELDS = new Set(["credentialState", "pendingAuthorizationChallenge"]);

type McpOAuthAuthorizationChallenge = {
  resourceMetadataUrl?: string;
  scope?: string;
  requiresAuthorization?: true;
};

export type McpOAuthStore = {
  /** Provenance for token-less rows that Doctor must interpret during legacy import. */
  credentialState?: "uninitialized" | "cleared";
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastAuthorizationUrl?: string;
  redirectUrl?: string;
  pendingAuthorizationChallenge?: McpOAuthAuthorizationChallenge;
};

class McpOAuthStoreCorruptionError extends Error {
  constructor(storeKey: string, detail: string, options?: { cause?: unknown }) {
    super(`MCP OAuth store ${storeKey} is invalid: ${detail}`, options);
    this.name = "McpOAuthStoreCorruptionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOptionalString(
  storeKey: string,
  store: Record<string, unknown>,
  field: "codeVerifier" | "lastAuthorizationUrl" | "redirectUrl",
): void {
  const value = store[field];
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new McpOAuthStoreCorruptionError(storeKey, `${field} must be a non-empty string`);
  }
}

function assertDiscoveryState(storeKey: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value) || typeof value.authorizationServerUrl !== "string") {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState is invalid");
  }
  if (!URL.canParse(value.authorizationServerUrl)) {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState URLs are invalid");
  }
  if (
    value.resourceMetadataUrl !== undefined &&
    (typeof value.resourceMetadataUrl !== "string" || !URL.canParse(value.resourceMetadataUrl))
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState URLs are invalid");
  }
  if (
    value.resourceMetadata !== undefined &&
    !OAuthProtectedResourceMetadataSchema.safeParse(value.resourceMetadata).success
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState resource metadata is invalid");
  }
  if (
    value.authorizationServerMetadata !== undefined &&
    !OAuthMetadataSchema.safeParse(value.authorizationServerMetadata).success &&
    !OpenIdProviderDiscoveryMetadataSchema.safeParse(value.authorizationServerMetadata).success
  ) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "discoveryState authorization server metadata is invalid",
    );
  }
}

function assertAuthorizationChallenge(storeKey: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new McpOAuthStoreCorruptionError(storeKey, "pendingAuthorizationChallenge is invalid");
  }
  const resourceMetadataUrl = value.resourceMetadataUrl;
  if (
    resourceMetadataUrl !== undefined &&
    (typeof resourceMetadataUrl !== "string" || !URL.canParse(resourceMetadataUrl))
  ) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "pendingAuthorizationChallenge URL is invalid",
    );
  }
  const scope = value.scope;
  if (scope !== undefined && (typeof scope !== "string" || scope.length === 0)) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "pendingAuthorizationChallenge scope is invalid",
    );
  }
  if (value.requiresAuthorization !== undefined && value.requiresAuthorization !== true) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "pendingAuthorizationChallenge requiresAuthorization must be true",
    );
  }
}

/** Parse a canonical row without discarding SDK extension fields. */
export function parseMcpOAuthStoreJson(storeKey: string, raw: string): McpOAuthStore {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new McpOAuthStoreCorruptionError(storeKey, "store_json is not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new McpOAuthStoreCorruptionError(storeKey, "store_json must contain an object");
  }
  if (
    value.clientInformation !== undefined &&
    !OAuthClientInformationSchema.safeParse(value.clientInformation).success
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "clientInformation is invalid");
  }
  if (value.tokens !== undefined && !OAuthTokensSchema.safeParse(value.tokens).success) {
    throw new McpOAuthStoreCorruptionError(storeKey, "tokens are invalid");
  }
  if (
    value.credentialState !== undefined &&
    value.credentialState !== "uninitialized" &&
    value.credentialState !== "cleared"
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "credentialState is invalid");
  }
  if (value.credentialState !== undefined && value.tokens !== undefined) {
    throw new McpOAuthStoreCorruptionError(storeKey, "credentialState cannot coexist with tokens");
  }
  if (
    value.credentialState === "uninitialized" &&
    Object.keys(value).some((field) => !UNINITIALIZED_STORE_FIELDS.has(field))
  ) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "uninitialized credential state contains authoritative OAuth fields",
    );
  }
  if (
    value.tokenExpiresAt !== undefined &&
    (!Number.isFinite(value.tokenExpiresAt) || (value.tokenExpiresAt as number) < 0)
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "tokenExpiresAt is invalid");
  }
  if (value.tokenExpiresAt !== undefined && value.tokens === undefined) {
    throw new McpOAuthStoreCorruptionError(storeKey, "tokenExpiresAt requires tokens");
  }
  assertOptionalString(storeKey, value, "codeVerifier");
  assertOptionalString(storeKey, value, "lastAuthorizationUrl");
  assertOptionalString(storeKey, value, "redirectUrl");
  assertDiscoveryState(storeKey, value.discoveryState);
  assertAuthorizationChallenge(storeKey, value.pendingAuthorizationChallenge);
  return value as McpOAuthStore;
}

export function resolveMcpOAuthStoreKey(serverName: string, serverUrl: string): string {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const hash = createHash("sha256").update(serverName).update("\0").update(serverUrl).digest("hex");
  return `${safeServerName}-${hash.slice(0, 16)}`;
}

function storeFromRow(
  storeKey: string,
  row: { format_version: number; store_json: string } | undefined,
): McpOAuthStore {
  if (!row) {
    return {};
  }
  if (row.format_version !== MCP_OAUTH_STORE_FORMAT_VERSION) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      `unsupported format version ${row.format_version}`,
    );
  }
  return parseMcpOAuthStoreJson(storeKey, row.store_json);
}

function readFromDatabase(database: DatabaseSync, storeKey: string): McpOAuthStore {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .selectFrom("mcp_oauth_stores")
      .select(["format_version", "store_json"])
      .where("store_key", "=", storeKey),
  );
  return storeFromRow(storeKey, row);
}

/** Read canonical state, opening the writable lifecycle when runtime owns it. */
export function readMcpOAuthStore(storeKey: string): McpOAuthStore {
  return readFromDatabase(openOpenClawStateDatabase().db, storeKey);
}

/** Read status state without creating or repairing the shared database. */
export function readMcpOAuthStoreReadOnly(storeKey: string): McpOAuthStore {
  const databasePath = resolveOpenClawStateSqlitePath();
  if (!fs.existsSync(databasePath)) {
    return {};
  }
  return withOpenClawStateDatabaseReadOnly(({ db }) => {
    if (!tableExists(db, "mcp_oauth_stores")) {
      return {};
    }
    return readFromDatabase(db, storeKey);
  });
}

function replaceMcpOAuthStore(
  database: DatabaseSync,
  storeKey: string,
  next: McpOAuthStore,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
): McpOAuthStore {
  const storeJson = JSON.stringify(next);
  parseMcpOAuthStoreJson(storeKey, storeJson);
  assertOwnedInTransaction?.(database);
  const updatedAt = Date.now();
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .insertInto("mcp_oauth_stores")
      .values({
        store_key: storeKey,
        format_version: MCP_OAUTH_STORE_FORMAT_VERSION,
        store_json: storeJson,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("store_key").doUpdateSet({
          format_version: MCP_OAUTH_STORE_FORMAT_VERSION,
          store_json: storeJson,
          updated_at: updatedAt,
        }),
      ),
  );
  return next;
}

/** Atomically read, modify, and replace one OAuth session row. */
export function updateMcpOAuthStore(
  storeKey: string,
  update: (current: McpOAuthStore) => McpOAuthStore,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
): McpOAuthStore {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const current = readFromDatabase(db, storeKey);
    return replaceMcpOAuthStore(db, storeKey, update(current), assertOwnedInTransaction);
  });
}

/** Clear one OAuth session while retaining an authoritative canonical row. */
export function clearMcpOAuthStore(
  storeKey: string,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
): void {
  // Explicit provenance distinguishes logout from challenge-only bootstrap state.
  // Doctor imports retired credentials only into an `uninitialized` row.
  runOpenClawStateWriteTransaction(({ db }) => {
    replaceMcpOAuthStore(db, storeKey, { credentialState: "cleared" }, assertOwnedInTransaction);
  });
}
