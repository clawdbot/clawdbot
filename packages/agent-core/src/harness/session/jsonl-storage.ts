// Agent Core module implements jsonl storage behavior.
import type {
  FileError,
  FileSystem,
  JsonlSessionMetadata,
  Result,
  SessionTreeEntry,
} from "../types.js";
import { SessionError, toError } from "../types.js";
import {
  appendParentIdAfterEntry,
  BaseSessionStorage,
  leafIdUpdateAfterEntry,
} from "./storage-base.js";
import { parseSessionTimestampMs } from "./timestamps.js";

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

function getFileSystemResultOrThrow<TValue>(
  result: Result<TValue, FileError>,
  message: string,
): TValue {
  if (!result.ok) {
    const code = result.error.code === "not_found" ? "not_found" : "storage";
    throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
  }
  return result.value;
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
  if (parseSessionTimestampMs(parsed.timestamp) === undefined) {
    throw invalidSession(filePath, "session header has invalid timestamp");
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
  if (parseSessionTimestampMs(parsed.timestamp) === undefined) {
    throw invalidEntry(filePath, lineNumber, "has invalid timestamp");
  }
  if (parsed.type === "leaf" && parsed.targetId !== null && typeof parsed.targetId !== "string") {
    throw invalidEntry(filePath, lineNumber, "has invalid targetId");
  }
  if (
    parsed.type === "leaf" &&
    parsed.appendParentId !== undefined &&
    parsed.appendParentId !== null &&
    typeof parsed.appendParentId !== "string"
  ) {
    throw invalidEntry(filePath, lineNumber, "has invalid appendParentId");
  }
  if (parsed.appendMode !== undefined && parsed.appendMode !== "side") {
    throw invalidEntry(filePath, lineNumber, "has invalid appendMode");
  }
  return parsed as unknown as SessionTreeEntry;
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

/** Read only the JSONL session header and convert it to session metadata. */
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
  appendParentId: string | null;
}> {
  const content = getFileSystemResultOrThrow(
    await fs.readTextFile(filePath),
    `Failed to read session ${filePath}`,
  );
  const lines = content.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim());
  if (headerIndex === -1) {
    throw invalidSession(filePath, "missing session header");
  }

  const headerLine = lines.at(headerIndex);
  if (headerLine === undefined) {
    throw invalidSession(filePath, "missing session header");
  }
  const header = parseHeaderLine(headerLine, filePath);
  const entries: SessionTreeEntry[] = [];
  let leafId: string | null = null;
  let appendParentId: string | null = null;
  for (const [offset, line] of lines.slice(headerIndex + 1).entries()) {
    if (!line.trim()) {
      continue;
    }
    const entry = parseEntryLine(line, filePath, headerIndex + offset + 2);
    entries.push(entry);
    const leafUpdate = leafIdUpdateAfterEntry(entry);
    if (leafUpdate !== undefined) {
      leafId = leafUpdate;
    }
    appendParentId = appendParentIdAfterEntry(entry);
  }
  return { header, entries, leafId, appendParentId };
}

/** Append-only JSONL-backed storage for one session tree. */
export class JsonlSessionStorage extends BaseSessionStorage<JsonlSessionMetadata> {
  private readonly fs: JsonlSessionStorageFileSystem;
  private readonly filePath: string;

  private constructor(
    fs: JsonlSessionStorageFileSystem,
    filePath: string,
    header: SessionHeader,
    entries: SessionTreeEntry[],
    leafId: string | null,
    appendParentId: string | null,
  ) {
    super(headerToSessionMetadata(header, filePath), entries, leafId, appendParentId);
    this.fs = fs;
    this.filePath = filePath;
  }

  static async open(
    fs: JsonlSessionStorageFileSystem,
    filePath: string,
  ): Promise<JsonlSessionStorage> {
    const loaded = await loadJsonlStorage(fs, filePath);
    return new JsonlSessionStorage(
      fs,
      filePath,
      loaded.header,
      loaded.entries,
      loaded.leafId,
      loaded.appendParentId,
    );
  }

  /** Create a new JSONL file with a session header and no entries. */
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
    return new JsonlSessionStorage(fs, filePath, header, [], null, null);
  }

  override async setLeafId(leafId: string | null): Promise<void> {
    const entry = this.createLeafEntry(leafId);
    getFileSystemResultOrThrow(
      await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
      `Failed to append session leaf ${entry.id}`,
    );
    this.recordEntry(entry);
  }

  override async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.validateEntryForAppend(entry);
    getFileSystemResultOrThrow(
      await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
      `Failed to append session entry ${entry.id}`,
    );
    this.recordEntry(entry);
  }
}
