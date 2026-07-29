import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
// Canonical shared-SQLite store for APNs device and relay registrations.
import type { Insertable, Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { loadPairedDevicePairingStoreRecordFromDatabase } from "./device-pairing-store.js";
import { resolveNodePairingGeneration } from "./device-pairing.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { nextApnsRegistrationVersion } from "./push-apns-store-transaction.js";
import {
  normalizeApnsRelayBaseUrl,
  normalizePersistedApnsRelayBaseUrl,
} from "./push-apns.relay.js";

export type ApnsEnvironment = "sandbox" | "production";

export type DirectApnsRegistration = {
  nodeId: string;
  transport: "direct";
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  updatedAtMs: number;
};

export type RelayApnsRegistration = {
  nodeId: string;
  transport: "relay";
  relayHandle: string;
  sendGrant: string;
  installationId: string;
  topic: string;
  environment: ApnsEnvironment;
  distribution: "official";
  updatedAtMs: number;
  relayOrigin?: string;
  tokenDebugSuffix?: string;
};

/** Stored APNs registration for either direct device tokens or official relay handles. */
export type ApnsRegistration = DirectApnsRegistration | RelayApnsRegistration;

export class ApnsRegistrationPairingChangedError extends Error {
  constructor() {
    super("node pairing changed before APNs registration");
    this.name = "ApnsRegistrationPairingChangedError";
  }
}

type RegisterDirectApnsParams = {
  nodeId: string;
  transport?: "direct";
  token: string;
  topic: string;
  environment?: unknown;
  expectedPairingGeneration?: string;
  baseDir?: string;
};

type RegisterRelayApnsParams = {
  nodeId: string;
  transport: "relay";
  relayHandle: string;
  sendGrant: string;
  installationId: string;
  topic: string;
  environment?: unknown;
  distribution?: unknown;
  relayOrigin?: unknown;
  tokenDebugSuffix?: unknown;
  expectedPairingGeneration?: string;
  baseDir?: string;
};

type RegisterApnsParams = RegisterDirectApnsParams | RegisterRelayApnsParams;

type ApnsRegistrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "apns_registrations" | "apns_registration_tombstones"
>;
type ApnsRegistrationRow = Selectable<ApnsRegistrationDatabase["apns_registrations"]>;
type ApnsRegistrationInsert = Insertable<ApnsRegistrationDatabase["apns_registrations"]>;

const MAX_NODE_ID_LENGTH = 256;
const MAX_TOPIC_LENGTH = 255;
const MAX_APNS_TOKEN_HEX_LENGTH = 512;
const MAX_RELAY_IDENTIFIER_LENGTH = 256;
const MAX_SEND_GRANT_LENGTH = 1024;
const APNS_REGISTRATION_LOOKUP_CHUNK_SIZE = 500;

function apnsStateDatabaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

export function normalizeApnsNodeId(value: string): string {
  return value.trim();
}

export function isValidApnsNodeId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NODE_ID_LENGTH;
}

export function normalizeApnsToken(value: string): string {
  return normalizeLowercaseStringOrEmpty(value.trim().replace(/[<>\s]/g, ""));
}

function normalizeRelayHandle(value: string): string {
  return value.trim();
}

function normalizeInstallationId(value: string): string {
  return value.trim();
}

