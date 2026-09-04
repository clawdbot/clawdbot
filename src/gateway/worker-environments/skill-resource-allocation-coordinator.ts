import type { DatabaseSync } from "node:sqlite";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import {
  withOpenClawStateLease,
  type OpenClawStateLeaseContext,
} from "../../state/openclaw-state-lease.js";
import {
  cleanupSkillResourceAllocation,
  finalizeSkillResourceAllocationCleanup,
} from "./skill-resource-allocation-cleanup.js";
import {
  createSkillResourceAllocationLedger,
  type SkillResourceAllocationIntent,
  type SkillResourceAllocationLedger,
  type SkillResourceAllocationLocation,
  type SkillResourceAllocationRecord,
} from "./skill-resource-allocation-ledger.js";
import { SKILL_RESOURCE_RUNTIME_SCRIPT } from "./skill-resource-transfer.js";
import { isWorkerEnvironmentGone, type WorkerEnvironmentState } from "./state.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";

type AllocationTunnel = Pick<WorkerTunnelHandle, "runWorkspaceCommand">;

type SkillResourceAllocationCoordinatorOptions = {
  ownershipDatabaseOptions?: OpenClawStateDatabaseOptions;
  ownershipLeaseMs?: number;
};

const OWNERSHIP_LEASE_SCOPE = "worker.skill-resource-allocation-owner.v1";
const OWNERSHIP_LEASE_KEY = "gateway";
const DEFAULT_OWNERSHIP_LEASE_MS = 15_000;

function asOwnershipError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Skill resource allocation owner failed", { cause: error });
}

export type SkillResourceAllocationRecoveryOptions = {
  getEnvironment: (environmentId: string) =>
    | {
        state: WorkerEnvironmentState;
        ownerEpoch: number;
        leaseId: string | null;
        destroyRequestedAtMs?: number | null;
      }
    | undefined;
  startTunnel: (request: {
    environmentId: string;
    ownerEpoch: number;
  }) => Promise<WorkerTunnelHandle>;
  onEnvironmentCleanupDeferred?: (environmentId: string) => void;
  warn?: (message: string) => void;
};

/** Owns the live-operation fence around the durable allocation ledger. */
export class SkillResourceAllocationCoordinator {
  readonly ledger: SkillResourceAllocationLedger;
  private readonly active = new Set<string>();
  private readonly ownershipDatabaseOptions: OpenClawStateDatabaseOptions | undefined;
  private readonly ownershipLeaseMs: number;
  private ownershipContext: OpenClawStateLeaseContext | undefined;
  private ownershipReady: Promise<void> | undefined;
  private ownershipRun: Promise<void> | undefined;
  private releaseOwnership: (() => void) | undefined;
  private ownershipAbort: AbortController | undefined;
  private ownershipFailure: Error | undefined;
  private recoveryInFlight: Promise<void> | undefined;
  private stopping = false;

  constructor(
    ledger: SkillResourceAllocationLedger = createSkillResourceAllocationLedger(),
    options: SkillResourceAllocationCoordinatorOptions = {},
  ) {
    this.ledger = ledger;
    this.ownershipDatabaseOptions = options.ownershipDatabaseOptions;
    this.ownershipLeaseMs = options.ownershipLeaseMs ?? DEFAULT_OWNERSHIP_LEASE_MS;
  }

