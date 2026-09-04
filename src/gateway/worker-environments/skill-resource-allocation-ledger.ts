import { randomBytes } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Kysely } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  parseSkillResourceAllocationLocation,
  parseSkillResourceAllocationRecord,
  SKILL_RESOURCE_ALLOCATION_LEDGER_VERSION,
  type SkillResourceAllocationIntent,
  type SkillResourceAllocationLocation,
  type SkillResourceAllocationRecord,
} from "./skill-resource-allocation-ledger-contract.js";

export type {
  SkillResourceAllocationIntent,
  SkillResourceAllocationLocation,
  SkillResourceAllocationRecord,
} from "./skill-resource-allocation-ledger-contract.js";

const LEDGER_VERSION = SKILL_RESOURCE_ALLOCATION_LEDGER_VERSION;
const LEDGER_SCOPE = "worker.skill-resource-allocation.v1";
const QUARANTINE_KEY_PREFIX = "quarantine.v1.";
const QUARANTINE_OWNER = "openclaw-skill-resource-allocation-quarantine";
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const HEX_32_PATTERN = /^[a-f0-9]{32}$/u;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Durable host-owned cleanup intent.
 *
 * Source updates and code-only rollback retain the live shared database. State-lease rows are
 * removed from every restorable snapshot, so machine-local cleanup cannot replay on another host.
 */

export type SkillResourceAllocationTransactionFence = (database: DatabaseSync) => void;

type LedgerOptions = {
  databaseOptions?: OpenClawStateDatabaseOptions;
  incarnationId?: string;
};

type LedgerDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;
type LedgerKysely = Kysely<LedgerDatabase>;

type RawLedgerRow = {
  scope: string;
  lease_key: string;
  owner: string;
  expires_at: bigint | null;
  heartbeat_at: bigint | null;
  payload_json: string | null;
  created_at: bigint;
  updated_at: bigint;
};

type QuarantineEnvelope = {
  version: 1;
  quarantinedAtMs: number;
  original: {
    scope: string;
    leaseKey: string;
    owner: string;
    expiresAt: string | null;
    heartbeatAt: string | null;
    payloadJson: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0");
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0")) {
    return false;
  }
  const pathApi = /^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(value) ? path.win32 : path.posix;
  return pathApi.isAbsolute(value) && pathApi.normalize(value) === value;
}

function monotonicTimestamp(...persistedTimes: number[]): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid host wall-clock timestamp");
  }
  return Math.max(now, ...persistedTimes);
}

function isSafeEnvironmentId(value: unknown): value is string {
  let containsControl = false;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) {
        containsControl = true;
        break;
      }
    }
  }
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !containsControl
  );
}

function parseRecord(value: unknown): SkillResourceAllocationRecord | undefined {
  return parseSkillResourceAllocationRecord(value, isCanonicalAbsolutePath, isSafeEnvironmentId);
}

function recordKey(allocationId: string): string {
  if (typeof allocationId !== "string" || !HEX_32_PATTERN.test(allocationId)) {
    throw new Error("Invalid skill resource allocation id");
  }
  return allocationId;
}

