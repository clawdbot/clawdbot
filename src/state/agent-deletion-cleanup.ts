import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type AgentDeletionCleanupRow = {
  agentId: string;
  operationId: string;
  cleanupCompleted: boolean;
};

type AgentDeletionDatabaseCleanupScope = {
  agentId: string;
  path: string;
  statePath: string;
  assertCurrent: () => void;
  assertJournal: (statePath: string, entries: readonly AgentDeletionCleanupRow[]) => string;
  registerClose: (close: () => void) => void;
};

const databaseCleanup = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDeletionDatabaseCleanup"),
  () => new AsyncLocalStorage<AgentDeletionDatabaseCleanupScope>(),
);
const cleanupHandles = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDeletionDatabaseCleanupHandles"),
  () => new Map<OpenClawAgentDatabase, AgentDeletionDatabaseCleanupScope>(),
);

/** The lifecycle owner supplies live closures, never a transferable operation id. */
export function createAgentDeletionDatabaseCleanup(owner: {
  statePath: string;
  assertAdmission: () => void;
  assertCurrent: () => void;
  assertJournal: (statePath: string, entries: readonly AgentDeletionCleanupRow[]) => string;
}) {
  return async <T>(
    target: { agentId: string; path: string },
    run: () => Promise<T>,
  ): Promise<T> => {
    let active = true;
    const closers: Array<() => void> = [];
    const assertActive = () => {
      if (!active) {
        throw new Error("Agent deletion database cleanup is no longer active.");
      }
    };
    const scope: AgentDeletionDatabaseCleanupScope = {
      agentId: normalizeAgentId(target.agentId),
      path: path.resolve(target.path),
      statePath: path.resolve(owner.statePath),
      assertCurrent: () => {
        assertActive();
        owner.assertCurrent();
      },
      assertJournal: (statePath, entries) => {
        assertActive();
        return owner.assertJournal(statePath, entries);
      },
      registerClose: (close) => {
        assertActive();
        closers.push(close);
      },
    };
    return await databaseCleanup.run(scope, async () => {
      let outcome: Result<T, unknown>;
      const closeErrors: unknown[] = [];
      try {
        scope.assertCurrent();
        owner.assertAdmission();
        outcome = ok(await run());
      } catch (error) {
        outcome = err(error);
      } finally {
        for (const close of closers.toReversed()) {
          try {
            close();
          } catch (error) {
            closeErrors.push(error);
          }
        }
        // Retained async callbacks keep this same object and must fail after settlement.
        // A failed native close remains tagged and leased for the existing close retry.
        active = false;
        closers.length = 0;
      }
      if (!outcome.ok) {
        throw closeErrors.length > 0
          ? new AggregateError(
              [outcome.error, ...closeErrors],
              "Agent deletion database cleanup failed.",
            )
          : outcome.error;
      }
      if (closeErrors.length > 0) {
        throw closeErrors.length === 1
          ? closeErrors[0]
          : new AggregateError(closeErrors, "Agent deletion database cleanup failed.");
      }
      return outcome.value;
    });
  };
}

export function getAgentDeletionDatabaseCleanup(
  params: OpenClawAgentDatabaseOptions & { statePath?: string },
): AgentDeletionDatabaseCleanupScope | undefined {
  const scope = databaseCleanup.getStore();
  if (
    !scope ||
    scope.agentId !== normalizeAgentId(params.agentId) ||
    scope.path !== resolveOpenClawAgentSqlitePath(params)
  ) {
    return undefined;
  }
  const statePath = params.statePath ?? resolveOpenClawStateSqlitePath(params.env ?? process.env);
  if (scope.statePath !== path.resolve(statePath)) {
    throw new Error("Agent deletion database cleanup belongs to another state database.");
  }
  return scope;
}

export function assertAgentDeletionDatabaseCleanupAccess(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
): void {
  const scope = getAgentDeletionDatabaseCleanup(options);
  const owner = cleanupHandles.get(database);
  if (owner && owner !== scope) {
    throw new Error("Agent database belongs to an active deletion cleanup.");
  }
  scope?.assertCurrent();
}

export function assertAgentDeletionCleanupAliases(
  options: OpenClawAgentDatabaseOptions,
  isSamePath: (left: string, right: string) => boolean,
): void {
  // Only cleanup-held files need this rare physical alias check on a cache miss.
  const pathname = resolveOpenClawAgentSqlitePath(options);
  for (const owned of cleanupHandles.keys()) {
    if (isSamePath(owned.path, pathname)) {
      assertAgentDeletionDatabaseCleanupAccess(owned, options);
    }
  }
}

export function registerAgentDeletionDatabaseCleanup(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
): AgentDeletionDatabaseCleanupScope | undefined {
  const scope = getAgentDeletionDatabaseCleanup(options);
  scope?.assertCurrent();
  if (scope) {
    cleanupHandles.set(database, scope);
  }
  return scope;
}

/** Release the tag only after the native owner has closed and released its lease. */
export function releaseAgentDeletionDatabaseCleanup(database: OpenClawAgentDatabase): void {
  cleanupHandles.delete(database);
}