  private async ensureOwnership(admittedBeforeStop = false): Promise<void> {
    if (this.stopping && !admittedBeforeStop) {
      throw new Error("Skill resource allocation coordinator is stopping");
    }
    if (this.ownershipContext) {
      this.assertOwned();
      return;
    }
    let ownershipReady = this.ownershipReady;
    if (!ownershipReady) {
      const ready = createDeferredCore();
      const release = createDeferredCore();
      const abort = new AbortController();
      let readyResolved = false;
      this.ownershipAbort = abort;
      ownershipReady = ready.promise;
      this.ownershipReady = ownershipReady;
      this.ownershipRun = withOpenClawStateLease(
        {
          scope: OWNERSHIP_LEASE_SCOPE,
          key: OWNERSHIP_LEASE_KEY,
          database: { scope: "shared", options: this.ownershipDatabaseOptions },
          leaseMs: this.ownershipLeaseMs,
          waitMs: 0,
          signal: abort.signal,
          heartbeat: "worker",
          leaseLabel: "skill resource allocation owner",
          operationLabel: "worker.skill-resource-allocation.owner",
        },
        async (context) => {
          if (this.stopping && !admittedBeforeStop) {
            throw new Error("Skill resource allocation coordinator is stopping");
          }
          this.ownershipContext = context;
          this.releaseOwnership = release.resolve;
          readyResolved = true;
          ready.resolve();
          await Promise.race([
            release.promise,
            new Promise<void>((resolve) => {
              context.signal.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
        },
      )
        .catch((error: unknown) => {
          if (!readyResolved) {
            ready.reject(error);
          } else if (!this.stopping) {
            this.ownershipFailure = asOwnershipError(error);
          }
        })
        .finally(() => {
          this.ownershipContext = undefined;
          this.releaseOwnership = undefined;
          this.ownershipAbort = undefined;
          this.ownershipReady = undefined;
          this.ownershipRun = undefined;
        });
    }
    await ownershipReady;
    this.assertOwned();
  }

  assertOwned(): void {
    if (this.ownershipFailure) {
      throw this.ownershipFailure;
    }
    const context = this.ownershipContext;
    if (!context) {
      throw new Error("Skill resource allocation owner is unavailable");
    }
    try {
      context.assertOwned();
    } catch (error) {
      const failure = asOwnershipError(error);
      this.ownershipFailure = failure;
      throw failure;
    }
  }

  private assertOwnedInTransaction = (database: DatabaseSync): void => {
    const context = this.ownershipContext;
    if (!context) {
      throw new Error("Skill resource allocation owner is unavailable");
    }
    try {
      context.assertOwnedInTransaction(database);
    } catch (error) {
      const failure = asOwnershipError(error);
      this.ownershipFailure = failure;
      throw failure;
    }
  };

  async createIntent(
    intent: SkillResourceAllocationIntent,
  ): Promise<SkillResourceAllocationRecord> {
    await this.ensureOwnership();
    this.assertOwned();
    if (this.active.has(intent.allocationId)) {
      throw new Error("Skill resource allocation is already active in this Gateway");
    }
    this.active.add(intent.allocationId);
    try {
      const record = await this.ledger.createIntent(intent, this.assertOwnedInTransaction);
      this.assertOwned();
      return record;
    } catch (error) {
      this.active.delete(intent.allocationId);
      throw error;
    }
  }

  async markAllocated(
    record: SkillResourceAllocationRecord,
    location: SkillResourceAllocationLocation,
  ): Promise<SkillResourceAllocationRecord> {
    this.assertOwned();
    if (!this.active.has(record.allocationId)) {
      throw new Error("Skill resource allocation is not active in this Gateway");
    }
    const allocated = await this.ledger.markAllocated(
      record.allocationId,
      record.revision,
      location,
      this.assertOwnedInTransaction,
    );
    this.assertOwned();
    return allocated;
  }

  async retire(
    record: SkillResourceAllocationRecord,
    tunnel: AllocationTunnel,
    assertCurrent: () => void,
  ): Promise<void> {
    try {
      this.assertOwned();
      let pending = record.phase === "cleanup-pending" ? record : undefined;
      let complete = record.phase === "cleanup-complete" ? record : undefined;
      if (!pending && !complete) {
        try {
          pending = await this.ledger.markCleanupPending(
            record.allocationId,
            record.revision,
            this.assertOwnedInTransaction,
          );
        } catch (error) {
          const current = (await this.ledger.list(this.assertOwnedInTransaction)).find(
            (candidate) => candidate.allocationId === record.allocationId,
          );
          if (current?.phase === "cleanup-complete") {
            complete = current;
          } else if (current?.phase !== "cleanup-pending") {
            throw error;
          } else {
            pending = current;
          }
        }
      }
      const assertOwnedCurrent = () => {
        this.assertOwned();
        assertCurrent();
      };
      if (!complete) {
        if (!pending) {
          throw new Error("Skill resource allocation cleanup state is unavailable");
        }
        await cleanupSkillResourceAllocation({
          record: pending,
          runtimeScript: SKILL_RESOURCE_RUNTIME_SCRIPT,
          tunnel,
          assertCurrent: assertOwnedCurrent,
        });
        complete = await this.ledger.markCleanupComplete(
          pending.allocationId,
          pending.revision,
          this.assertOwnedInTransaction,
        );
      }
      await finalizeSkillResourceAllocationCleanup({
        record: complete,
        runtimeScript: SKILL_RESOURCE_RUNTIME_SCRIPT,
        tunnel,
        assertCurrent: assertOwnedCurrent,
      });
      await this.ledger.remove(
        complete.allocationId,
        complete.revision,
        this.assertOwnedInTransaction,
      );
    } finally {
      this.active.delete(record.allocationId);
    }
  }

  abandon(allocationId: string): void {
    this.active.delete(allocationId);
  }

  recover(options: SkillResourceAllocationRecoveryOptions): Promise<void> {
    if (this.stopping) {
      return Promise.reject(new Error("Skill resource allocation coordinator is stopping"));
    }
    const prior = this.recoveryInFlight;
    const recovery = (prior ? prior.catch(() => undefined) : Promise.resolve())
      .then(() => this.ensureOwnership(true))
      .then(() => this.recoverPass(options));
    this.recoveryInFlight = recovery;
    return recovery.finally(() => {
      if (this.recoveryInFlight === recovery) {
        this.recoveryInFlight = undefined;
      }
    });
  }

  private async recoverPass(options: SkillResourceAllocationRecoveryOptions): Promise<void> {
    this.assertOwned();
    const records = await this.ledger.list(this.assertOwnedInTransaction);
    for (const record of records) {
      this.assertOwned();
      const environment = options.getEnvironment(record.environmentId);
      if (this.active.has(record.allocationId)) {
        if (
          environment &&
          (environment.destroyRequestedAtMs != null ||
            !["ready", "idle", "attached"].includes(environment.state))
        ) {
          // The turn still owns remote cleanup. Keep its terminal placement evidence until
          // retire() either finishes or leaves the durable row for a replacement Gateway.
          options.onEnvironmentCleanupDeferred?.(record.environmentId);
        }
        continue;
      }
      if (environment && isWorkerEnvironmentGone(environment)) {
        try {
          // The terminal state and cleared-lease policy are the provider lifecycle's durable
          // proof that the workspace no longer exists. Do not reopen that placement.
          await this.ledger.removeAfterEnvironmentDestroyed(
            record.allocationId,
            record.revision,
            this.assertOwnedInTransaction,
          );
        } catch {
          options.onEnvironmentCleanupDeferred?.(record.environmentId);
          options.warn?.(
            `Skill resource allocation cleanup remains queued (${record.environmentId}, ${record.allocationId})`,
          );
        }
        continue;
      }
      if (
        !environment ||
        environment.destroyRequestedAtMs != null ||
        !["ready", "idle", "attached"].includes(environment.state)
      ) {
        if (environment) {
          // Keep the environment record until provider reconciliation either restores a
          // tunnel or records destruction. Pruning it would erase the cleanup proof owner.
          options.onEnvironmentCleanupDeferred?.(record.environmentId);
        }
        options.warn?.(
          `Skill resource allocation cleanup remains queued (${record.environmentId}, ${record.allocationId})`,
        );
        continue;
      }
      // The allocation secret and inode tuple, rather than the environment epoch, authorize
      // cleanup. A replacement placement for the same environment must therefore clean the
      // prior epoch's durable allocation instead of stranding it forever.
      const recoveryOwnerEpoch = environment.ownerEpoch;
      try {
        const tunnel = await options.startTunnel({
          environmentId: record.environmentId,
          ownerEpoch: recoveryOwnerEpoch,
        });
        const assertCurrent = () => {
          const current = options.getEnvironment(record.environmentId);
          if (
            !current ||
            current.ownerEpoch !== recoveryOwnerEpoch ||
            current.destroyRequestedAtMs != null ||
            !["ready", "idle", "attached"].includes(current.state)
          ) {
            throw new Error("Skill resource recovery lost its exact placement authority");
          }
        };
        await this.retire(record, tunnel, assertCurrent);
      } catch {
        options.onEnvironmentCleanupDeferred?.(record.environmentId);
        options.warn?.(
          `Skill resource allocation cleanup remains queued (${record.environmentId}, ${record.allocationId})`,
        );
      }
    }
  }

  async closeRecoveryAdmission(): Promise<void> {
    this.stopping = true;
    const recovery = this.recoveryInFlight;
    if (recovery) {
      await Promise.allSettled([recovery]);
    }
  }

  async stop(): Promise<void> {
    await this.closeRecoveryAdmission();
    if (this.ownershipContext) {
      this.releaseOwnership?.();
    } else {
      this.ownershipAbort?.abort(
        new DOMException("Skill resource allocation coordinator stopped", "AbortError"),
      );
    }
    await this.ownershipRun;
  }
}

export function createSkillResourceAllocationCoordinator(
  ledger?: SkillResourceAllocationLedger,
  options?: SkillResourceAllocationCoordinatorOptions,
): SkillResourceAllocationCoordinator {
  return new SkillResourceAllocationCoordinator(ledger, options);
}
