import type {
  FileSystem,
  JsonlSessionMetadata,
  LeafEntry,
  SessionStorage,
  SessionTreeEntry,
} from "../types.js";
import { SessionError, toError } from "../types.js";
import { getFileSystemResultOrThrow } from "./repo-utils.js";
import { uuidv7 } from "./uuid.js";

type JsonlSessionStorageFileSystem = Pick<
  FileSystem,
  "readTextFile" | "readTextLines" | "writeFile" | "appendFile"
>;

interface SessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
  return new SessionError(
    "invalid_session",
    `Invalid JSONL session file ${filePath}: ${message}`,
    cause,
  );
}

function invalidEntry(
  filePath: string,
  lineNumber: number,
  message: string,
  cause?: Error,
): SessionError {
  return new SessionError(
    "invalid_entry",
    `Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
    cause,
  );
}

function parseHeaderLine(line: string, filePath: string): SessionHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw invalidSession(filePath, "first line is not a valid session header", toError(error));
  }
  if (!isRecord(parsed)) {
    throw invalidSession(filePath, "first line is not a valid session header");
  }
  if (parsed.type !== "session") {
    throw invalidSession(filePath, "first line is not a valid session header");
  }
  if (parsed.version !== 3) {
    throw invalidSession(filePath, "unsupported session version");
  }
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw invalidSession(filePath, "session header is missing id");
  }
  if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
    throw invalidSession(filePath, "session header is missing timestamp");
  }
  if (typeof parsed.cwd !== "string" || !parsed.cwd) {
    throw invalidSession(filePath, "session header is missing cwd");
  }
  if (parsed.parentSession !== undefined && typeof parsed.parentSession !== "string") {
    throw invalidSession(filePath, "session header parentSession must be a string");
  }
  return {
    type: "session",
    version: 3,
    id: parsed.id,
    timestamp: parsed.timestamp,
    cwd: parsed.cwd,
    parentSession: parsed.parentSession,
  };
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
  }
  if (!isRecord(parsed)) {
    throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
  }
  if (typeof parsed.type !== "string") {
    throw invalidEntry(filePath, lineNumber, "is missing entry type");
  }
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw invalidEntry(filePath, lineNumber, "is missing entry id");
  }
  if (parsed.parentId !== null && typeof parsed.parentId !== "string") {
    throw invalidEntry(filePath, lineNumber, "has invalid parentId");
  }
  if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
    throw invalidEntry(filePath, lineNumber, "is missing timestamp");
  }
  if (parsed.type === "leaf" && parsed.targetId !== null && typeof parsed.targetId !== "string") {
    throw invalidEntry(filePath, lineNumber, "has invalid targetId");
  }
  return parsed as unknown as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
  return {
    id: header.id,
    createdAt: header.timestamp,
    cwd: header.cwd,
    path,
    parentSessionPath: header.parentSession,
  };
}

export async function loadJsonlSessionMetadata(
  fs: JsonlSessionStorageFileSystem,
  filePath: string,
): Promise<JsonlSessionMetadata> {
  const lines = getFileSystemResultOrThrow(
    await fs.readTextLines(filePath, { maxLines: 1 }),
    `Failed to read session header ${filePath}`,
  );
  const line = lines[0];
  if (line?.trim()) {
    return headerToSessionMetadata(parseHeaderLine(line, filePath), filePath);
  }
  throw invalidSession(filePath, "missing session header");
}

async function loadJsonlStorage(
  fs: JsonlSessionStorageFileSystem,
  filePath: string,
): Promise<{
  header: SessionHeader;
  entries: SessionTreeEntry[];
  leafId: string | null;
}> {
  const content = getFileSystemResultOrThrow(
    await fs.readTextFile(filePath),
    `Failed to read session ${filePath}`,
  );
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    throw invalidSession(filePath, "missing session header");
  }

  const header = parseHeaderLine(lines[0], filePath);
  const entries: SessionTreeEntry[] = [];
  let leafId: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const entry = parseEntryLine(lines[i], filePath, i + 1);
    entries.push(entry);
    leafId = leafIdAfterEntry(entry);
  }
  return { header, entries, leafId };
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
  private readonly fs: JsonlSessionStorageFileSystem;
  private readonly filePath: string;
  private readonly metadata: JsonlSessionMetadata;
  private entries: SessionTreeEntry[];
  private byId: Map<string, SessionTreeEntry>;
  private labelsById: Map<string, string>;
  private currentLeafId: string | null;

  private constructor(
    fs: JsonlSessionStorageFileSystem,
    filePath: string,
    header: SessionHeader,
    entries: SessionTreeEntry[],
    leafId: string | null,
  ) {
    this.fs = fs;
    this.filePath = filePath;
    this.metadata = headerToSessionMetadata(header, this.filePath);
    this.entries = entries;
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.labelsById = buildLabelsById(entries);
    this.currentLeafId = leafId;
  }

  static async open(
    fs: JsonlSessionStorageFileSystem,
    filePath: string,
  ): Promise<JsonlSessionStorage> {
    const loaded = await loadJsonlStorage(fs, filePath);
    return new JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries, loaded.leafId);
  }

  static async create(
    fs: JsonlSessionStorageFileSystem,
    filePath: string,
    options: {
      cwd: string;
      sessionId: string;
      parentSessionPath?: string;
    },
  ): Promise<JsonlSessionStorage> {
    const header: SessionHeader = {
      type: "session",
      version: 3,
      id: options.sessionId,
      timestamp: new Date().toISOString(),
      cwd: options.cwd,
      parentSession: options.parentSessionPath,
    };
    getFileSystemResultOrThrow(
      await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
      `Failed to create session ${filePath}`,
    );
    return new JsonlSessionStorage(fs, filePath, header, [], null);
  }

  async getMetadata(): Promise<JsonlSessionMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
      throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
    }
    return this.currentLeafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    const entry: LeafEntry = {
      type: "leaf",
      id: generateEntryId(this.byId),
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };
    getFileSystemResultOrThrow(
      await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
      `Failed to append session leaf ${entry.id}`,
    );
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.currentLeafId = leafId;
  }

  async createEntryId(): Promise<string> {
    return generateEntryId(this.byId);
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    getFileSystemResultOrThrow(
      await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
      `Failed to append session entry ${entry.id}`,
    );
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    updateLabelCache(this.labelsById, entry);
    this.currentLeafId = leafIdAfterEntry(entry);
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
}
