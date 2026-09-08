import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { WorkboardCardStore, WorkboardKeyedStore } from "./persistence-types.js";

export class WorkboardStoreRuntime {
  private readonly operationScope = new AsyncLocalStorage<{ active: boolean }>();
  private readonly operations = new Set<Promise<unknown>>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private readonly epoch = randomUUID();
  private revision = 0;
  private mutationRevision = 0;
  private externalDataVersion: number | undefined;
  private readonly listeners = new Set<(change: WorkboardChange) => void>();

  constructor(
    private readonly readDataVersion?: () => number,
    private readonly closePersistence?: () => void,
  ) {
    this.externalDataVersion = readDataVersion?.();
  }

  async runOperation<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.closePromise && !this.operationScope.getStore()?.active) {
      throw new Error("workboard store is closed.");
    }
    const context = { active: true };
    const operation = this.operationScope.run(context, async () => await run());
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      // Detached callbacks must not reuse admission after this operation settles.
      context.active = false;
      this.operations.delete(operation);
    }
  }

  close(): Promise<void> {
    this.closePromise ??= Promise.resolve().then(async () => {
      // Admitted operations can still add nested work. Callers own failures;
      // join the entire set before closing this generation's connection.
      while (this.operations.size > 0) {
        await Promise.allSettled(this.operations);
      }
      this.operationScope.disable();
      this.closePersistence?.();
    });
    return this.closePromise;
  }

  protected track<T>(
    store: WorkboardKeyedStore<T>,
    { notifyChanges = true }: { notifyChanges?: boolean } = {},
  ): WorkboardKeyedStore<T> {
    return {
      register: (key, value) =>
        this.runOperation(async () => {
          await store.register(key, value);
          if (notifyChanges) {
            this.mutationRevision += 1;
          }
        }),
      lookup: (key) => this.runOperation(() => store.lookup(key)),
      delete: (key) =>
        this.runOperation(async () => {
          const deleted = await store.delete(key);
          if (deleted && notifyChanges) {
            this.mutationRevision += 1;
          }
          return deleted;
        }),
      entries: () => this.runOperation(() => store.entries()),
    };
  }

  protected trackCardStore(store: WorkboardCardStore): WorkboardCardStore {
    return {
      ...this.track(store),
      registerIfAbsent: (key, value) =>
        this.runOperation(async () => {
          const inserted = await store.registerIfAbsent(key, value);
          if (inserted) {
            this.mutationRevision += 1;
          }
          return inserted;
        }),
      registerIfUpdatedAt: (key, value, expectedUpdatedAt) =>
        this.runOperation(async () => {
          const updated = await store.registerIfUpdatedAt(key, value, expectedUpdatedAt);
          if (updated) {
            this.mutationRevision += 1;
          }
          return updated;
        }),
      deleteIfUpdatedAt: (key, expectedUpdatedAt) =>
        this.runOperation(async () => {
          const deleted = await store.deleteIfUpdatedAt(key, expectedUpdatedAt);
          if (deleted) {
            this.mutationRevision += 1;
          }
          return deleted;
        }),
      claimIfOwnerAvailable: (key, value, expectedUpdatedAt, ownerId, now) =>
        this.runOperation(async () => {
          const result = await store.claimIfOwnerAvailable(
            key,
            value,
            expectedUpdatedAt,
            ownerId,
            now,
          );
          if (result === "updated") {
            this.mutationRevision += 1;
          }
          return result;
        }),
      listBoardAggregates: () => this.runOperation(() => store.listBoardAggregates()),
    };
  }

  subscribeChanges(listener: (change: WorkboardChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announceChangeEpoch(): void {
    this.emit();
  }

  reconcileExternalChanges(): boolean {
    if (!this.readDataVersion) {
      return false;
    }
    const current = this.readDataVersion();
    if (current === this.externalDataVersion) {
      return false;
    }
    this.externalDataVersion = current;
    this.emit();
    return true;
  }

  protected async enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    return await this.runOperation(async () => {
      const runAndNotify = async () => await this.runMutation(run);
      const result = this.mutationQueue.then(runAndNotify, runAndNotify);
      this.mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    });
  }

  private async runMutation<T>(run: () => Promise<T>): Promise<T> {
    const initialRevision = this.mutationRevision;
    try {
      return await run();
    } finally {
      if (this.mutationRevision !== initialRevision) {
        this.emit();
      }
    }
  }

  private emit(): void {
    const change = { epoch: this.epoch, revision: ++this.revision };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Persistence already succeeded. Observers cannot turn it into a reported failure.
      }
    }
  }
}
