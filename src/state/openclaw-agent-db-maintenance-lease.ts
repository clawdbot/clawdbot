import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertNoOpenClawAgentDatabaseLeases,
  runWithAgentDatabaseMaintenanceAuthority,
} from "./openclaw-agent-db-lease.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { OpenClawStateMutationOperation } from "./openclaw-state-lease-context.js";
import type { OpenClawStatePublicationOperation } from "./openclaw-state-lease-exclusion.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

type MaintenanceScope = {
  databasePath: string;
  owner: OpenClawStateLeaseContext;
  ancestors: readonly MaintenanceScope[];
  active: boolean;
  accepting: boolean;
  pending: Promise<unknown>[];
};
const activeMaintenance = new AsyncLocalStorage<MaintenanceScope>();

async function runMaintenanceScope<T>(
  databasePath: string,
  owner: OpenClawStateLeaseContext,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
  ancestors: readonly MaintenanceScope[] = [],
): Promise<T> {
  const scope: MaintenanceScope = {
    databasePath,
    owner,
    ancestors,
    active: true,
    accepting: true,
    pending: [],
  };
  const assertCurrent = () => {
    if (!scope.active || ancestors.some((parent) => !parent.active)) {
      throw new Error("Agent database maintenance scope is closed");
    }
    owner.assertOwned();
  };
  const assertAdmission = () => {
    assertCurrent();
    if (!scope.accepting) {
      throw new Error("Agent database maintenance admission is closed");
    }
  };
  const track = <R>(operation: Promise<R>): Promise<R> => {
    scope.pending.push(operation);
    void operation.catch(() => undefined);
    return operation;
  };
  const lease: OpenClawStateLeaseContext = {
    signal: owner.signal,
    assertOwned: assertCurrent,
    assertOwnedInTransaction(database) {
      assertCurrent();
      owner.assertOwnedInTransaction(database);
    },
    ...(owner.renew
      ? {
          renew() {
            assertAdmission();
            owner.renew!();
          },
        }
      : {}),
    ...(owner.withDatabaseFileExclusion
      ? {
          withDatabaseFileExclusion<R>(
            operation: (assertCurrent: () => void) => Promise<R>,
            bind?: (result: R, assertCurrent: () => void) => undefined,
          ) {
            assertAdmission();
            return track(owner.withDatabaseFileExclusion!(operation, bind));
          },
        }
      : {}),
    ...(owner.withDatabaseFileMutation
      ? {
          withDatabaseFileMutation<Value, Captured>(
            operation: OpenClawStateMutationOperation<Value, Captured>,
          ) {
            assertAdmission();
            return track(
              owner.withDatabaseFileMutation!({
                ...operation,
                assertCurrent() {
                  assertCurrent();
                  operation.assertCurrent();
                },
              }),
            );
          },
        }
      : {}),
    ...(owner.withDatabaseFilePublication
      ? {
          withDatabaseFilePublication<R>(operation: OpenClawStatePublicationOperation<R>) {
            assertAdmission();
            return track(owner.withDatabaseFilePublication!<R>(operation));
          },
        }
      : {}),
  };
  return activeMaintenance.run(scope, () =>
    runWithAgentDatabaseMaintenanceAuthority(lease, databasePath, async () => {
      let outcome: { value: T } | { error: unknown };
      try {
        assertCurrent();
        outcome = { value: await run(lease) };
      } catch (error) {
        outcome = { error };
      }
      scope.accepting = false;
      const errors: unknown[] = "error" in outcome ? [outcome.error] : [];
      let joined = 0;
      while (joined < scope.pending.length) {
        const admitted = scope.pending.slice(joined);
        joined += admitted.length;
        for (const result of await Promise.allSettled(admitted)) {
          if (result.status === "rejected" && !errors.includes(result.reason)) {
            errors.push(result.reason);
          }
        }
      }
      try {
        assertCurrent();
      } catch (error) {
        errors.push(error);
      } finally {
        scope.active = false;
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Agent maintenance and nested work failed", {
          cause: errors[0],
        });
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    }),
  );
}

/** Retain one real lease through nested Doctor work; serialized selectors grant no authority. */
export function withAgentDatabaseMaintenanceLease<T>(
  options: Pick<OpenClawStateDatabaseOptions, "env"> & {
    schemaPolicy?: "existing";
    leaseMs?: number;
  },
  run: (maintenance: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(options.env));
  const active = activeMaintenance.getStore();
  if (active) {
    if (!active.active || !active.accepting) {
      return Promise.reject(new Error("Agent database maintenance admission is closed"));
    }
    if (active.databasePath !== databasePath) {
      return Promise.reject(new Error("Nested agent maintenance cannot switch its state database"));
    }
    const admitted = runMaintenanceScope(databasePath, active.owner, run, [
      ...active.ancestors,
      active,
    ]);
    active.pending.push(admitted);
    void admitted.catch(() => undefined);
    return admitted;
  }
  return withOpenClawStateLease(
    {
      ...AGENT_DATABASE_MAINTENANCE_LEASE,
      database: { scope: "shared", options, schemaPolicy: options.schemaPolicy },
      leaseMs: options.leaseMs ?? 60_000,
      waitMs: 5_000,
      heartbeat: "worker",
      leaseLabel: "agent database maintenance lease",
      operationLabel: "agent.database.maintenance.lease",
    },
    (maintenance) =>
      runMaintenanceScope(databasePath, maintenance, async (lease) => {
        await closeOpenClawAgentDatabasesAsync();
        assertNoOpenClawAgentDatabaseLeases(lease, options);
        return run(lease);
      }),
  );
}
