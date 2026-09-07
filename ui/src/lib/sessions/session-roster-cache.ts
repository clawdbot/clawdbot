import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionGroupSettings } from "./custom-groups.ts";
import type { SessionListOptions } from "./session-capability.ts";
import { isPrimarySessionListQuery } from "./session-list-query.ts";
import { normalizeManagedSessionListQuery } from "./session-requests.ts";

export const SESSION_ROSTER_DB_NAME = "openclaw-session-roster";
export const SESSION_ROSTER_STORE_NAME = "rosters";
export const SESSION_ROSTER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ROSTER_MAX_BYTES = 1.5 * 1024 * 1024;
export let sessionRosterCacheGeneration = 0;

export type SessionRosterRecord = {
  version: 1;
  scope: string;
  savedAt: number;
  profileId: string | null;
  agentId: string | null;
  query: SessionListOptions;
  result: SessionsListResult;
  groups: readonly string[];
  groupSettings: readonly SessionGroupSettings[];
  sectionOrder: readonly string[];
};

type RosterExpectation = {
  profileId?: string | null;
  agentId: string | null;
  query: SessionListOptions;
};

export type SessionRosterCache = {
  read: (scope: string, expected: RosterExpectation) => Promise<SessionRosterRecord | null>;
  write: (record: SessionRosterRecord) => void;
};

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
      await (await import("./session-roster-cache.runtime.ts")).resetSessionRosterDatabase();
    }
  }
  return null;
}

async function read(
  scope: string,
  expected: RosterExpectation,
): Promise<SessionRosterRecord | null> {
  const generation = sessionRosterCacheGeneration;
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
      await (await import("./session-roster-cache.runtime.ts")).resetSessionRosterDatabase();
      return null;
    }
    if (!rosterRecordMatches(record, expected)) {
      return null;
    }
    return {
      ...record,
      result: {
        ...record.result,
        sessions: record.result.sessions.map(stripVolatileSessionRowFields),
      },
    };
  } catch {
    database.close();
    await (await import("./session-roster-cache.runtime.ts")).resetSessionRosterDatabase();
    return null;
  } finally {
    database.close();
  }
}

export const sessionRosterCache: SessionRosterCache = {
  read,
  write(record) {
    const generation = sessionRosterCacheGeneration;
    void import("./session-roster-cache.runtime.ts")
      .then((runtime) => {
        if (generation === sessionRosterCacheGeneration) {
          runtime.persistSessionRoster(record);
        }
      })
      .catch(() => undefined);
  },
};

export function invalidateSessionRosterCache(): void {
  sessionRosterCacheGeneration += 1;
}