function asRawLedgerRow(value: unknown): RawLedgerRow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "created_at",
      "expires_at",
      "heartbeat_at",
      "lease_key",
      "owner",
      "payload_json",
      "scope",
      "updated_at",
    ])
  ) {
    throw new Error("Invalid skill resource allocation storage row");
  }
  if (
    typeof value.scope !== "string" ||
    typeof value.lease_key !== "string" ||
    typeof value.owner !== "string" ||
    (value.expires_at !== null && typeof value.expires_at !== "bigint") ||
    (value.heartbeat_at !== null && typeof value.heartbeat_at !== "bigint") ||
    (value.payload_json !== null && typeof value.payload_json !== "string") ||
    typeof value.created_at !== "bigint" ||
    typeof value.updated_at !== "bigint"
  ) {
    throw new Error("Invalid skill resource allocation storage row");
  }
  return {
    scope: value.scope,
    lease_key: value.lease_key,
    owner: value.owner,
    expires_at: value.expires_at,
    heartbeat_at: value.heartbeat_at,
    payload_json: value.payload_json,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function prepareRawRowStatement(database: DatabaseSync, many: boolean) {
  const statement =
    database /* sqlite-allow-raw -- Statement-local BigInt reads preserve corrupt int64 evidence exactly. */
      .prepare(
        many
          ? `SELECT scope, lease_key, owner, expires_at, heartbeat_at, payload_json,
                created_at, updated_at
           FROM state_leases
          WHERE scope = ? AND lease_key NOT GLOB ?
          ORDER BY lease_key`
          : `SELECT scope, lease_key, owner, expires_at, heartbeat_at, payload_json,
                created_at, updated_at
           FROM state_leases
          WHERE scope = ? AND lease_key = ?`,
      );
  statement.setReadBigInts(true);
  return statement;
}

function selectRawRow(database: DatabaseSync, key: string): RawLedgerRow | undefined {
  const row = prepareRawRowStatement(database, false).get(LEDGER_SCOPE, key);
  return row === undefined ? undefined : asRawLedgerRow(row);
}

function listRawRows(database: DatabaseSync): RawLedgerRow[] {
  return prepareRawRowStatement(database, true)
    .all(LEDGER_SCOPE, `${QUARANTINE_KEY_PREFIX}*`)
    .map((row) => asRawLedgerRow(row));
}

function asSafeTimestamp(value: bigint): number | undefined {
  return value >= 0n && value <= MAX_SAFE_INTEGER_BIGINT ? Number(value) : undefined;
}

function parseRow(row: RawLedgerRow): SkillResourceAllocationRecord | undefined {
  if (
    row.scope !== LEDGER_SCOPE ||
    row.expires_at !== null ||
    row.heartbeat_at !== null ||
    row.payload_json === null
  ) {
    return undefined;
  }
  const createdAt = asSafeTimestamp(row.created_at);
  const updatedAt = asSafeTimestamp(row.updated_at);
  if (createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    return undefined;
  }
  const record = parseRecord(value);
  return record &&
    row.lease_key === recordKey(record.allocationId) &&
    row.owner === record.incarnationId &&
    createdAt === record.createdAtMs &&
    updatedAt === record.updatedAtMs &&
    row.payload_json === JSON.stringify(record)
    ? record
    : undefined;
}

function quarantineEnvelope(row: RawLedgerRow, quarantinedAtMs: number): QuarantineEnvelope {
  return {
    version: 1,
    quarantinedAtMs,
    original: {
      scope: row.scope,
      leaseKey: row.lease_key,
      owner: row.owner,
      expiresAt: row.expires_at?.toString() ?? null,
      heartbeatAt: row.heartbeat_at?.toString() ?? null,
      payloadJson: row.payload_json,
      createdAt: row.created_at.toString(),
      updatedAt: row.updated_at.toString(),
    },
  };
}

function quarantineRow(
  database: DatabaseSync,
  kysely: LedgerKysely,
  row: RawLedgerRow,
  transactionFence?: SkillResourceAllocationTransactionFence,
): void {
  const safeCreatedAt = asSafeTimestamp(row.created_at);
  const safeUpdatedAt = asSafeTimestamp(row.updated_at);
  const now = monotonicTimestamp(
    ...(safeCreatedAt === undefined ? [] : [safeCreatedAt]),
    ...(safeUpdatedAt === undefined ? [] : [safeUpdatedAt]),
  );
  const envelope = JSON.stringify(quarantineEnvelope(row, now));
  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
    transactionFence?.(database);
    const quarantineKey = `${QUARANTINE_KEY_PREFIX}${now}.${randomBytes(16).toString("hex")}`;
    inserted =
      executeSqliteQuerySync(
        database,
        kysely
          .insertInto("state_leases")
          .values({
            scope: LEDGER_SCOPE,
            lease_key: quarantineKey,
            owner: QUARANTINE_OWNER,
            expires_at: null,
            heartbeat_at: null,
            payload_json: envelope,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) => conflict.columns(["scope", "lease_key"]).doNothing()),
      ).numAffectedRows === 1n;
  }
  if (!inserted) {
    throw new Error("Unable to quarantine corrupt skill resource allocation row");
  }
  transactionFence?.(database);
  const removed = database // sqlite-allow-raw -- BigInt bindings keep malformed int64 evidence under exact CAS.
    .prepare(
      `DELETE FROM state_leases
        WHERE scope IS ? AND lease_key IS ? AND owner IS ?
          AND expires_at IS ? AND heartbeat_at IS ? AND payload_json IS ?
          AND created_at IS ? AND updated_at IS ?`,
    )
    .run(
      row.scope,
      row.lease_key,
      row.owner,
      row.expires_at,
      row.heartbeat_at,
      row.payload_json,
      row.created_at,
      row.updated_at,
    );
  if (removed.changes !== 1) {
    throw new Error("Corrupt skill resource allocation row changed during quarantine");
  }
}

