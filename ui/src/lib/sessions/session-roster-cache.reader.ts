import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionGateway, SessionListOptions, SessionState } from "./session-capability.ts";
import { isPrimarySessionListQuery } from "./session-list-query.ts";
import { normalizeManagedSessionListQuery } from "./session-requests.ts";
import {
  SESSION_ROSTER_DB_NAME,
  SESSION_ROSTER_STORE_NAME,
  SESSION_ROSTER_MAX_AGE_MS,
  SESSION_ROSTER_MAX_BYTES,
  sessionRosterCacheGeneration,
  type RosterExpectation,
  type SessionRosterCache,
  type SessionRosterRecord,
} from "./session-roster-cache.ts";

function isNullableId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRosterQuery(value: unknown): value is SessionListOptions {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, entry]) => {
      if (key === "agentId") {
        return typeof entry === "string";
      }
      if (key === "limit") {
        return typeof entry === "number" && Number.isFinite(entry);
      }
      return (
        [
          "includeGlobal",
          "includeUnknown",
          "configuredAgentsOnly",
          "includeDerivedTitles",
          "includeLastMessage",
          "ownerFirst",
        ].includes(key) && typeof entry === "boolean"
      );
    })
  );
}

function isSessionRosterRecord(value: unknown): value is SessionRosterRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.scope === "string" &&
    value.scope.length > 0 &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    value.savedAt >= 0 &&
    isNullableId(value.profileId) &&
    isNullableId(value.agentId) &&
    isRosterQuery(value.query) &&
    isRecord(value.result) &&
    Array.isArray(value.result.sessions) &&
    value.result.sessions.length <= 200 &&
    value.result.sessions.every((row: unknown) => isRecord(row) && typeof row.key === "string") &&
    Array.isArray(value.groups) &&
    value.groups.every((group: unknown) => typeof group === "string") &&
    Array.isArray(value.groupSettings) &&
    value.groupSettings.every(
      (group: unknown) =>
        isRecord(group) && typeof group.name === "string" && typeof group.position === "number",
    ) &&
    Array.isArray(value.sectionOrder) &&
    value.sectionOrder.every((section: unknown) => typeof section === "string")
  );
}

// Incognito conversations are memory-only by contract; their titles and previews
// must never reach IndexedDB, and a stored row from an older writer is dropped too.
export function isPersistableSessionRow(row: GatewaySessionRow): boolean {
  return row.incognito !== true;
}

export function stripVolatileSessionRowFields(row: GatewaySessionRow): GatewaySessionRow {
  const result = { ...row };
  delete result.hasActiveRun;
  delete result.activeRunIds;
  delete result.status;
  delete result.runtimeMs;
  delete result.runtimeSampledAt;
  delete result.agentStatus;
  delete result.observerDigest;
  delete result.swarmPhase;
  delete result.swarmPhaseRank;
  delete result.swarmLog;
  delete result.placement;
  delete result.placementMove;
  delete result.subagentRunState;
  delete result.hasActiveSubagentRun;
  delete result.channelAvatarUrl;
  return result;
}

export function parseSessionRosterRecord(value: unknown): SessionRosterRecord | null {
  return isSessionRosterRecord(value) ? value : null;
}

export function sessionRosterQuery(options: SessionListOptions): SessionListOptions {
  return normalizeManagedSessionListQuery({
    ...options,
    includeDerivedTitles: options.includeDerivedTitles ?? true,
    includeLastMessage: options.includeLastMessage ?? true,
  });
}

export function rosterRecordMatches(
  record: SessionRosterRecord,
  expected: RosterExpectation,
): boolean {
  return (
    record.agentId === expected.agentId &&
    (record.query.agentId === undefined || record.query.agentId.trim() === record.agentId) &&
    (expected.query.agentId === undefined || expected.query.agentId.trim() === expected.agentId) &&
    (expected.profileId === undefined || record.profileId === expected.profileId) &&
    isPrimarySessionListQuery(record.query) &&
    isPrimarySessionListQuery(expected.query)
  );
}

export function rosterRequestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("IndexedDB request failed")),
    );
    request.addEventListener("blocked", () => reject(new Error("IndexedDB open was blocked")));
  });
}

export function rosterTransactionDone(transaction: IDBTransaction): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed")),
    );
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed")),
    );
  });
  // A failed request can leave its caller before the transaction is awaited.
  void completed.catch(() => undefined);
  return completed;
}

