import type { DatabaseSync } from "node:sqlite";
import { assertSqliteIntegrityInWorker } from "../infra/sqlite-integrity-worker.js";
import { assertSqliteIntegrity, type SqliteIntegrityOperation } from "../infra/sqlite-integrity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertAgentDeletionDatabaseCleanupAccess,
  getAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import {
  agentDatabaseLifecycle as cache,
  retainAgentDatabase,
  type PendingAgentDatabaseOpen,
} from "./openclaw-agent-db-lifecycle.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

/** Denial still invokes run under admission, with a throwing authority check, to permit cleanup. */
export type OpenClawAgentDatabaseWriteAdmission = <T>(
  run: (assertCurrent: () => void) => T | Promise<T>,
) => Promise<T>;

/** Bind both admission drivers to the canonical private database-open generator. */
export function createOpenClawAgentDatabaseAdmissionOwner(
  openSteps: (
    options: OpenClawAgentDatabaseOptions,
    pending: PendingAgentDatabaseOpen,
  ) => SqliteIntegrityOperation<OpenClawAgentDatabase>,
) {
  /** Retain the verified connection through an async caller's operation; disposal still revokes it. */
  function withOpenClawAgentDatabaseAsync<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
  ): Promise<T> {
    // Admission retains its original path, registration, and permission inputs across awaits.
    const options = { ...inputOptions, env: { ...(inputOptions.env ?? process.env) } };
    const agentId = normalizeAgentId(options.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
    const existing = cache.pending.get(pathname);
    if (existing?.agentId !== undefined && existing.agentId !== agentId) {
      return Promise.reject(
        new Error(`Agent database ${pathname} is opening for ${existing.agentId}`),
      );
    }
    if (existing?.controller.signal.aborted) {
      return existing.promise.then(
        () => withOpenClawAgentDatabaseAsync(options, operation),
        () => withOpenClawAgentDatabaseAsync(options, operation),
      );
    }
    const pending = existing ?? startOpenClawAgentDatabaseAdmission(options, agentId, pathname);
    pending.operations += 1;
    return pending.promise
      .then((database) => {
        pending.controller.signal.throwIfAborted();
        if (cache.databases.get(pathname) !== database || !database.db.isOpen) {
          throw new Error(`Agent database closed before its admitted operation: ${pathname}`);
        }
        // Coalesced callers keep their own scope; admission cannot lend its cleanup authority.
        assertAgentDeletionDatabaseCleanupAccess(database, options);
        return operation(database);
      })
      .finally(() => {
        // Every registered operation retains the publication borrow through its own
        // settlement, including wrapper/adoption awaits before it reaches the writer.
        pending.operations -= 1;
        if (!pending.operations) {
          pending.releaseBorrow?.();
        }
      });
  }

  /** Run on a Worker to keep its same-connection integrity check outside the parent writer. */
  async function withOpenClawAgentDatabaseAdmission<T>(
    inputOptions: OpenClawAgentDatabaseOptions,
    withAdmission: OpenClawAgentDatabaseWriteAdmission,
    operation: (database: OpenClawAgentDatabase) => T | Promise<T>,
  ): Promise<T> {
    const options = { ...inputOptions, env: { ...(inputOptions.env ?? process.env) } };
    const agentId = normalizeAgentId(options.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({ ...options, agentId });
    const existing = cache.pending.get(pathname);
    if (existing) {
      if (existing.agentId !== agentId) {
        throw new Error(`Agent database ${pathname} is opening for ${existing.agentId}`);
      }
      try {
        await existing.promise;
      } catch (error) {
        if (!existing.controller.signal.aborted) {
          throw error;
        }
      }
      return withOpenClawAgentDatabaseAdmission(options, withAdmission, operation);
    }
    const admission = createOpenClawAgentDatabaseAdmission(agentId, pathname);
    const { pending } = admission;
    // This caller receives its scoped operation result; lifecycle disposal joins the open promise.
    void pending.promise.catch(() => {});
    pending.operations += 1;
    const steps = openSteps(options, pending);
    let check: { database: DatabaseSync; databaseLabel: string } | undefined;
    let failure: { error: unknown } | undefined;
    let suspended = false;
    try {
      while (true) {
        const outcome = await withAdmission(async (assertCurrent) => {
          try {
            assertCurrent();
            assertOpenClawAgentDatabaseAdmissionCurrent(options, pending, check?.database);
          } catch (error) {
            // Revocation takes precedence over repairable integrity damage.
            failure = {
              error: new Error(error instanceof Error ? error.message : String(error), {
                cause: error,
              }),
            };
          }
          suspended = false;
          const step = failure ? steps.throw(failure.error) : steps.next();
          if (!step.done) {
            suspended = true;
            return { done: false as const, check: step.value };
          }
          pending.releaseBorrow = retainAgentDatabase(step.value.db);
          admission.complete(step.value);
          assertAgentDeletionDatabaseCleanupAccess(step.value, options);
          return { done: true as const, result: await operation(step.value) };
        });
        if (outcome.done) {
          return outcome.result;
        }
        check = outcome.check;
        failure = undefined;
        try {
          pending.controller.signal.throwIfAborted();
          assertSqliteIntegrity(check.database, check.databaseLabel);
        } catch (error) {
          failure = { error };
        }
      }
    } catch (error) {
      const failures = [error];
      if (suspended) {
        const cancellation = new Error(`Agent database admission failed: ${pathname}`, {
          cause: error,
        });
        try {
          // A lost scheduler cannot grant another permit. A generic refusal only
          // unwinds this owner's handle and lease; it cannot enter index repair.
          steps.throw(cancellation);
        } catch (cleanupError) {
          if (cleanupError !== cancellation) {
            failures.push(cleanupError);
          }
        }
      }
      const terminalFailure =
        failures.length === 1
          ? error
          : new AggregateError(failures, "Agent database admission and cleanup failed", {
              cause: error,
            });
      admission.fail(terminalFailure);
      throw terminalFailure;
    } finally {
      pending.operations -= 1;
      if (!pending.operations) {
        pending.releaseBorrow?.();
      }
    }
  }

  function createOpenClawAgentDatabaseAdmission(agentId: string, pathname: string) {
    const completion = createDeferredCore<OpenClawAgentDatabase>();
    const pending: PendingAgentDatabaseOpen = {
      agentId,
      path: pathname,
      controller: new AbortController(),
      promise: completion.promise,
      operations: 0,
    };
    cache.pending.set(pathname, pending);
    cache.activePending.add(pending);
    const retire = () => {
      if (cache.pending.get(pathname) === pending) {
        cache.pending.delete(pathname);
      }
      cache.activePending.delete(pending);
    };
    return {
      pending,
      complete: (database: OpenClawAgentDatabase) => {
        retire();
        if (
          pending.controller.signal.aborted ||
          cache.databases.get(pathname) !== database ||
          !database.db.isOpen
        ) {
          const error =
            pending.controller.signal.reason ??
            new Error(`Agent database closed before admission completed: ${pathname}`);
          completion.reject(error);
          throw error;
        }
        completion.resolve(database);
      },
      fail: (error: unknown) => {
        retire();
        completion.reject(error);
      },
    };
  }

  function assertOpenClawAgentDatabaseAdmissionCurrent(
    options: OpenClawAgentDatabaseOptions,
    pending: PendingAgentDatabaseOpen,
    database?: DatabaseSync,
  ): void {
    const pathname = pending.path;
    pending.controller.signal.throwIfAborted();
    if (cache.pending.get(pathname) !== pending) {
      throw new Error(`Agent database open was replaced: ${pathname}`);
    }
    // Cleanup may end during the native check; reject before schema repair can resume.
    getAgentDeletionDatabaseCleanup(options)?.assertCurrent();
    pending.assertHeld?.();
    if (database) {
      assertSupportedAgentSchemaVersion(database, pathname);
      assertExistingAgentSchemaOwner(
        readExistingAgentSchemaMeta(database),
        pending.agentId,
        pathname,
      );
    }
  }

  function startOpenClawAgentDatabaseAdmission(
    options: OpenClawAgentDatabaseOptions,
    agentId: string,
    pathname: string,
  ): PendingAgentDatabaseOpen {
    const admission = createOpenClawAgentDatabaseAdmission(agentId, pathname);
    const { pending } = admission;
    const operation = openSteps(options, pending);
    void (async () => {
      let step = operation.next();
      while (!step.done) {
        let failure: unknown;
        let failed = false;
        try {
          await assertSqliteIntegrityInWorker(
            pathname,
            OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            pending.controller.signal,
          );
        } catch (error) {
          failure = error;
          failed = true;
        }
        try {
          assertOpenClawAgentDatabaseAdmissionCurrent(options, pending, step.value.database);
        } catch (error) {
          failure = error;
          failed = true;
        }
        // Resuming, or throwing into, the same owner preserves repair and unwind policy.
        step = failed ? operation.throw(failure) : operation.next();
      }
      // A peer may publish before promise consumers run. Their operation owner,
      // not promise scheduling depth, releases this exact connection borrow.
      pending.releaseBorrow = retainAgentDatabase(step.value.db);
      return step.value;
    })()
      .then(admission.complete, admission.fail)
      .catch(admission.fail);
    return pending;
  }

  return { withOpenClawAgentDatabaseAsync, withOpenClawAgentDatabaseAdmission };
}
