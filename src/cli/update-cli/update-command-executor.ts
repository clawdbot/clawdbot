import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
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

/** Private correlation sent only to the spawned candidate's stdin. The receiver
 * independently reads both live owners and checks its own PID/start identity. */
export type UpdateCommandChildGrant = {
  runId: string;
  root: string;
  databasePath: string;
  parent: ManagedHandoffLease;
  childKey: string;
};
type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: (pid: number) => void,
) => Promise<T>;
const childOwners = new WeakMap<
  UpdateRecoveryFence,
  <T>(operation: ChildOperation<T>) => Promise<T>
>();

export async function withUpdateCommandExecutorChild<T>(
  fence: UpdateRecoveryFence,
  operation: ChildOperation<T>,
): Promise<T> {
  const owner = childOwners.get(fence);
  if (!owner) {
    throw new UpdateCommandRecoveryPendingError("Child continuation requires its live executor.");
  }
  return await owner(operation);
}

/** A child owns its separate lease while the original installation lease remains
 * held by the parent. Neither grant contents nor parent metadata grant authority. */
export async function withDelegatedUpdateCommandExecutor<T>(
  grant: UpdateCommandChildGrant,
  runId: string,
  root: string,
  operation: (fence: UpdateRecoveryFence) => Promise<T>,
): Promise<T> {
  const store = createManagedHandoffLeaseStore({
    databasePath: grant.databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  const parent = store.read(resolveUpdateInstallRoot(root));
  const child = store.read(grant.childKey);
  if (
    grant.runId !== runId ||
    grant.root !== resolveUpdateInstallRoot(root) ||
    parent.kind !== "current" ||
    !isDeepStrictEqual(parent.lease, grant.parent) ||
    parent.lease.action.kind !== "update" ||
    process.ppid !== parent.lease.executor.pid ||
    !grant.childKey.startsWith(`${parent.lease.key}/.openclaw-update-child-`) ||
    child.kind !== "current" ||
    child.lease.owner !== runId ||
    child.lease.action.kind !== "update" ||
    !isDeepStrictEqual(child.lease.helper, parent.lease.executor)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate executor binding does not match its parent.",
    );
  }
  let active = true;
  const fence = {
    assertCurrent() {
      if (
        !active ||
        !store.current(parent.lease) ||
        !store.isPidAlive(parent.lease.helper.pid) ||
        store.readProcessStartIdentity(parent.lease.helper.pid) !==
          parent.lease.helper.startIdentity ||
        // owns checks this child plus its helper: the original spawning updater,
        // not the long-lived helper of the primary installation lease.
        !store.owns(child.lease, "executor")
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Candidate executor ownership is no longer current.",
        );
      }
    },
  };
  try {
    fence.assertCurrent();
    const result = await operation(fence);
    fence.assertCurrent();
    return result;
  } finally {
    active = false;
  }
}

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
  let delegating = false;
  let childAdmissionOpen = true;
  let childWork: Promise<unknown> | undefined;
  let childFailure: Error | undefined;
  let databasePath: string | undefined;
  let store: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
  let lease: ManagedHandoffLease | undefined;
  let borrowed = false;
  const assertBase = () => {
    if (!active || !store || !lease || !store.owns(lease, "executor")) {
      throw new UpdateCommandRecoveryPendingError(
        "Update executor ownership is no longer current.",
      );
    }
  };
  const assertCurrent = () => {
    assertBase();
    if (delegating) {
      throw new UpdateCommandRecoveryPendingError(
        "Parent executor is suspended for its candidate.",
      );
    }
  };
  const fence = { assertCurrent };
  childOwners.set(
    fence,
    <ChildResult>(childOperation: ChildOperation<ChildResult>): Promise<ChildResult> => {
      assertCurrent();
      if (!childAdmissionOpen || !store || !lease || !databasePath) {
        throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
      }
      const control = store;
      const original = lease;
      const acquired = control.acquire(
        `${original.key}/.openclaw-update-child-${randomUUID()}`,
        runId,
        { kind: "update" },
      );
      if (acquired.kind !== "acquired") {
        throw new UpdateCommandRecoveryPendingError("Candidate lifetime could not be acquired.");
      }
      let childLease = acquired.lease;
      let bound = false;
      delegating = true;
      const grant: UpdateCommandChildGrant = {
        runId,
        root: original.key,
        databasePath,
        parent: original,
        childKey: childLease.key,
      };
      const running = async () => {
        let outcome: { result: ChildResult } | { error: Error };
        try {
          const result = await childOperation(grant, (pid) => {
            assertBase();
            if (bound || pid === process.pid) {
              throw new UpdateCommandRecoveryPendingError(
                "Candidate process can be bound only once.",
              );
            }
            const assigned = control.bind(childLease, pid);
            if (!assigned) {
              throw new UpdateCommandRecoveryPendingError("Candidate process binding failed.");
            }
            childLease = assigned;
            bound = true;
          });
          if (!bound) {
            throw new UpdateCommandRecoveryPendingError(
              "Candidate continuation did not bind a process.",
            );
          }
          assertBase();
          outcome = { result };
        } catch (cause) {
          outcome = {
            error: cause instanceof Error ? cause : new Error("Candidate failed", { cause }),
          };
        }
        try {
          // Release refuses a live child. Never reactivate the parent on timeout
          // until the process owner has actually joined the candidate.
          if (!control.release(childLease)) {
            throw new UpdateCommandRecoveryPendingError("Candidate executor has not settled.");
          }
          delegating = false;
        } catch (cause) {
          if ("error" in outcome) {
            throw new AggregateError(
              [outcome.error, cause],
              "Candidate and its executor cleanup failed",
              { cause },
            );
          }
          throw cause;
        }
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.result;
      };
      const pending = Promise.resolve().then(running);
      childWork = pending;
      void pending
        .catch((cause: unknown) => {
          childFailure = cause instanceof Error ? cause : new Error("Candidate failed", { cause });
        })
        .finally(() => {
          if (childWork === pending) {
            childWork = undefined;
          }
        });
      return pending;
    },
  );
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
        return fence;
      }
      entering = true;
      try {
        databasePath = resolveManagedUpdateLeaseDatabasePath();
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
        return fence;
      } finally {
        entering = false;
      }
    },
  };
  let outcome: { result: T } | { error: Error };
  try {
    const result = await operation(executor);
    childAdmissionOpen = false;
    await childWork;
    if (childFailure) {
      throw childFailure;
    }
    if (lease) {
      assertCurrent();
    }
    outcome = { result };
  } catch (cause) {
    outcome = {
      error: cause instanceof Error ? cause : new Error("Update execution failed", { cause }),
    };
  }
  childAdmissionOpen = false;
  try {
    await childWork;
  } catch (cause) {
    outcome = {
      error:
        "error" in outcome && outcome.error !== cause
          ? new AggregateError([outcome.error, cause], "Update and candidate settlement failed", {
              cause,
            })
          : cause instanceof Error
            ? cause
            : new Error("Candidate settlement failed", { cause }),
    };
  }
  active = false;
  childOwners.delete(fence);
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
