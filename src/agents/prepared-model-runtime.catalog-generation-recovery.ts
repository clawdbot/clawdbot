import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import {
  createPreparedModelRuntimeReplacement,
  ownerKey,
  publishPreparedModelRuntimeOwnerBatch,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import { notifyPreparedModelRuntimePublication } from "./prepared-model-runtime.publication-events.js";

type RecoveryDependencies = {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  buildTimeoutMs: number;
  getPendingReplacement: () => PreparedModelRuntimeReplacement | undefined;
  setPendingReplacement: (replacement: PreparedModelRuntimeReplacement | undefined) => void;
  adoptAuthPublication: (replacement: PreparedModelRuntimeReplacement) => void;
  commitAuthPublication: (replacement: PreparedModelRuntimeReplacement) => void;
  rejectAuthPublication: (replacement: PreparedModelRuntimeReplacement, error: Error) => void;
  removeReplyDispatch: (agentIds: ReadonlySet<string>) => void;
  enqueuePublication: (task: () => Promise<void>) => Promise<void>;
  drainPendingAuthMutations: (commit: () => void) => Promise<void>;
};

export class PreparedModelCatalogGenerationRecoveryOwner {
  #recoveries = new WeakMap<PreparedModelRuntimeOwner, Promise<void>>();

  reset(): void {
    this.#recoveries = new WeakMap();
  }

  async replace(
    snapshot: PreparedModelRuntimeSnapshot,
    dependencies: RecoveryDependencies,
  ): Promise<boolean> {
    const owner = [...dependencies.owners.values()].find(
      (candidate) => candidate.snapshot === snapshot,
    );
    if (!owner || owner.provenance !== "configured") {
      return false;
    }
    const activeRecovery = this.#recoveries.get(owner);
    if (activeRecovery) {
      await activeRecovery;
      return true;
    }
    const pendingReplacement = dependencies.getPendingReplacement();
    if (pendingReplacement) {
      await pendingReplacement.promise;
      return true;
    }

    const key = ownerKey(owner.input);
    const replacement = createPreparedModelRuntimeReplacement();
    dependencies.setPendingReplacement(replacement);
    dependencies.adoptAuthPublication(replacement);
    const staleError = new Error(
      `prepared model runtime catalog generation was invalid for ${owner.input.agentDir}`,
    );
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
    owner.pluginGeneration = undefined;
    if (owner.input.agentId) {
      dependencies.removeReplyDispatch(new Set([owner.input.agentId]));
    }
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });

    const recovery = dependencies.enqueuePublication(async () => {
      if (dependencies.owners.get(key) !== owner || owner.snapshot !== snapshot) {
        return;
      }
      await publishPreparedModelRuntimeOwnerBatch({
        entries: [{ owner, input: owner.input }],
        owners: dependencies.owners,
        agentBuildCompletions: dependencies.agentBuildCompletions,
        buildTimeoutMs: dependencies.buildTimeoutMs,
      });
      await dependencies.drainPendingAuthMutations(() =>
        dependencies.commitAuthPublication(replacement),
      );
    });
    this.#recoveries.set(owner, recovery);
    try {
      await recovery;
      if (dependencies.getPendingReplacement() === replacement) {
        dependencies.setPendingReplacement(undefined);
        replacement.resolve();
        notifyPreparedModelRuntimePublication({ phase: "published" });
      }
    } catch (error) {
      const refreshError = toStringifiedError(error);
      if (dependencies.getPendingReplacement() === replacement) {
        dependencies.setPendingReplacement(undefined);
        dependencies.rejectAuthPublication(replacement, refreshError);
        replacement.reject(refreshError);
        notifyPreparedModelRuntimePublication({ phase: "failed", error: refreshError });
      }
      throw refreshError;
    } finally {
      if (this.#recoveries.get(owner) === recovery) {
        this.#recoveries.delete(owner);
      }
    }
    return true;
  }
}
