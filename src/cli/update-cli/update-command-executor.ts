import { randomUUID } from "node:crypto";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "../../infra/update-managed-service-handoff-lease.js";
import { isCurrentManagedServiceUpdateHandoffProcess } from "../../infra/update-managed-service-handoff.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(root: string): Promise<UpdateRecoveryFence>;
};

/**
 * Reuse the native handoff owner for direct invocations too. Its database is
 * outside the canonical state family, so checking this fence never opens a
 * displaced/migrated source. Physical source exclusion remains a separate duty.
 */
export async function withUpdateCommandExecutor<T>(
  runId: string,
  operation: (executor: UpdateCommandExecutor) => Promise<T>,
): Promise<T> {
  let active = true;
  let entering = false;
  let store: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
  let lease: ManagedHandoffLease | undefined;
  let borrowed = false;
  const assertCurrent = () => {
    if (!active || !store || !lease || !store.owns(lease, "executor")) {
      throw new UpdateCommandRecoveryPendingError(
        "Update executor ownership is no longer current.",
      );
    }
  };
  const executor: UpdateCommandExecutor = {
    async enter(root) {
      if (!active || entering) {
        throw new UpdateCommandRecoveryPendingError("Update executor admission is closed or busy.");
      }
      const key = resolveUpdateInstallRoot(root);
      if (lease) {
        assertCurrent();
        if (lease.key !== key) {
          throw new UpdateCommandRecoveryPendingError("Update executor installation changed.");
        }
        return { assertCurrent };
      }
      entering = true;
      try {
        store = createManagedHandoffLeaseStore();
        const found = store.read(key);
        if (found.kind === "unreadable") {
          throw new UpdateCommandRecoveryPendingError("Update executor state is unreadable.");
        }
        if (
          found.kind === "current" &&
          found.lease.helper.pid !== process.pid &&
          found.lease.executor.pid === process.pid
        ) {
          const handedOff = await isCurrentManagedServiceUpdateHandoffProcess({ root: key, runId });
          // Retain the exact row observed before the await. Matching the run in
          // a later metadata read cannot authorize a different lease generation.
          if (
            !active ||
            !handedOff ||
            found.lease.action.kind !== "update" ||
            !store.owns(found.lease, "executor")
          ) {
            throw new UpdateCommandRecoveryPendingError(
              "Managed update executor changed during admission.",
            );
          }
          lease = found.lease;
          borrowed = true;
        } else {
          const acquired = store.acquire(key, randomUUID(), { kind: "update" });
          if (acquired.kind !== "acquired") {
            throw new UpdateCommandRecoveryPendingError(
              "Another update executor owns this installation.",
            );
          }
          lease = acquired.lease;
        }
        assertCurrent();
        return { assertCurrent };
      } finally {
        entering = false;
      }
    },
  };
  let outcome: { result: T } | { error: Error };
  try {
    const result = await operation(executor);
    if (lease) {
      assertCurrent();
    }
    outcome = { result };
  } catch (cause) {
    outcome = {
      error: cause instanceof Error ? cause : new Error("Update execution failed", { cause }),
    };
  }
  active = false;
  try {
    if (lease && store && !borrowed && !store.release(lease)) {
      throw new UpdateCommandRecoveryPendingError(
        "Update executor release could not be confirmed.",
      );
    }
  } catch (cause) {
    if ("error" in outcome) {
      throw new UpdateCommandRecoveryPendingError(
        "Update failed and executor release remains pending",
        {
          cause: new AggregateError([outcome.error, cause], "Update executor cleanup failed", {
            cause: outcome.error,
          }),
        },
      );
    }
    throw cause;
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.result;
}
