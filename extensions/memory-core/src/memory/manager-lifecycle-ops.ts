// Memory Core plugin module owns lifecycle reconciliation outside interactive search.
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MemoryKeywordRetrieval } from "./manager-keyword-retrieval.js";
import { inspectMemorySourceState } from "./manager-source-state.js";

const log = createSubsystemLogger("memory");
const MEMORY_LIFECYCLE_BUSY_RETRY_DELAY_MS = 30_000;
const MEMORY_LIFECYCLE_INITIAL_RECONCILE_DELAY_MS = 60_000;
const MEMORY_LIFECYCLE_SAFETY_SWEEP_INTERVAL_MS = 5 * 60_000;

export abstract class MemoryManagerLifecycleOps extends MemoryKeywordRetrieval {
  private lifecycleSafetySweepTimer: NodeJS.Timeout | null = null;
  private lifecycleSafetySweep: Promise<void> | null = null;

  protected abstract hasPublishedSyncInFlight(): boolean;

  protected ensureInitialLifecycleSafetySweep(): void {
    this.ensureLifecycleSafetySweep(MEMORY_LIFECYCLE_INITIAL_RECONCILE_DELAY_MS);
  }

  protected clearLifecycleSafetySweepTimer(): void {
    if (!this.lifecycleSafetySweepTimer) {
      return;
    }
    clearTimeout(this.lifecycleSafetySweepTimer);
    this.lifecycleSafetySweepTimer = null;
  }

  private ensureLifecycleSafetySweep(delayMs = MEMORY_LIFECYCLE_SAFETY_SWEEP_INTERVAL_MS): void {
    const canInspectMemory = this.sources.has("memory") && this.settings.sync.watch;
    const canRetrySessions = this.sources.has("sessions");
    if (
      this.closing ||
      this.closed ||
      this.purpose !== "default" ||
      (!canInspectMemory && !canRetrySessions) ||
      this.lifecycleSafetySweepTimer ||
      this.lifecycleSafetySweep
    ) {
      return;
    }
    this.lifecycleSafetySweepTimer = setTimeout(() => {
      this.lifecycleSafetySweepTimer = null;
      this.startLifecycleSafetySweep();
    }, delayMs);
  }

  private hasConflictingLifecycleWork(allowCurrentSweep = false): boolean {
    return (
      this.watchTimer !== null ||
      this.watchSyncSettling ||
      this.activeManagerOperations > 0 ||
      this.activeBackgroundMaintenance.size > (allowCurrentSweep ? 1 : 0) ||
      this.hasPublishedSyncInFlight()
    );
  }

  private startLifecycleSafetySweep(): void {
    if (this.closing || this.closed || this.lifecycleSafetySweep) {
      return;
    }
    if (this.hasConflictingLifecycleWork()) {
      this.ensureLifecycleSafetySweep(MEMORY_LIFECYCLE_BUSY_RETRY_DELAY_MS);
      return;
    }

    let nextSweepDelayMs = MEMORY_LIFECYCLE_SAFETY_SWEEP_INTERVAL_MS;
    const trackedSweep = (async () => {
      try {
        const canInspectMemory = this.sources.has("memory") && this.settings.sync.watch;
        if (
          canInspectMemory &&
          !this.dirty &&
          !this.sessionsDirty &&
          !this.memoryFullRetryDirty &&
          !this.sessionsFullRetryDirty
        ) {
          const inspection = await inspectMemorySourceState({
            db: this.db,
            workspaceDir: this.workspaceDir,
            settings: this.settings,
            concurrency: this.getIndexConcurrency(),
          });
          // Lifecycle drift checks must not opt interactive status calls into
          // explicit diagnostics and their storage payload scans.
          if (inspection.dirty) {
            this.dirty = true;
          }
        }

        if (this.closing || this.closed) {
          return;
        }
        if (this.hasConflictingLifecycleWork(true)) {
          nextSweepDelayMs = MEMORY_LIFECYCLE_BUSY_RETRY_DELAY_MS;
          return;
        }

        const hasFullRetry = this.memoryFullRetryDirty || this.sessionsFullRetryDirty;
        if (!this.dirty && !this.sessionsDirty && !hasFullRetry) {
          return;
        }
        if (hasFullRetry) {
          await this.syncPublishedIndexInBackground({ reason: "sweep" });
          if (
            (this.dirty || this.sessionsDirty) &&
            !this.memoryFullRetryDirty &&
            !this.sessionsFullRetryDirty
          ) {
            await this.sync({ reason: "sweep" });
          }
          return;
        }
        await this.sync({ reason: "sweep" });
      } catch (err) {
        log.warn(`memory lifecycle safety sweep failed: ${String(err)}`);
      }
    })().finally(() => {
      this.activeBackgroundMaintenance.delete(trackedSweep);
      if (this.lifecycleSafetySweep === trackedSweep) {
        this.lifecycleSafetySweep = null;
      }
      this.ensureLifecycleSafetySweep(nextSweepDelayMs);
    });

    this.lifecycleSafetySweep = trackedSweep;
    this.activeBackgroundMaintenance.add(trackedSweep);
  }
}