function recordValues(record: SkillResourceAllocationRecord) {
  return {
    scope: LEDGER_SCOPE,
    lease_key: recordKey(record.allocationId),
    owner: record.incarnationId,
    expires_at: null,
    heartbeat_at: null,
    payload_json: JSON.stringify(record),
    created_at: record.createdAtMs,
    updated_at: record.updatedAtMs,
  } as const;
}

function updateRow(
  database: DatabaseSync,
  kysely: LedgerKysely,
  currentRow: RawLedgerRow,
  next: SkillResourceAllocationRecord,
): void {
  const nextValues = recordValues(next);
  const updated = executeSqliteQuerySync(
    database,
    kysely
      .updateTable("state_leases")
      .set({ payload_json: nextValues.payload_json, updated_at: nextValues.updated_at })
      .where("scope", "=", LEDGER_SCOPE)
      .where("lease_key", "=", currentRow.lease_key)
      .where("owner", "=", currentRow.owner)
      .where("expires_at", "is", null)
      .where("heartbeat_at", "is", null)
      .where("payload_json", "=", currentRow.payload_json)
      .where("created_at", "=", Number(currentRow.created_at))
      .where("updated_at", "=", Number(currentRow.updated_at)),
  );
  if (updated.numAffectedRows !== 1n) {
    throw new Error("Skill resource allocation ledger revision changed");
  }
}

export class SkillResourceAllocationLedger {
  readonly incarnationId: string;
  private readonly databaseOptions: OpenClawStateDatabaseOptions;

