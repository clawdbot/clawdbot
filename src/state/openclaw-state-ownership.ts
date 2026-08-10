import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";

export const STATE_SUPERVISION_KEY = "gateway.supervision";
const MAX_OWNERSHIP_TIMESTAMP_MS = 8_640_000_000_000_000;
const MANAGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type OpenClawExternalStateOwnership = {
  claimedAt: number;
  managerId: string;
  mode: "external";
  version: 1;
};

export class OpenClawStateOwnershipError extends Error {}

export class OpenClawStateOwnershipMetadataError extends OpenClawStateOwnershipError {
  constructor(
    readonly databasePath: string,
    message: string,
  ) {
    super(
      `OpenClaw shared state ownership metadata is invalid at ${databasePath}: ${message}. ` +
        "Repair it with OPENCLAW_SUPERVISOR_MODE=external openclaw database ownership claim --manager <manager-id>.",
    );
    this.name = "OpenClawStateOwnershipMetadataError";
  }
}

class OpenClawStateExternalOwnershipError extends OpenClawStateOwnershipError {
  constructor(
    readonly databasePath: string,
    readonly managerId: string,
  ) {
    super(
      `OpenClaw shared state database ${databasePath} is externally supervised by ${managerId}. ` +
        "Use that external supervisor with OPENCLAW_SUPERVISOR_MODE=external for writable operations.",
    );
    this.name = "OpenClawStateExternalOwnershipError";
  }
}

export function normalizeOpenClawStateManagerId(managerId: string): string {
  const normalized = managerId.trim();
  if (!MANAGER_ID_PATTERN.test(normalized)) {
    throw new Error(
      "External state ownership manager id must be a 1-128 character ASCII identifier.",
    );
  }
  return normalized;
}

function parseExternalOwnership(
  valueJson: string,
  databasePath: string,
): OpenClawExternalStateOwnership {
  let value: unknown;
  try {
    value = JSON.parse(valueJson) as unknown;
  } catch {
    throw new OpenClawStateOwnershipMetadataError(databasePath, "reserved value is not valid JSON");
  }
  const record = isRecord(value) ? value : undefined;
  const keys = record ? Object.keys(record).toSorted().join(",") : "";
  const managerId = record?.managerId;
  const claimedAt = record?.claimedAt;
  if (
    keys !== "claimedAt,managerId,mode,version" ||
    record?.version !== 1 ||
    record?.mode !== "external" ||
    typeof managerId !== "string" ||
    !MANAGER_ID_PATTERN.test(managerId) ||
    typeof claimedAt !== "number" ||
    !Number.isSafeInteger(claimedAt) ||
    claimedAt < 0 ||
    claimedAt > MAX_OWNERSHIP_TIMESTAMP_MS
  ) {
    throw new OpenClawStateOwnershipMetadataError(
      databasePath,
      "reserved value does not match the version 1 external ownership contract",
    );
  }
  return {
    version: 1,
    mode: "external",
    managerId,
    claimedAt,
  };
}

/** Inspect the reserved ownership row without entering the shared-state lifecycle. */
export function inspectOpenClawStateOwnershipFromDatabase(
  database: DatabaseSync,
  databasePath: string,
): OpenClawExternalStateOwnership | null {
  if (!tableExists(database, "config_machine_state")) {
    return null;
  }
  const row = database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ? LIMIT 1")
    .get(STATE_SUPERVISION_KEY) as { value_json?: unknown } | undefined;
  if (!row) {
    return null;
  }
  if (typeof row.value_json !== "string") {
    throw new OpenClawStateOwnershipMetadataError(databasePath, "reserved value is not text");
  }
  return parseExternalOwnership(row.value_json, databasePath);
}

/** Inspect one resolved state database path without mutating a quiescent SQLite family. */
export function inspectOpenClawStateOwnershipAtPath(
  databasePath: string,
): OpenClawExternalStateOwnership | null {
  const resolvedPath = path.resolve(databasePath);
  if (!existsSync(resolvedPath)) {
    return null;
  }
  // WAL readers need the live sidecars. Rollback-journal recovery stays with the
  // writable lifecycle after this ownership fence, so it remains immutable here.
  const hasLiveWal = ["-shm", "-wal"].some((suffix) => existsSync(`${resolvedPath}${suffix}`));
  const location = hasLiveWal ? resolvedPath : resolveImmutableSqliteFileUri(resolvedPath);
  const database = openNodeSqliteDatabase(location, { readOnly: true });
  try {
    database.exec(
      `${hasLiveWal ? `PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; ` : ""}PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`,
    );
    return inspectOpenClawStateOwnershipFromDatabase(database, resolvedPath);
  } finally {
    database.close();
  }
}

/** Fence shared-state writes once an external manager has claimed ownership. */
export function assertOpenClawStateWriteAllowed(options: {
  database?: DatabaseSync;
  databasePath: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const resolvedPath = path.resolve(options.databasePath);
  const status = options.database
    ? inspectOpenClawStateOwnershipFromDatabase(options.database, resolvedPath)
    : inspectOpenClawStateOwnershipAtPath(resolvedPath);
  if (status && !isGatewayExternallySupervised(options.env ?? process.env)) {
    throw new OpenClawStateExternalOwnershipError(resolvedPath, status.managerId);
  }
}
