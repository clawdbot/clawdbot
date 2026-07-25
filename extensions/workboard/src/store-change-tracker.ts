import { randomUUID } from "node:crypto";
import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { WorkboardKeyedStore } from "./persistence-types.js";

export class WorkboardChangeTracker {
  private readonly epoch = randomUUID();
  private revision = 0;
  private mutationRevision = 0;
  private externalDataVersion: number | undefined;
  private readonly listeners = new Set<(change: WorkboardChange) => void>();

  constructor(private readonly readDataVersion?: () => number) {
    this.externalDataVersion = readDataVersion?.();
  }

  track<T>(store: WorkboardKeyedStore<T>): WorkboardKeyedStore<T> {
    return {
      register: async (key, value) => {
        await store.register(key, value);
        this.mutationRevision += 1;
      },
      lookup: async (key) => await store.lookup(key),
      delete: async (key) => {
        const deleted = await store.delete(key);
        if (deleted) {
          this.mutationRevision += 1;
        }
        return deleted;
      },
      entries: async () => await store.entries(),
    };
  }

  subscribe(listener: (change: WorkboardChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announceEpoch(): void {
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

  async runMutation<T>(run: () => Promise<T>): Promise<T> {
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