  constructor(options: LedgerOptions = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Invalid skill resource allocation ledger options");
    }
    const requestedDatabaseOptions = options.databaseOptions;
    const requestedIncarnationId = options.incarnationId;
    if (
      requestedDatabaseOptions !== undefined &&
      (!requestedDatabaseOptions ||
        typeof requestedDatabaseOptions !== "object" ||
        Array.isArray(requestedDatabaseOptions))
    ) {
      throw new Error("Invalid skill resource allocation ledger database options");
    }
    if (requestedDatabaseOptions) {
      const database = requestedDatabaseOptions.database;
      const env = requestedDatabaseOptions.env;
      const databasePath = requestedDatabaseOptions.path;
      const readOnly = requestedDatabaseOptions.readOnly;
      if (
        (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) ||
        (databasePath !== undefined &&
          (typeof databasePath !== "string" || databasePath.includes("\0"))) ||
        (readOnly !== undefined && typeof readOnly !== "boolean")
      ) {
        throw new Error("Invalid skill resource allocation ledger database options");
      }
      this.databaseOptions = {
        database,
        env: env ? { ...env } : undefined,
        path: databasePath,
        readOnly,
      };
    } else {
      this.databaseOptions = {};
    }
    this.incarnationId = requestedIncarnationId ?? randomBytes(16).toString("hex");
    if (typeof this.incarnationId !== "string" || !HEX_32_PATTERN.test(this.incarnationId)) {
      throw new Error("Invalid skill resource allocation ledger incarnation");
    }
  }

  private transaction<T>(
    operation: (database: DatabaseSync, kysely: LedgerKysely) => T,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): T {
    if (transactionFence !== undefined && typeof transactionFence !== "function") {
      throw new Error("Invalid skill resource allocation transaction fence");
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        transactionFence?.(db);
        return operation(db, getNodeSqliteKysely<LedgerDatabase>(db));
      },
      this.databaseOptions,
      { operationLabel: "skill-resource-allocation-ledger" },
    );
  }

  async createIntent(
    intent: SkillResourceAllocationIntent,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<SkillResourceAllocationRecord> {
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
      throw new Error("Invalid skill resource allocation intent");
    }
    const allocationId = intent.allocationId;
    const environmentId = intent.environmentId;
    const ownerEpoch = intent.ownerEpoch;
    const workspace = intent.workspace;
    const leaseToken = intent.leaseToken;
    if (
      typeof allocationId !== "string" ||
      !HEX_32_PATTERN.test(allocationId) ||
      !isSafeEnvironmentId(environmentId) ||
      asSafeIntegerInRange(ownerEpoch, { min: 0 }) === undefined ||
      !isCanonicalAbsolutePath(workspace) ||
      typeof leaseToken !== "string" ||
      !HEX_64_PATTERN.test(leaseToken)
    ) {
      throw new Error("Invalid skill resource allocation intent");
    }
    const now = monotonicTimestamp();
    const record: SkillResourceAllocationRecord = {
      version: LEDGER_VERSION,
      revision: 1,
      allocationId,
      environmentId,
      ownerEpoch,
      workspace,
      leaseToken,
      incarnationId: this.incarnationId,
      phase: "intent",
      createdAtMs: now,
      updatedAtMs: now,
      location: null,
    };
    return this.transaction((database, kysely) => {
      const inserted = executeSqliteQuerySync(
        database,
        kysely
          .insertInto("state_leases")
          .values(recordValues(record))
          .onConflict((conflict) => conflict.columns(["scope", "lease_key"]).doNothing()),
      );
      if (inserted.numAffectedRows !== 1n) {
        throw new Error("Skill resource allocation already exists");
      }
      return record;
    }, transactionFence);
  }

  private async update(
    allocationId: string,
    expectedRevision: number,
    transition: (record: SkillResourceAllocationRecord) => SkillResourceAllocationRecord,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<SkillResourceAllocationRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Invalid skill resource allocation ledger revision");
    }
    const key = recordKey(allocationId);
    const result = this.transaction((database, kysely) => {
      const row = selectRawRow(database, key);
      if (!row) {
        throw new Error("Skill resource allocation does not exist");
      }
      const current = parseRow(row);
      if (!current) {
        quarantineRow(database, kysely, row, transactionFence);
        return { corrupt: true as const };
      }
      if (current.revision !== expectedRevision) {
        throw new Error("Skill resource allocation ledger revision changed");
      }
      const transitioned = transition(current);
      if (transitioned === current) {
        return { corrupt: false as const, record: current };
      }
      const next = parseRecord(transitioned);
      if (
        !next ||
        next.allocationId !== current.allocationId ||
        next.environmentId !== current.environmentId ||
        next.ownerEpoch !== current.ownerEpoch ||
        next.workspace !== current.workspace ||
        next.leaseToken !== current.leaseToken ||
        next.incarnationId !== current.incarnationId ||
        next.createdAtMs !== current.createdAtMs
      ) {
        throw new Error("Invalid skill resource allocation ledger transition");
      }
      updateRow(database, kysely, row, next);
      return { corrupt: false as const, record: next };
    }, transactionFence);
    if (result.corrupt) {
      throw new Error("Corrupt skill resource allocation ledger record quarantined");
    }
    return result.record;
  }

  async markAllocated(
    allocationId: string,
    expectedRevision: number,
    location: SkillResourceAllocationLocation,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<SkillResourceAllocationRecord> {
    const parsedLocation = parseSkillResourceAllocationLocation(location);
    if (!location || typeof location !== "object" || !parsedLocation) {
      throw new Error("Invalid skill resource allocation location");
    }
    return await this.update(
      allocationId,
      expectedRevision,
      (current) => {
        if (current.phase !== "intent") {
          throw new Error("Skill resource allocation is not awaiting allocation");
        }
        return {
          ...current,
          revision: 2,
          phase: "allocated",
          updatedAtMs: monotonicTimestamp(current.createdAtMs, current.updatedAtMs),
          location: parsedLocation,
        };
      },
      transactionFence,
    );
  }

  async markCleanupPending(
    allocationId: string,
    expectedRevision: number,
    transactionFence?: SkillResourceAllocationTransactionFence,
    provisionalLocation?: SkillResourceAllocationLocation,
  ): Promise<SkillResourceAllocationRecord> {
    const parsedLocation = parseSkillResourceAllocationLocation(provisionalLocation);
    if (provisionalLocation !== undefined && !parsedLocation) {
      throw new Error("Invalid skill resource allocation location");
    }
    return await this.update(
      allocationId,
      expectedRevision,
      (current) => {
        if (parsedLocation && current.phase !== "intent") {
          throw new Error("Skill resource allocation is not awaiting allocation");
        }
        if (current.phase === "cleanup-pending" || current.phase === "cleanup-complete") {
          return current;
        }
        return {
          ...current,
          revision: parsedLocation || current.phase !== "intent" ? 3 : 2,
          phase: "cleanup-pending",
          updatedAtMs: monotonicTimestamp(current.createdAtMs, current.updatedAtMs),
          ...(parsedLocation ? { location: parsedLocation } : {}),
        };
      },
      transactionFence,
    );
  }

  async markCleanupComplete(
    allocationId: string,
    expectedRevision: number,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<SkillResourceAllocationRecord> {
    return await this.update(
      allocationId,
      expectedRevision,
      (current) => {
        if (current.phase === "cleanup-complete") {
          return current;
        }
        if (current.phase !== "cleanup-pending") {
          throw new Error("Skill resource allocation cleanup is not pending");
        }
        return {
          ...current,
          revision: current.revision + 1,
          phase: "cleanup-complete",
          updatedAtMs: monotonicTimestamp(current.createdAtMs, current.updatedAtMs),
        };
      },
      transactionFence,
    );
  }

  private async removeRecord(
    allocationId: string,
    expectedRevision: number,
    isRemovable: (record: SkillResourceAllocationRecord) => boolean,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("Invalid skill resource allocation ledger revision");
    }
    const key = recordKey(allocationId);
    const corrupt = this.transaction((database, kysely) => {
      const row = selectRawRow(database, key);
      if (!row) {
        throw new Error("Skill resource allocation does not exist");
      }
      const current = parseRow(row);
      if (!current) {
        quarantineRow(database, kysely, row, transactionFence);
        return true;
      }
      if (current.revision !== expectedRevision || !isRemovable(current)) {
        throw new Error("Skill resource allocation ledger revision changed");
      }
      const removed = executeSqliteQuerySync(
        database,
        kysely
          .deleteFrom("state_leases")
          .where("scope", "=", LEDGER_SCOPE)
          .where("lease_key", "=", row.lease_key)
          .where("owner", "=", row.owner)
          .where("expires_at", "is", null)
          .where("heartbeat_at", "is", null)
          .where("payload_json", "=", row.payload_json)
          .where("created_at", "=", Number(row.created_at))
          .where("updated_at", "=", Number(row.updated_at)),
      );
      if (removed.numAffectedRows !== 1n) {
        throw new Error("Skill resource allocation ledger revision changed");
      }
      return false;
    }, transactionFence);
    if (corrupt) {
      throw new Error("Corrupt skill resource allocation ledger record quarantined");
    }
  }

  async remove(
    allocationId: string,
    expectedRevision: number,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<void> {
    await this.removeRecord(
      allocationId,
      expectedRevision,
      (record) => record.phase === "cleanup-complete",
      transactionFence,
    );
  }

  /** Retires host intent after provider teardown has destroyed the complete environment. */
  async removeAfterEnvironmentDestroyed(
    allocationId: string,
    expectedRevision: number,
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<void> {
    await this.removeRecord(allocationId, expectedRevision, () => true, transactionFence);
  }

  async list(
    transactionFence?: SkillResourceAllocationTransactionFence,
  ): Promise<SkillResourceAllocationRecord[]> {
    return this.transaction((database, kysely) => {
      const records: SkillResourceAllocationRecord[] = [];
      for (const row of listRawRows(database)) {
        const record = parseRow(row);
        if (record) {
          records.push(record);
        } else {
          quarantineRow(database, kysely, row, transactionFence);
        }
      }
      return records;
    }, transactionFence);
  }
}

export function createSkillResourceAllocationLedger(
  options?: LedgerOptions,
): SkillResourceAllocationLedger {
  return new SkillResourceAllocationLedger(options);
}
