import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const retentionLog = createSubsystemLogger("node-host/worker-retention");

/** Coalesces lifecycle-owned maintenance without delaying durable terminal outcomes. */
export class NodeWorkerRetention {
  private operation?: Promise<void>;
  private pending = false;

  constructor(
    private readonly store: NodeWorkerLaunchStore,
    private readonly workspace: NodeWorkerWorkspaceRuntime,
  ) {}

  schedule(trigger: string): Promise<void> {
    this.pending = true;
    if (this.operation) {
      return this.operation;
    }
    const operation = (async () => {
      while (this.pending) {
        this.pending = false;
        try {
          const result = await this.workspace.pruneSupersededGenerations(() =>
            this.store.listNonterminal(),
          );
          if (result.deleted > 0) {
            retentionLog.info("pruned node worker workspace generations", {
              count: result.deleted,
              reason: "superseded-workspace-generation",
              trigger,
            });
          }
          // Keep each filesystem pass bounded while draining an inherited backlog.
          // Every continuation rebuilds latest/active ownership before deleting again.
          this.pending ||= result.hasMore;
        } catch (error) {
          retentionLog.warn("node worker workspace generation pruning failed", {
            error: formatErrorMessage(error),
            trigger,
          });
        }
      }
    })();
    this.operation = operation.finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
}
