// Agent Core module implements memory storage behavior.
import type { SessionMetadata, SessionTreeEntry } from "../types.js";
import { BaseSessionStorage } from "./storage-base.js";
import { uuidv7 } from "./uuid.js";

/** Volatile session storage used by tests and in-process harness callers. */
export class InMemorySessionStorage<
  TMetadata extends SessionMetadata = SessionMetadata,
> extends BaseSessionStorage<TMetadata> {
  constructor(options?: { entries?: SessionTreeEntry[]; metadata?: TMetadata }) {
    super(
      options?.metadata ?? ({ id: uuidv7(), createdAt: new Date().toISOString() } as TMetadata),
      options?.entries ? [...options.entries] : [],
    );
  }

  override async setLeafId(leafId: string | null): Promise<void> {
    this.recordEntry(this.createLeafEntry(leafId));
  }

  override async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.recordEntry(entry);
  }
}
