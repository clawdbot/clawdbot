import { createHmac, randomBytes } from "node:crypto";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { ensureConfigRevisionKeySchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

type ConfigRevisionKeyDatabase = Pick<OpenClawStateKyselyDatabase, "config_revision_keys">;
type ConfigRevisionKeyRow = Pick<
  Selectable<ConfigRevisionKeyDatabase["config_revision_keys"]>,
  "hmac_key"
>;

export type GatewayConfigRevisionProjector = {
  projectRawHash: (hash: string) => string;
  projectResolvedHash: (hash: string) => string;
};

const CONFIG_REVISION_SINGLETON_ID = 1;
const CONFIG_REVISION_KEY_BYTES = 32;
const CONFIG_REVISION_RAW_DOMAIN = "openclaw.gateway.config-revision.raw.v1";
const CONFIG_REVISION_RESOLVED_DOMAIN = "openclaw.gateway.config-revision.resolved.v1";

function registerConfigRevisionKeyForRedaction(key: Uint8Array): void {
  const bytes = Buffer.from(key);
  registerSecretValueForRedaction(bytes.toString("hex"));
  registerSecretValueForRedaction(bytes.toString("base64url"));
}

function parseConfigRevisionKey(row: ConfigRevisionKeyRow): Uint8Array {
  if (
    !(row.hmac_key instanceof Uint8Array) ||
    row.hmac_key.byteLength !== CONFIG_REVISION_KEY_BYTES
  ) {
    // Public revision tokens are a config-redaction boundary. Corrupt key material
    // must fail closed instead of rotating or falling back to a deterministic digest.
    throw new Error("config revision key is corrupt");
  }
  const key = Buffer.from(row.hmac_key);
  registerConfigRevisionKeyForRedaction(key);
  return key;
}

function loadOrCreateConfigRevisionKey(
  database: Parameters<typeof getNodeSqliteKysely>[0],
  candidateKey: Uint8Array,
): Uint8Array {
  const db = getNodeSqliteKysely<ConfigRevisionKeyDatabase>(database);
  const existing = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("config_revision_keys")
      .select("hmac_key")
      .where("id", "=", CONFIG_REVISION_SINGLETON_ID),
  );
  if (existing) {
    return parseConfigRevisionKey(existing);
  }
  executeSqliteQuerySync(
    database,
    db
      .insertInto("config_revision_keys")
      .values({
        id: CONFIG_REVISION_SINGLETON_ID,
        hmac_key: candidateKey,
      })
      .onConflict((conflict) => conflict.column("id").doNothing()),
  );
  const stored = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("config_revision_keys")
      .select("hmac_key")
      .where("id", "=", CONFIG_REVISION_SINGLETON_ID),
  );
  if (!stored) {
    throw new Error("config revision key could not be created");
  }
  return parseConfigRevisionKey(stored);
}

function projectRevision(key: Uint8Array, domain: string, hash: string): string {
  const digest = createHmac("sha256", key)
    .update(JSON.stringify([domain, hash]), "utf8")
    .digest("base64url");
  return `hmac-sha256:v1:${digest}`;
}

function createGatewayConfigRevisionProjector(key: Uint8Array): GatewayConfigRevisionProjector {
  if (key.byteLength !== CONFIG_REVISION_KEY_BYTES) {
    throw new Error("config revision key must be 32 bytes");
  }
  return {
    projectRawHash: (hash) => projectRevision(key, CONFIG_REVISION_RAW_DOMAIN, hash),
    projectResolvedHash: (hash) => projectRevision(key, CONFIG_REVISION_RESOLVED_DOMAIN, hash),
  };
}

/** Loads the durable installation key once for the Gateway request lifecycle. */
export function loadGatewayConfigRevisionProjector(
  options: OpenClawStateDatabaseOptions = {},
): GatewayConfigRevisionProjector {
  const candidateKey = randomBytes(CONFIG_REVISION_KEY_BYTES);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureConfigRevisionKeySchema(db);
      return createGatewayConfigRevisionProjector(loadOrCreateConfigRevisionKey(db, candidateKey));
    },
    options,
    { operationLabel: "gateway.config-revision-key.load" },
  );
}