function validateRelayIdentifier(
  value: string,
  fieldName: string,
  maxLength: number = MAX_RELAY_IDENTIFIER_LENGTH,
): string {
  if (!value) {
    throw new Error(`${fieldName} required`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} too long`);
  }
  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(`${fieldName} invalid`);
  }
  return value;
}

function isValidRelayIdentifier(
  value: string,
  maxLength: number = MAX_RELAY_IDENTIFIER_LENGTH,
): boolean {
  return value.length > 0 && value.length <= maxLength && !/[^\x21-\x7e]/.test(value);
}

export function normalizeApnsTopic(value: string): string {
  return value.trim();
}

export function isValidApnsTopic(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOPIC_LENGTH;
}

function normalizeTokenDebugSuffix(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value.trim()).replace(/[^0-9a-z]/g, "");
  return normalized.length > 0 ? normalized.slice(-8) : undefined;
}

export function isLikelyApnsToken(value: string): boolean {
  return value.length <= MAX_APNS_TOKEN_HEX_LENGTH && /^[0-9a-f]{32,}$/i.test(value);
}

function normalizeDistribution(value: unknown): "official" | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeOptionalString(value)
    ? normalizeLowercaseStringOrEmpty(value)
    : undefined;
  return normalized === "official" ? "official" : null;
}

function normalizeRelayOrigin(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizeApnsRelayBaseUrl(trimmed, env);
  return normalized.ok ? normalized.value : undefined;
}

function normalizePersistedRelayOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePersistedApnsRelayBaseUrl(trimmed);
  return normalized.ok ? normalized.value : undefined;
}

/** Normalizes the APNs environment string accepted by registration inputs. */
export function normalizeApnsEnvironment(value: unknown): ApnsEnvironment | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (normalized === "sandbox" || normalized === "production") {
    return normalized;
  }
  return null;
}

function normalizeDirectRegistration(
  record: Partial<DirectApnsRegistration> & { nodeId?: unknown; token?: unknown },
): DirectApnsRegistration | null {
  if (typeof record.nodeId !== "string" || typeof record.token !== "string") {
    return null;
  }
  const nodeId = normalizeApnsNodeId(record.nodeId);
  const token = normalizeApnsToken(record.token);
  const topic = normalizeApnsTopic(typeof record.topic === "string" ? record.topic : "");
  const environment = normalizeApnsEnvironment(record.environment);
  const updatedAtMs =
    typeof record.updatedAtMs === "number" &&
    Number.isSafeInteger(record.updatedAtMs) &&
    record.updatedAtMs >= 0
      ? record.updatedAtMs
      : null;
  if (
    !isValidApnsNodeId(nodeId) ||
    !isValidApnsTopic(topic) ||
    !isLikelyApnsToken(token) ||
    !environment ||
    updatedAtMs === null
  ) {
    return null;
  }
  return {
    nodeId,
    transport: "direct",
    token,
    topic,
    environment,
    updatedAtMs,
  };
}

function normalizeRelayRegistration(
  record: Partial<RelayApnsRegistration> & {
    nodeId?: unknown;
    relayHandle?: unknown;
    sendGrant?: unknown;
  },
  normalizeOrigin: (value: unknown) => string | undefined,
): RelayApnsRegistration | null {
  if (
    typeof record.nodeId !== "string" ||
    typeof record.relayHandle !== "string" ||
    typeof record.sendGrant !== "string" ||
    typeof record.installationId !== "string"
  ) {
    return null;
  }
  const nodeId = normalizeApnsNodeId(record.nodeId);
  const relayHandle = normalizeRelayHandle(record.relayHandle);
  const sendGrant = record.sendGrant.trim();
  const installationId = normalizeInstallationId(record.installationId);
  const topic = normalizeApnsTopic(typeof record.topic === "string" ? record.topic : "");
  const environment = normalizeApnsEnvironment(record.environment);
  const distribution = normalizeDistribution(record.distribution);
  const relayOrigin = normalizeOrigin(record.relayOrigin);
  const updatedAtMs =
    typeof record.updatedAtMs === "number" &&
    Number.isSafeInteger(record.updatedAtMs) &&
    record.updatedAtMs >= 0
      ? record.updatedAtMs
      : null;
  if (
    !isValidApnsNodeId(nodeId) ||
    !isValidRelayIdentifier(relayHandle) ||
    !isValidRelayIdentifier(sendGrant, MAX_SEND_GRANT_LENGTH) ||
    !isValidRelayIdentifier(installationId) ||
    !isValidApnsTopic(topic) ||
    !environment ||
    distribution !== "official" ||
    updatedAtMs === null
  ) {
    return null;
  }
  return {
    nodeId,
    transport: "relay",
    relayHandle,
    sendGrant,
    installationId,
    topic,
    environment,
    distribution,
    updatedAtMs,
    ...(relayOrigin ? { relayOrigin } : {}),
    tokenDebugSuffix: normalizeTokenDebugSuffix(record.tokenDebugSuffix),
  };
}

function normalizeCanonicalApnsRegistrationWithRelayOrigin(
  record: unknown,
  normalizeOrigin: (value: unknown) => string | undefined,
): ApnsRegistration | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  const candidate = record as Record<string, unknown>;
  const transport = normalizeLowercaseStringOrEmpty(candidate.transport);
  if (transport === "relay") {
    return normalizeRelayRegistration(candidate as Partial<RelayApnsRegistration>, normalizeOrigin);
  }
  if (transport === "direct") {
    return normalizeDirectRegistration(candidate as Partial<DirectApnsRegistration>);
  }
  return null;
}

/** Normalizes one canonical registration with an explicit transport discriminator. */
export function normalizeCanonicalApnsRegistration(
  record: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ApnsRegistration | null {
  return normalizeCanonicalApnsRegistrationWithRelayOrigin(record, (value) =>
    normalizeRelayOrigin(value, env),
  );
}

export function apnsRegistrationFromRow(row: ApnsRegistrationRow): ApnsRegistration {
  const { token } = row;
  const normalized = normalizeCanonicalApnsRegistrationWithRelayOrigin(
    {
      nodeId: row.node_id,
      transport: row.transport,
      token,
      relayHandle: row.relay_handle ?? undefined,
      sendGrant: row.send_grant ?? undefined,
      installationId: row.installation_id ?? undefined,
      relayOrigin: row.relay_origin ?? undefined,
      topic: row.topic,
      environment: row.environment,
      distribution: row.distribution ?? undefined,
      tokenDebugSuffix: row.token_debug_suffix ?? undefined,
      updatedAtMs: row.updated_at_ms,
    },
    normalizePersistedRelayOrigin,
  );
  if (!normalized) {
    throw new Error(`invalid APNs registration row for node ${row.node_id}`);
  }
  const canonical = apnsRegistrationToRow(normalized);
  if (
    canonical.node_id !== row.node_id ||
    canonical.transport !== row.transport ||
    canonical.token !== row.token ||
    canonical.relay_handle !== row.relay_handle ||
    canonical.send_grant !== row.send_grant ||
    canonical.installation_id !== row.installation_id ||
    canonical.relay_origin !== row.relay_origin ||
    canonical.topic !== row.topic ||
    canonical.environment !== row.environment ||
    canonical.distribution !== row.distribution ||
    canonical.token_debug_suffix !== row.token_debug_suffix ||
    canonical.updated_at_ms !== row.updated_at_ms
  ) {
    throw new Error(`non-canonical APNs registration row for node ${row.node_id}`);
  }
  return normalized;
}

export function apnsRegistrationToRow(registration: ApnsRegistration): ApnsRegistrationInsert {
  const base = {
    node_id: registration.nodeId,
    transport: registration.transport,
    topic: registration.topic,
    environment: registration.environment,
    updated_at_ms: registration.updatedAtMs,
  };
  if (registration.transport === "direct") {
    const { token } = registration;
    return {
      ...base,
      token,
      relay_handle: null,
      send_grant: null,
      installation_id: null,
      relay_origin: null,
      distribution: null,
      token_debug_suffix: null,
    };
  }
  return {
    ...base,
    token: null,
    relay_handle: registration.relayHandle,
    send_grant: registration.sendGrant,
    installation_id: registration.installationId,
    relay_origin: registration.relayOrigin ?? null,
    distribution: registration.distribution,
    token_debug_suffix: registration.tokenDebugSuffix ?? null,
  };
}

function apnsRegistrationsEqual(left: ApnsRegistration, right: ApnsRegistration): boolean {
  if (
    left.nodeId !== right.nodeId ||
    left.transport !== right.transport ||
    left.topic !== right.topic ||
    left.environment !== right.environment ||
    left.updatedAtMs !== right.updatedAtMs
  ) {
    return false;
  }
  if (left.transport === "direct" && right.transport === "direct") {
    return left.token === right.token;
  }
  return (
    left.transport === "relay" &&
    right.transport === "relay" &&
    left.relayHandle === right.relayHandle &&
    left.sendGrant === right.sendGrant &&
    left.installationId === right.installationId &&
    left.distribution === right.distribution &&
    left.relayOrigin === right.relayOrigin &&
    left.tokenDebugSuffix === right.tokenDebugSuffix
  );
}

/** Persists a validated direct or relay APNs registration for one node id. */
export async function registerApnsRegistration(
  params: RegisterApnsParams,
): Promise<ApnsRegistration> {
  const nodeId = normalizeApnsNodeId(params.nodeId);
  const topic = normalizeApnsTopic(params.topic);
  if (!isValidApnsNodeId(nodeId)) {
    throw new Error("nodeId required");
  }
  if (!isValidApnsTopic(topic)) {
    throw new Error("topic required");
  }

  let candidate: ApnsRegistration;
  if (params.transport === "relay") {
    const relayHandle = validateRelayIdentifier(
      normalizeRelayHandle(params.relayHandle),
      "relayHandle",
    );
    const sendGrant = validateRelayIdentifier(
      params.sendGrant.trim(),
      "sendGrant",
      MAX_SEND_GRANT_LENGTH,
    );
    const installationId = validateRelayIdentifier(
      normalizeInstallationId(params.installationId),
      "installationId",
    );
    const environment = normalizeApnsEnvironment(params.environment);
    const distribution = normalizeDistribution(params.distribution);
    const relayOrigin = normalizeRelayOrigin(params.relayOrigin);
    if (!environment) {
      throw new Error("relay registrations must use valid APNs environment");
    }
    if (distribution !== "official") {
      throw new Error("relay registrations must use official distribution");
    }
    candidate = {
      nodeId,
      transport: "relay",
      relayHandle,
      sendGrant,
      installationId,
      topic,
      environment,
      distribution,
      updatedAtMs: 0,
      ...(relayOrigin ? { relayOrigin } : {}),
      tokenDebugSuffix: normalizeTokenDebugSuffix(params.tokenDebugSuffix),
    };
  } else {
    const token = normalizeApnsToken(params.token);
    const environment = normalizeApnsEnvironment(params.environment) ?? "sandbox";
    if (!isLikelyApnsToken(token)) {
      throw new Error("invalid APNs token");
    }
    candidate = {
      nodeId,
      transport: "direct",
      token,
      topic,
      environment,
      updatedAtMs: 0,
    };
  }

  return runOpenClawStateWriteTransaction(({ db }) => {
    if (params.expectedPairingGeneration) {
      // The Gateway admission check happens before this transaction. Reread the
      // pairing here so removal and APNs ownership cannot commit out of order.
      const pairing = resolveNodePairingGeneration(
        loadPairedDevicePairingStoreRecordFromDatabase(db, nodeId),
      );
      if (pairing?.key !== params.expectedPairingGeneration) {
        throw new ApnsRegistrationPairingChangedError();
      }
    }
    const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(db);
    const current = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("apns_registrations")
        .select("updated_at_ms")
        .where("node_id", "=", nodeId),
    );
    const tombstone = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("apns_registration_tombstones")
        .select("deleted_at_ms")
        .where("node_id", "=", nodeId),
    );
    // The tombstone carries the deleted row's successor version. Advancing past
    // both rows keeps stale compare-and-delete callers harmless after re-registration.
    const previousVersions = [current?.updated_at_ms, tombstone?.deleted_at_ms].filter(
      (version): version is number => version !== undefined,
    );
    const next: ApnsRegistration = {
      ...candidate,
      updatedAtMs: nextApnsRegistrationVersion(nodeId, previousVersions),
    };
    const row = apnsRegistrationToRow(next);
    const {
      token,
      relay_handle,
      send_grant,
      installation_id,
      relay_origin,
      distribution,
      token_debug_suffix,
    } = row;
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("apns_registrations")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("node_id").doUpdateSet({
            transport: row.transport,
            token,
            relay_handle,
            send_grant,
            installation_id,
            relay_origin,
            topic: row.topic,
            environment: row.environment,
            distribution,
            token_debug_suffix,
            updated_at_ms: row.updated_at_ms,
          }),
        ),
    );
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("apns_registration_tombstones").where("node_id", "=", nodeId),
    );
    return next;
  }, apnsStateDatabaseOptions(params.baseDir));
}

/** Loads one normalized APNs registration by node id. */
export async function loadApnsRegistration(
  nodeId: string,
  baseDir?: string,
): Promise<ApnsRegistration | null> {
  const normalizedNodeId = normalizeApnsNodeId(nodeId);
  if (!normalizedNodeId) {
    return null;
  }
  const database = openOpenClawStateDatabase(apnsStateDatabaseOptions(baseDir));
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<ApnsRegistrationDatabase>(database.db)
      .selectFrom("apns_registrations")
      .selectAll()
      .where("node_id", "=", normalizedNodeId),
  );
  return row ? apnsRegistrationFromRow(row) : null;
}

/** Loads normalized APNs registrations for the requested node ids, preserving request order. */
export async function loadApnsRegistrations(
  nodeIds: readonly string[],
  baseDir?: string,
): Promise<Array<{ nodeId: string; registration: ApnsRegistration }>> {
  const normalizedByInput = nodeIds.map((nodeId) => ({
    nodeId,
    normalizedNodeId: normalizeApnsNodeId(nodeId),
  }));
  const uniqueNodeIds = [
    ...new Set(
      normalizedByInput
        .map((entry) => entry.normalizedNodeId)
        .filter((nodeId) => isValidApnsNodeId(nodeId)),
    ),
  ];
  if (uniqueNodeIds.length === 0) {
    return [];
  }
  const database = openOpenClawStateDatabase(apnsStateDatabaseOptions(baseDir));
  const registrations = new Map<string, ApnsRegistration>();
  const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(database.db);
  for (
    let offset = 0;
    offset < uniqueNodeIds.length;
    offset += APNS_REGISTRATION_LOOKUP_CHUNK_SIZE
  ) {
    const rows = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("apns_registrations")
        .selectAll()
        .where(
          "node_id",
          "in",
          uniqueNodeIds.slice(offset, offset + APNS_REGISTRATION_LOOKUP_CHUNK_SIZE),
        ),
    ).rows;
    for (const row of rows) {
      registrations.set(row.node_id, apnsRegistrationFromRow(row));
    }
  }
  return normalizedByInput.flatMap(({ nodeId, normalizedNodeId }) => {
    const registration = registrations.get(normalizedNodeId);
    return registration ? [{ nodeId, registration }] : [];
  });
}

/** Clears a registration only if storage still contains the caller's observed value. */
export async function clearApnsRegistrationIfCurrent(params: {
  nodeId: string;
  registration: ApnsRegistration;
  baseDir?: string;
}): Promise<boolean> {
  const normalizedNodeId = normalizeApnsNodeId(params.nodeId);
  if (!normalizedNodeId) {
    return false;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(db);
    const currentRow = executeSqliteQueryTakeFirstSync(
      db,
      stateDb.selectFrom("apns_registrations").selectAll().where("node_id", "=", normalizedNodeId),
    );
    if (
      !currentRow ||
      !apnsRegistrationsEqual(apnsRegistrationFromRow(currentRow), params.registration)
    ) {
      return false;
    }
    const tombstone = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("apns_registration_tombstones")
        .select("deleted_at_ms")
        .where("node_id", "=", normalizedNodeId),
    );
    const previousVersions = [currentRow.updated_at_ms, tombstone?.deleted_at_ms].filter(
      (version): version is number => version !== undefined,
    );
    const deletedAtMs = nextApnsRegistrationVersion(normalizedNodeId, previousVersions);
    // Doctor may not have retired the old JSON yet. This durable tombstone
    // prevents that stale source from restoring an invalidated registration.
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("apns_registration_tombstones")
        .values({ node_id: normalizedNodeId, deleted_at_ms: deletedAtMs })
        .onConflict((conflict) =>
          conflict.column("node_id").doUpdateSet({ deleted_at_ms: deletedAtMs }),
        ),
    );
    executeSqliteQuerySync(
      db,
      stateDb.deleteFrom("apns_registrations").where("node_id", "=", normalizedNodeId),
    );
    return true;
  }, apnsStateDatabaseOptions(params.baseDir));
}
