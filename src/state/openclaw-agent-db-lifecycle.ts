import path from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPathInside } from "../infra/path-guards.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import type { SqliteIntegrityDiagnostics } from "../infra/sqlite-integrity.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { registerSqliteCacheExitClose } from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { releaseAgentDeletionDatabaseCleanup } from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOwnerInspection,
} from "./openclaw-agent-db-contract.js";
import { releaseOpenClawAgentDatabaseLease } from "./openclaw-agent-db-lease.js";
import {
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";

// Target 64 cached handles (roughly three WAL FDs each). Live borrowers,
// transactions and incognito sessions keep their handles until owner release.
export const OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP = 64;
const agentDbLog = createSubsystemLogger("state/agent-db");
const OPENCLAW_AGENT_DB_SLOW_OPEN_MS = 1_000;
// Native and transformed SDK graphs must share the complete owner lifecycle;
// sharing only handles would split borrow pins, failure latches, and cleanup.
type AgentDatabaseLifecycle = {
  databases: Map<string, OpenClawAgentDatabase>;
  borrowers: WeakMap<DatabaseSync, Set<object>>;
  incognito: WeakSet<OpenClawAgentDatabase>;
  generation: number;
  failures: Map<string, unknown>;
  leases: Map<string, { leaseId: string; env: NodeJS.ProcessEnv }>;
  terminal: ReturnType<typeof createSqliteTerminalOpenLatch>;
  unregisterExitClose: (() => void) | null;
  pending: Map<string, PendingAgentDatabaseOpen>;
  activePending: Set<PendingAgentDatabaseOpen>;
  retainedCloses: Set<RetainedAgentDatabaseClose>;
};
export type PendingAgentDatabaseOpen = {
  agentId: string;
  path: string;
  controller: AbortController;
  promise: Promise<OpenClawAgentDatabase>;
  assertHeld?: () => void;
  operations: number;
  releaseBorrow?: () => void;
};
type RetainedAgentDatabaseClose = { agentId: string; path: string; close: () => void };
const cache = resolveGlobalSingleton<AgentDatabaseLifecycle>(
  Symbol.for("openclaw.agentDatabaseLifecycle"),
  () => ({
    databases: new Map(),
    borrowers: new WeakMap(),
    incognito: new WeakSet(),
    generation: 0,
    failures: new Map(),
    leases: new Map(),
    terminal: createSqliteTerminalOpenLatch({ closeByPath: closeOpenClawAgentDatabaseByPath }),
    unregisterExitClose: null,
    pending: new Map(),
    activePending: new Set(),
    retainedCloses: new Set(),
  }),
);

/** Each physical-open generator owns these checkpoints across any integrity await. */
export function startAgentDatabaseOpenTiming(
  agentId: string,
  pathname: string,
  admissionMode: "sync" | "async",
  diagnostics: SqliteIntegrityDiagnostics,
) {
  const startedAt = performance.now();
  let elapsedMs = 0;
  const phaseDurationsMs = { open: 0, validation: 0, configuration: 0, schema: 0, registration: 0 };
  return (phase: keyof typeof phaseDurationsMs): void => {
    const completedMs = Math.floor(performance.now() - startedAt);
    phaseDurationsMs[phase] = completedMs - elapsedMs;
    elapsedMs = completedMs;
    // Registration is the final checkpoint; intermediate phases never emit a partial summary.
    if (phase === "registration" && elapsedMs >= OPENCLAW_AGENT_DB_SLOW_OPEN_MS) {
      agentDbLog.warn("slow OpenClaw agent database open", {
        agentId,
        elapsedMs,
        path: pathname,
        pid: process.pid,
        threadId,
        isMainThread,
        admissionMode,
        phaseDurationsMs,
        ...diagnostics,
        thresholdMs: OPENCLAW_AGENT_DB_SLOW_OPEN_MS,
      });
    }
  };
}

// A failed native close or lease release keeps its original owner until retry succeeds.
export function retainFailedAgentDatabaseClose(
  agentId: string,
  pathname: string,
  close: () => void,
): void {
  const retained: RetainedAgentDatabaseClose = {
    agentId,
    path: pathname,
    close: () => {
      close();
      cache.retainedCloses.delete(retained);
    },
  };
  cache.retainedCloses.add(retained);
  cache.unregisterExitClose ??= registerSqliteCacheExitClose(closeOpenClawAgentDatabases);
}

export function revokePendingAgentDatabaseOpen(pathname: string, expectedAgentId?: string): void {
  for (const pending of cache.activePending) {
    if (
      pending.path === pathname &&
      (expectedAgentId === undefined || pending.agentId === expectedAgentId)
    ) {
      pending.controller.abort(new Error(`Agent database open was revoked: ${pathname}`));
    }
  }
}

export function retainAgentDatabase(db: DatabaseSync): () => void {
  const borrowers = cache.borrowers.get(db) ?? new Set<object>();
  const borrower = {};
  borrowers.add(borrower);
  cache.borrowers.set(db, borrowers);
  return () => {
    borrowers.delete(borrower);
  };
}

export function closeCachedOpenClawAgentDatabase(
  database: OpenClawAgentDatabase,
  options: { eviction?: boolean } = {},
): void {
  // Eviction must stay cheap: PASSIVE skips waiting on concurrent readers,
  // whose drained TRUNCATE checkpoints blocked the event loop for seconds.
  database.walMaintenance.close(options.eviction ? { checkpointMode: "PASSIVE" } : undefined);
  if (database.db.isOpen) {
    database.db.close();
  }
  const lease = cache.leases.get(database.path);
  if (lease) {
    releaseOpenClawAgentDatabaseLease(lease.leaseId, { env: lease.env });
    cache.leases.delete(database.path);
  }
  releaseAgentDeletionDatabaseCleanup(database);
}

export function evictLruAgentDatabaseHandles(): void {
  // Synchronous callers re-fetch at operation entry. Borrowers retain the exact
  // connection across awaits, including prepared statements and loaded extensions.
  while (cache.databases.size >= OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP) {
    let evicted = false;
    for (const [pathname, database] of cache.databases) {
      // Failed lease release can leave a closed handle cached; retry its cleanup
      // before reading isTransaction, which rejects closed handles. Incognito
      // identity was recorded at open, including explicit-env sentinel paths.
      if (
        database.db.isOpen &&
        (database.db.isTransaction ||
          cache.borrowers.get(database.db)?.size ||
          cache.incognito.has(database))
      ) {
        continue;
      }
      // Registry rows are durable discovery metadata; only explicit disposal
      // unregisters them, while eviction closes this process-local handle.
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      cache.databases.delete(pathname);
      cache.failures.delete(pathname);
      if (cache.incognito.has(database)) {
        cache.generation += 1;
      }
      agentDbLog.debug("evicted OpenClaw agent database handle", {
        agentId: database.agentId,
        openHandles: cache.databases.size,
        path: pathname,
      });
      evicted = true;
      break;
    }
    if (!evicted) {
      // Live borrows, incognito state, and transactions cannot be evicted.
      // Their owners release them; an unrelated agent must still be able to open.
      agentDbLog.warn("agent database handle cap exceeded; all cached handles are retained", {
        cap: OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
        openHandles: cache.databases.size,
      });
      return;
    }
  }
}

/** Close one cached agent database identified by its exact resolved pathname. */
export function closeOpenClawAgentDatabaseByPath(
  pathname: string,
  expectedAgentId?: string,
): boolean {
  // Cache keys are lexical resolved paths. Do not realpath aliases here: a
  // symlink swap must never redirect cleanup onto a different cached database.
  const resolvedPath = path.resolve(pathname);
  // Revocation is immediate; the async owner retains its lease until native work joins.
  revokePendingAgentDatabaseOpen(resolvedPath, expectedAgentId);
  for (const retained of cache.retainedCloses) {
    if (
      retained.path === resolvedPath &&
      (expectedAgentId === undefined || retained.agentId === expectedAgentId)
    ) {
      retained.close();
    }
  }
  const database = cache.databases.get(resolvedPath);
  if (!database || (expectedAgentId !== undefined && database.agentId !== expectedAgentId)) {
    return false;
  }
  const incognito = cache.incognito.has(database);
  closeCachedOpenClawAgentDatabase(database);
  cache.databases.delete(resolvedPath);
  cache.failures.delete(resolvedPath);
  if (incognito) {
    cache.generation += 1;
  }
  if (cache.databases.size === 0 && cache.retainedCloses.size === 0) {
    cache.unregisterExitClose?.();
    cache.unregisterExitClose = null;
  }
  return true;
}

export type OpenClawAgentDatabaseWorkerCloseResult = {
  errors: Error[];
  settled: boolean;
};

/**
 * Converge a terminating worker's cached handle and durable lease without
 * turning an already committed worker result into an operation failure.
 * Callers own a bounded retry policy and must surface an unsettled result.
 */
export function settleOpenClawAgentDatabaseWorkerClose(
  pathname: string,
): OpenClawAgentDatabaseWorkerCloseResult {
  const resolvedPath = path.resolve(pathname);
  const errors: Error[] = [];
  const database = cache.databases.get(resolvedPath);
  if (database) {
    try {
      database.walMaintenance.close();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (database.db.isOpen) {
      try {
        database.db.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (!database.db.isOpen) {
      const incognito = cache.incognito.has(database);
      cache.databases.delete(resolvedPath);
      cache.failures.delete(resolvedPath);
      if (incognito) {
        cache.generation += 1;
      }
      if (cache.databases.size === 0 && cache.retainedCloses.size === 0) {
        cache.unregisterExitClose?.();
        cache.unregisterExitClose = null;
      }
    }
  }

  if (!cache.databases.get(resolvedPath)?.db.isOpen) {
    const lease = cache.leases.get(resolvedPath);
    if (lease) {
      try {
        releaseOpenClawAgentDatabaseLease(lease.leaseId, { env: lease.env });
        cache.leases.delete(resolvedPath);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return {
    errors,
    settled: !cache.databases.get(resolvedPath)?.db.isOpen && !cache.leases.has(resolvedPath),
  };
}

/** Close cached agent handles, optionally restricted to one runtime root. */
export function closeOpenClawAgentDatabases(rootPath?: string): void {
  for (const pathname of cache.pending.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      revokePendingAgentDatabaseOpen(pathname);
    }
  }
  for (const retained of cache.retainedCloses) {
    if (rootPath === undefined || isPathInside(rootPath, retained.path)) {
      retained.close();
    }
  }
  for (const pathname of cache.databases.keys()) {
    if (rootPath === undefined || isPathInside(rootPath, pathname)) {
      closeOpenClawAgentDatabaseByPath(pathname);
    }
  }
}

/** Drain native opens before a lifecycle owner releases shared state or removes its root. */
export async function closeOpenClawAgentDatabasesAsync(rootPath?: string): Promise<void> {
  while (true) {
    const pending = [...cache.activePending].filter(
      (owner) => rootPath === undefined || isPathInside(rootPath, owner.path),
    );
    if (pending.length === 0) {
      break;
    }
    for (const owner of pending) {
      revokePendingAgentDatabaseOpen(owner.path);
    }
    await Promise.allSettled(pending.map((owner) => owner.promise));
  }
  closeOpenClawAgentDatabases(rootPath);
}

/** Read a database's durable role and agent owner without mutating it. */
export function inspectOpenClawAgentDatabaseOwner(
  pathname: string,
): OpenClawAgentDatabaseOwnerInspection {
  let db: DatabaseSync | undefined;
  try {
    // Failed opens retain a disposal-only handle whose agentId is the request,
    // not a verified owner. Only admitted handles can answer from cache.
    const resolvedPath = path.resolve(pathname);
    const opened = cache.databases.get(resolvedPath);
    if (opened?.db.isOpen && !cache.failures.has(resolvedPath)) {
      assertSupportedAgentSchemaVersion(opened.db, pathname);
      return { status: "owned", agentId: opened.agentId };
    }
    db = openNodeSqliteDatabase(pathname, { readOnly: true });
    setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    assertSupportedAgentSchemaVersion(db, pathname);
    const existing = readExistingAgentSchemaMeta(db);
    if (!existing) {
      return { status: "unowned" };
    }
    if (existing.role !== "agent" || !existing.agentId) {
      return { status: "unreadable" };
    }
    return { status: "owned", agentId: normalizeAgentId(existing.agentId) };
  } catch {
    return { status: "unreadable" };
  } finally {
    db?.close();
  }
}

export { cache as agentDatabaseLifecycle };
