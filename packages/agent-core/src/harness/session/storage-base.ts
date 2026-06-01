import {
  type LeafEntry,
  SessionError,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "../types.js";
import { uuidv7 } from "./uuid.js";

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
  if (entry.type !== "label") {
    return;
  }
  const label = entry.label?.trim();
  if (label) {
    labelsById.set(entry.targetId, label);
  } else {
    labelsById.delete(entry.targetId);
  }
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
  const labelsById = new Map<string, string>();
  for (const entry of entries) {
    updateLabelCache(labelsById, entry);
  }
  return labelsById;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = uuidv7().slice(0, 8);
    if (!byId.has(id)) {
      return id;
    }
  }
  return uuidv7();
}

/** Return the effective branch leaf after applying a session tree entry. */
export function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

function resolveLeafId(entries: readonly SessionTreeEntry[]): string | null {
  let leafId: string | null = null;
  for (const entry of entries) {
    leafId = leafIdAfterEntry(entry);
  }
  return leafId;
}

export abstract class BaseSessionStorage<
  TMetadata extends SessionMetadata = SessionMetadata,
> implements SessionStorage<TMetadata> {
  private readonly metadata: TMetadata;
  private readonly entries: SessionTreeEntry[];
  private readonly byId: Map<string, SessionTreeEntry>;
  private readonly labelsById: Map<string, string>;
  private leafId: string | null;

  protected constructor(
    metadata: TMetadata,
    entries: SessionTreeEntry[],
    leafId: string | null = resolveLeafId(entries),
  ) {
    this.metadata = metadata;
    this.entries = entries;
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.labelsById = buildLabelsById(entries);
    this.leafId = leafId;
    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }
  }

  async getMetadata(): Promise<TMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }
    return this.leafId;
  }

  protected createLeafEntry(leafId: string | null): LeafEntry {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    return {
      type: "leaf",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };
  }

  async createEntryId(): Promise<string> {
    return generateEntryId(this.byId);
  }

  protected recordEntry(entry: SessionTreeEntry): void {
    // Leaf and label entries are append-only state changes; keep derived indexes
    // synchronized here so memory and JSONL storage expose identical behavior.
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    updateLabelCache(this.labelsById, entry);
    this.leafId = leafIdAfterEntry(entry);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.byId.get(id);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.entries.filter(
      (entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type,
    );
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) {
      return [];
    }
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    if (!current) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    while (current) {
      path.unshift(current);
      if (!current.parentId) {
        break;
      }
      const parent = this.byId.get(current.parentId);
      if (!parent) {
        throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      }
      current = parent;
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return [...this.entries];
  }

  abstract setLeafId(leafId: string | null): Promise<void>;
  abstract appendEntry(entry: SessionTreeEntry): Promise<void>;
}
