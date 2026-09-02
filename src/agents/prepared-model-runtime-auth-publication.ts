import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { ownerKey, resolveConfiguredOwner } from "./prepared-model-runtime.owner.js";
import type {
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeReplacementGateId,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

export type PreparedModelRuntimeAuthMutation = {
  agentDir?: string;
  affectsInheritedStores: boolean;
  profileSetChanged: boolean;
};

type PreparedModelRuntimeAuthTransaction = {
  adoptedBy?: PreparedModelRuntimeReplacementGateId;
  ownerGates: Map<PreparedModelRuntimeOwner, Deferred<PreparedModelRuntimeSnapshot>>;
  publicationQueued: boolean;
  profileSetChanged: boolean;
};

function partitionAuthMutationOwners(
  mutations: readonly (readonly PreparedModelRuntimeOwner[])[],
): PreparedModelRuntimeOwner[][] {
  // Overlapping owner identities share one atomic failure boundary. Independent components
  // retain FIFO order so one scoped credential failure cannot poison an unrelated owner.
  const components: Set<PreparedModelRuntimeOwner>[] = [];
  for (const invalidatedOwners of mutations) {
    const target = new Set(invalidatedOwners);
    let insertAt = components.length;
    for (let index = components.length - 1; index >= 0; index -= 1) {
      if (![...target].some((owner) => components[index]!.has(owner))) {
        continue;
      }
      insertAt = index;
      for (const owner of components[index]!) {
        target.add(owner);
      }
      components.splice(index, 1);
    }
    components.splice(insertAt, 0, target);
  }
  return components.map((component) => Array.from(component));
}

export class PreparedModelRuntimeAuthPublicationOwner {
  readonly #events: (readonly PreparedModelRuntimeOwner[])[] = [];
  #transaction: PreparedModelRuntimeAuthTransaction | undefined;

  enqueue(
    invalidatedOwners: readonly PreparedModelRuntimeOwner[],
    profileSetChanged = false,
  ): PreparedModelRuntimeAuthTransaction {
    this.#events.push([...invalidatedOwners]);
    const transaction =
      this.#transaction ??
      (this.#transaction = {
        ownerGates: new Map(),
        publicationQueued: false,
        profileSetChanged: false,
      });
    transaction.profileSetChanged ||= profileSetChanged;
    for (const owner of invalidatedOwners) {
      let gate = transaction.ownerGates.get(owner);
      if (!gate) {
        gate = createDeferredCore<PreparedModelRuntimeSnapshot>();
        transaction.ownerGates.set(owner, gate);
        void gate.promise.catch(() => undefined);
      }
      owner.pending = gate.promise;
    }
    return transaction;
  }

  claimPublication(transaction: PreparedModelRuntimeAuthTransaction): boolean {
    if (transaction.publicationQueued) {
      return false;
    }
    transaction.publicationQueued = true;
    return true;
  }

  isCurrent(transaction: PreparedModelRuntimeAuthTransaction): boolean {
    return this.#transaction === transaction;
  }

  adopt(gateId: PreparedModelRuntimeReplacementGateId): void {
    if (this.#transaction) {
      this.#transaction.adoptedBy = gateId;
    }
  }

  adoptTransaction(
    transaction: PreparedModelRuntimeAuthTransaction,
    gateId: PreparedModelRuntimeReplacementGateId,
  ): void {
    if (this.#transaction === transaction) {
      transaction.adoptedBy = gateId;
    }
  }

  prepareAdoptedCommit(
    gateId: PreparedModelRuntimeReplacementGateId,
  ): PreparedModelRuntimeAuthTransaction | undefined {
    const transaction = this.#transaction;
    if (transaction?.adoptedBy !== gateId) {
      return undefined;
    }
    this.clearOwnerGates(transaction);
    return transaction;
  }

  resolve(
    transaction: PreparedModelRuntimeAuthTransaction,
    owners: Map<string, PreparedModelRuntimeOwner>,
  ): boolean {
    if (this.#transaction !== transaction) {
      return false;
    }
    if (transaction.adoptedBy) {
      this.#transaction = undefined;
    } else if (transaction.ownerGates.size === 0) {
      this.#transaction = undefined;
      return true;
    } else {
      return false;
    }
    this.clearOwnerGates(transaction);
    for (const [owner, gate] of transaction.ownerGates) {
      const published =
        owners.get(ownerKey(owner.input)) ?? resolveConfiguredOwner(owners, owner.input);
      if (published?.snapshot && !published.needsRefresh && !published.pending) {
        gate.resolve(published.snapshot);
      } else {
        gate.reject(
          new PreparedModelRuntimePublicationSupersededError(
            `prepared model runtime publication was superseded for ${owner.input.agentDir}`,
          ),
        );
      }
    }
    return true;
  }

  settleComponent(
    transaction: PreparedModelRuntimeAuthTransaction,
    componentOwners: readonly PreparedModelRuntimeOwner[],
    owners: Map<string, PreparedModelRuntimeOwner>,
    publishOwners: (owners: readonly PreparedModelRuntimeOwner[]) => void,
  ): void {
    if (this.#transaction !== transaction || transaction.adoptedBy) {
      return;
    }
    const queuedOwners = new Set(this.#events.flat());
    const unsettled = componentOwners.flatMap((owner) => {
      const gate = transaction.ownerGates.get(owner);
      return gate && !queuedOwners.has(owner) ? [{ owner, gate }] : [];
    });
    const completed = unsettled.flatMap(({ owner, gate }) =>
      owner.pending === gate.promise &&
      owners.get(ownerKey(owner.input)) === owner &&
      owner.snapshot &&
      !owner.needsRefresh
        ? [{ owner, gate, snapshot: owner.snapshot }]
        : [],
    );
    // Dispatch projection must become visible before exact-gate waiters resume.
    for (const { owner } of completed) {
      owner.pending = undefined;
    }
    try {
      if (completed.length > 0) {
        publishOwners(completed.map(({ owner }) => owner));
      }
    } catch (error) {
      for (const { owner, gate } of completed) {
        if (transaction.ownerGates.get(owner) === gate && owner.pending === undefined) {
          owner.pending = gate.promise;
        }
      }
      throw error;
    }
    for (const { owner, gate, snapshot } of completed) {
      transaction.ownerGates.delete(owner);
      gate.resolve(snapshot);
    }
    this.rejectComponentOwners(
      transaction,
      componentOwners,
      new PreparedModelRuntimePublicationSupersededError(
        "prepared model runtime auth publication owner was superseded",
      ),
    );
  }

  reject(transaction: PreparedModelRuntimeAuthTransaction, error: Error): void {
    if (this.#transaction === transaction) {
      this.#transaction = undefined;
    }
    this.clearOwnerGates(transaction);
    for (const gate of transaction.ownerGates.values()) {
      gate.reject(error);
    }
  }

  rejectAdopted(gateId: PreparedModelRuntimeReplacementGateId, error: Error): void {
    if (this.#transaction?.adoptedBy === gateId) {
      this.reject(this.#transaction, error);
    }
  }

  async drain(params: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    publish: (
      entries: Array<{
        owner: PreparedModelRuntimeOwner;
        input: PreparedModelRuntimeOwner["input"];
      }>,
      includeCredentialProviders: boolean,
    ) => Promise<void>;
    publishOwners: (owners: readonly PreparedModelRuntimeOwner[]) => void;
    commit?: () => void;
    onOwnerFailure?: (error: unknown) => void;
  }): Promise<void> {
    while (this.#events.length > 0) {
      const components = partitionAuthMutationOwners(this.#events.splice(0));
      for (const componentOwners of components) {
        const entries = componentOwners.flatMap((owner) =>
          params.owners.get(ownerKey(owner.input)) === owner ? [{ owner, input: owner.input }] : [],
        );
        try {
          if (entries.length > 0) {
            await params.publish(entries, this.#transaction?.profileSetChanged === true);
          }
          const transaction = this.#transaction;
          if (transaction) {
            this.settleComponent(transaction, componentOwners, params.owners, params.publishOwners);
          }
        } catch (error) {
          if (this.#transaction?.adoptedBy) {
            // The replacement transaction exclusively settles adopted gates from its own result.
            throw error;
          }
          const transaction = this.#transaction;
          if (transaction && this.rejectComponentOwners(transaction, componentOwners, error) > 0) {
            params.onOwnerFailure?.(error);
          }
        }
      }
    }
    // The queue check and commit share one synchronous section so no mutation can be orphaned.
    params.commit?.();
  }

  reset(error: Error): void {
    if (this.#transaction) {
      this.reject(this.#transaction, error);
    }
    this.#events.length = 0;
  }

  private clearOwnerGates(transaction: PreparedModelRuntimeAuthTransaction): void {
    for (const [owner, gate] of transaction.ownerGates) {
      if (owner.pending === gate.promise) {
        owner.pending = undefined;
      }
    }
  }

  private rejectComponentOwners(
    transaction: PreparedModelRuntimeAuthTransaction,
    componentOwners: readonly PreparedModelRuntimeOwner[],
    error: unknown,
  ): number {
    const queuedOwners = new Set(this.#events.flat());
    let rejected = 0;
    for (const owner of componentOwners) {
      if (queuedOwners.has(owner)) {
        continue;
      }
      const gate = transaction.ownerGates.get(owner);
      if (!gate) {
        continue;
      }
      if (owner.pending === gate.promise) {
        owner.pending = undefined;
      }
      transaction.ownerGates.delete(owner);
      gate.reject(error);
      rejected += 1;
    }
    return rejected;
  }
}