export async function resetSessionRosterDatabase(): Promise<void> {
  try {
    if (globalThis.indexedDB) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(SESSION_ROSTER_DB_NAME);
        request.addEventListener("success", () => resolve());
        request.addEventListener("error", () => resolve());
        request.addEventListener("blocked", () => resolve());
      });
    }
  } catch {
    // Storage access can be denied independently of the Gateway connection.
  }
}

export async function openSessionRosterDatabase(): Promise<IDBDatabase | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (!globalThis.indexedDB) {
        return null;
      }
      const request = indexedDB.open(SESSION_ROSTER_DB_NAME, 1);
      request.addEventListener("upgradeneeded", () => {
        for (const name of Array.from(request.result.objectStoreNames)) {
          request.result.deleteObjectStore(name);
        }
        request.result.createObjectStore(SESSION_ROSTER_STORE_NAME, { keyPath: "scope" });
      });
      const database = await rosterRequestResult(request);
      database.addEventListener("versionchange", () => database.close());
      if (
        database.objectStoreNames.length === 1 &&
        database.objectStoreNames.contains(SESSION_ROSTER_STORE_NAME) &&
        database.transaction(SESSION_ROSTER_STORE_NAME).objectStore(SESSION_ROSTER_STORE_NAME)
          .keyPath === "scope"
      ) {
        return database;
      }
      database.close();
    } catch {
      // Browser caches are optional, including when storage is disabled or unavailable.
    }
    if (attempt === 0) {
      await resetSessionRosterDatabase();
    }
  }
  return null;
}

export async function readSessionRoster(
  scope: string,
  expected: RosterExpectation,
  generation: number,
): Promise<SessionRosterRecord | null> {
  if (generation !== sessionRosterCacheGeneration) {
    return null;
  }
  const database = await openSessionRosterDatabase();
  if (!database) {
    return null;
  }
  try {
    const transaction = database.transaction(SESSION_ROSTER_STORE_NAME);
    const completed = rosterTransactionDone(transaction);
    const value: unknown = await rosterRequestResult(
      transaction.objectStore(SESSION_ROSTER_STORE_NAME).get(scope),
    );
    await completed;
    if (value === undefined || generation !== sessionRosterCacheGeneration) {
      return null;
    }
    const record = parseSessionRosterRecord(value);
    if (
      !record ||
      record.scope !== scope ||
      Date.now() - record.savedAt > SESSION_ROSTER_MAX_AGE_MS ||
      new TextEncoder().encode(JSON.stringify(record)).byteLength > SESSION_ROSTER_MAX_BYTES
    ) {
      database.close();
      await resetSessionRosterDatabase();
      return null;
    }
    if (!rosterRecordMatches(record, expected)) {
      return null;
    }
    return {
      ...record,
      result: {
        ...record.result,
        sessions: record.result.sessions
          .filter(isPersistableSessionRow)
          .map(stripVolatileSessionRowFields),
      },
    };
  } catch {
    database.close();
    await resetSessionRosterDatabase();
    return null;
  } finally {
    database.close();
  }
}

export async function hydrateSessionRoster(
  gateway: SessionGateway,
  agentSelection: { readonly state: { readonly selectedId: string | null } },
  cache: SessionRosterCache,
  host: { readState: () => SessionState; publish: (state: SessionState) => void },
  initial: RosterExpectation & {
    scope: string | undefined;
    connectionRevision: number | undefined;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!initial.scope || signal.aborted || host.readState().result !== null) {
    return;
  }
  const record = await cache.read(initial.scope, initial);
  const scope = gateway.connection
    ? gatewayCredentialScope(gateway.connection.gatewayUrl)
    : initial.scope;
  if (
    !record ||
    signal.aborted ||
    host.readState().result !== null ||
    gateway.snapshot.phase === "connected" ||
    agentSelection.state.selectedId !== initial.agentId ||
    scope !== initial.scope ||
    gateway.connectionRevision !== initial.connectionRevision ||
    !rosterRecordMatches(record, initial)
  ) {
    return;
  }
  host.publish({
    ...host.readState(),
    result: record.result,
    agentId: record.agentId,
    groups: record.groups,
    groupSettings: record.groupSettings,
    sectionOrder: record.sectionOrder,
    resultCached: true,
  });
}
