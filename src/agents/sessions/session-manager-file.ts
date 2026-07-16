import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { resolveTranscriptSessionKeyBySessionId } from "../../config/sessions/session-accessor.js";
import {
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../../config/sessions/sqlite-marker.js";
import {
  canAdvanceOwnedSessionEntryCache,
  publishOwnedSessionFileSnapshot,
} from "../../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { Message } from "../../llm/types.js";
import { getAgentDir as getDefaultAgentDir } from "../config.js";
import { invalidateSessionFileRepairCache } from "../session-file-repair.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import {
  hasReadableSessionHeader,
  isJsonRecord,
  normalizeLoadedFileEntry,
  parseJsonlEntries,
} from "./session-manager-codec.js";
import { createSessionId } from "./session-manager-id.js";
import type { FileEntry, SessionFileSnapshot, SessionHeader } from "./session-manager-types.js";

const MAX_CACHED_SESSION_FILES = 8;
const MAX_CACHED_SESSION_BYTES = 32n * 1024n * 1024n;

type CachedSessionEntries = {
  snapshot: SessionFileSnapshot;
  entries: FileEntry[];
  endsWithNewline: boolean;
};

export type LoadedSessionFile = {
  entries: FileEntry[];
  snapshot: SessionFileSnapshot | undefined;
};

type LoadedSqliteSession = {
  cwd: string;
  entries: FileEntry[];
  sessionKey: string;
  sqliteMarker: SqliteSessionFileMarker;
};

const sessionEntriesCache = new Map<string, CachedSessionEntries>();

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const entries = parseJsonlEntries(readFileSync(filePath, "utf8"));
  return hasReadableSessionHeader(entries) ? entries : [];
}

export function loadEntriesFromFileWithSnapshot(filePath: string): LoadedSessionFile {
  const resolvedPath = resolve(filePath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let beforeReadSnapshot: SessionFileSnapshot;
    try {
      beforeReadSnapshot = readSessionFileSnapshot(resolvedPath);
    } catch {
      sessionEntriesCache.delete(resolvedPath);
      return { entries: [], snapshot: undefined };
    }

    const cached = sessionEntriesCache.get(resolvedPath);
    if (cached && isSameSessionFileSnapshot(cached.snapshot, beforeReadSnapshot)) {
      const afterCacheSnapshot = readSessionFileSnapshotIfExists(resolvedPath);
      if (afterCacheSnapshot && isSameSessionFileSnapshot(beforeReadSnapshot, afterCacheSnapshot)) {
        return { entries: copyFileEntries(cached.entries), snapshot: afterCacheSnapshot };
      }
      continue;
    }

    const content = readFileSync(resolvedPath, "utf8");
    const entries = parseJsonlEntries(content);
    const afterParseSnapshot = readSessionFileSnapshotIfExists(resolvedPath);
    if (afterParseSnapshot && isSameSessionFileSnapshot(beforeReadSnapshot, afterParseSnapshot)) {
      return {
        entries: rememberSessionEntries(
          resolvedPath,
          afterParseSnapshot,
          entries,
          content.endsWith("\n"),
        ),
        snapshot: afterParseSnapshot,
      };
    }
  }

  sessionEntriesCache.delete(resolvedPath);
  throw new Error(`session file changed repeatedly while loading: ${resolvedPath}`);
}

function readSessionFileSnapshot(filePath: string): SessionFileSnapshot {
  const fileStat = statSync(filePath, { bigint: true });
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeNs: fileStat.mtimeNs,
    ctimeNs: fileStat.ctimeNs,
  };
}

function isSameSessionFileSnapshot(left: SessionFileSnapshot, right: SessionFileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function rememberSessionEntries(
  filePath: string,
  snapshot: SessionFileSnapshot,
  entries: FileEntry[],
  endsWithNewline: boolean,
): FileEntry[] {
  if (!hasReadableSessionHeader(entries)) {
    sessionEntriesCache.delete(filePath);
    return entries.length === 0 ? entries : [];
  }
  if (!hasCacheableSessionHeader(entries)) {
    sessionEntriesCache.delete(filePath);
    return entries;
  }
  if (snapshot.size > MAX_CACHED_SESSION_BYTES) {
    sessionEntriesCache.delete(filePath);
    return copyFileEntries(entries.map(freezeFileEntry));
  }

  const cachedEntries = entries.map((entry) =>
    Object.isFrozen(entry) ? entry : freezeFileEntry(entry),
  );
  sessionEntriesCache.delete(filePath);
  sessionEntriesCache.set(filePath, { snapshot, entries: cachedEntries, endsWithNewline });
  trimSessionEntriesCache();
  return copyFileEntries(cachedEntries);
}

function trimSessionEntriesCache(): void {
  let cachedBytes = 0n;
  for (const cached of sessionEntriesCache.values()) {
    cachedBytes += cached.snapshot.size;
  }
  while (
    sessionEntriesCache.size > MAX_CACHED_SESSION_FILES ||
    cachedBytes > MAX_CACHED_SESSION_BYTES
  ) {
    const oldestKey = sessionEntriesCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    cachedBytes -= sessionEntriesCache.get(oldestKey)?.snapshot.size ?? 0n;
    sessionEntriesCache.delete(oldestKey);
  }
}

function hasCacheableSessionHeader(entries: FileEntry[]): boolean {
  if (entries.length === 0) {
    return true;
  }
  const header = entries[0];
  return (
    header?.type === "session" &&
    typeof header.id === "string" &&
    header.version === CURRENT_SESSION_VERSION
  );
}

export function rememberWrittenSessionEntries(
  filePath: string,
  expectedContent?: string,
): { snapshot: SessionFileSnapshot | undefined; verifiedWrite: boolean; stableRead: boolean } {
  const resolvedPath = resolve(filePath);
  invalidateSessionFileRepairCache(resolvedPath);
  let beforeReadSnapshot: SessionFileSnapshot;
  try {
    beforeReadSnapshot = readSessionFileSnapshot(resolvedPath);
  } catch {
    sessionEntriesCache.delete(resolvedPath);
    return { snapshot: undefined, verifiedWrite: false, stableRead: false };
  }
  if (beforeReadSnapshot.size > MAX_CACHED_SESSION_BYTES) {
    sessionEntriesCache.delete(resolvedPath);
    return { snapshot: beforeReadSnapshot, verifiedWrite: false, stableRead: false };
  }

  let content: string;
  let afterReadSnapshot: SessionFileSnapshot;
  try {
    content = readFileSync(resolvedPath, "utf8");
    afterReadSnapshot = readSessionFileSnapshot(resolvedPath);
  } catch {
    sessionEntriesCache.delete(resolvedPath);
    return { snapshot: undefined, verifiedWrite: false, stableRead: false };
  }
  if (
    (expectedContent !== undefined && content !== expectedContent) ||
    !isSameSessionFileSnapshot(beforeReadSnapshot, afterReadSnapshot)
  ) {
    sessionEntriesCache.delete(resolvedPath);
    return { snapshot: afterReadSnapshot, verifiedWrite: false, stableRead: false };
  }
  rememberSessionEntries(
    resolvedPath,
    afterReadSnapshot,
    parseJsonlEntries(content),
    content.endsWith("\n"),
  );
  return {
    snapshot: afterReadSnapshot,
    verifiedWrite: expectedContent !== undefined,
    stableRead: true,
  };
}

export function rememberAppendedSessionEntry(params: {
  filePath: string;
  previousSnapshot: SessionFileSnapshot | undefined;
  beforeAppendSnapshot: SessionFileSnapshot | undefined;
  serializedAppend: string;
  cacheOwnedAppend: boolean;
  publishOwnedAppend: boolean;
  invalidateSerializedPrefixCache: boolean;
}): {
  snapshot: SessionFileSnapshot | undefined;
  cacheAdvanced: boolean;
  ownedAppendVerified: boolean;
} {
  const {
    filePath,
    previousSnapshot,
    beforeAppendSnapshot,
    serializedAppend,
    cacheOwnedAppend,
    publishOwnedAppend,
    invalidateSerializedPrefixCache,
  } = params;
  const resolvedPath = resolve(filePath);
  const appendedByteLength = BigInt(Buffer.byteLength(serializedAppend, "utf8"));
  const isVerifiedOwnedAppend = (snapshot: SessionFileSnapshot | undefined) =>
    Boolean(
      publishOwnedAppend &&
      beforeAppendSnapshot &&
      snapshot &&
      snapshot.dev === beforeAppendSnapshot.dev &&
      snapshot.ino === beforeAppendSnapshot.ino &&
      snapshot.size === beforeAppendSnapshot.size + appendedByteLength,
    );
  if (!cacheOwnedAppend) {
    sessionEntriesCache.delete(resolvedPath);
    invalidateSessionFileRepairCache(resolvedPath);
    const snapshot = readSessionFileSnapshotIfExists(resolvedPath);
    return {
      snapshot,
      cacheAdvanced: false,
      ownedAppendVerified: isVerifiedOwnedAppend(snapshot),
    };
  }
  if (
    !previousSnapshot ||
    !beforeAppendSnapshot ||
    !isSameSessionFileSnapshot(previousSnapshot, beforeAppendSnapshot)
  ) {
    sessionEntriesCache.delete(resolvedPath);
    invalidateSessionFileRepairCache(resolvedPath);
    return {
      snapshot: readSessionFileSnapshotIfExists(resolvedPath),
      cacheAdvanced: false,
      ownedAppendVerified: false,
    };
  }

  const cached = sessionEntriesCache.get(resolvedPath);
  const snapshot = readSessionFileSnapshotIfExists(resolvedPath);
  const expectedSize = beforeAppendSnapshot.size + appendedByteLength;
  if (
    !snapshot ||
    !cached ||
    cached.snapshot.dev !== previousSnapshot.dev ||
    cached.snapshot.ino !== previousSnapshot.ino ||
    snapshot.dev !== beforeAppendSnapshot.dev ||
    snapshot.ino !== beforeAppendSnapshot.ino ||
    snapshot.size !== expectedSize ||
    !isSameSessionFileSnapshot(cached.snapshot, previousSnapshot)
  ) {
    sessionEntriesCache.delete(resolvedPath);
    invalidateSessionFileRepairCache(resolvedPath);
    return { snapshot, cacheAdvanced: false, ownedAppendVerified: false };
  }
  if (invalidateSerializedPrefixCache) {
    sessionEntriesCache.delete(resolvedPath);
    invalidateSessionFileRepairCache(resolvedPath);
    return { snapshot, cacheAdvanced: false, ownedAppendVerified: true };
  }
  if (snapshot.size > MAX_CACHED_SESSION_BYTES) {
    sessionEntriesCache.delete(resolvedPath);
    return { snapshot, cacheAdvanced: false, ownedAppendVerified: true };
  }

  const persistedEntry = JSON.parse(
    serializedAppend.startsWith("\n") ? serializedAppend.slice(1) : serializedAppend,
  ) as FileEntry;
  cached.entries.push(freezeFileEntry(normalizeLoadedFileEntry(persistedEntry)));
  cached.snapshot = snapshot;
  cached.endsWithNewline = true;
  sessionEntriesCache.delete(resolvedPath);
  sessionEntriesCache.set(resolvedPath, cached);
  trimSessionEntriesCache();
  return { snapshot, cacheAdvanced: true, ownedAppendVerified: true };
}

export function publishRememberedSessionFileSnapshot(
  filePath: string,
  snapshot: SessionFileSnapshot | undefined,
): void {
  if (!snapshot) {
    return;
  }
  if (publishOwnedSessionFileSnapshot({ sessionFile: filePath, snapshot }) === false) {
    sessionEntriesCache.delete(resolve(filePath));
    invalidateSessionFileRepairCache(filePath);
  }
}

export function jsonSerializationCanRunUserCode(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (typeof value === "bigint") {
    return Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON") !== undefined;
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }

  try {
    if (isProxy(value) || ancestors.has(value)) {
      return true;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      return true;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      descriptors.toJSON ||
      (prototype !== null && Object.getOwnPropertyDescriptor(prototype, "toJSON")) ||
      Object.values(descriptors).some(
        (descriptor) => descriptor.get !== undefined || descriptor.set !== undefined,
      )
    ) {
      return true;
    }

    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (
            !descriptor ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            ("value" in descriptor && jsonSerializationCanRunUserCode(descriptor.value, ancestors))
          ) {
            return true;
          }
        }
        return false;
      }
      return Object.values(descriptors).some(
        (descriptor) =>
          descriptor.enumerable &&
          "value" in descriptor &&
          jsonSerializationCanRunUserCode(descriptor.value, ancestors),
      );
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return true;
  }
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function messageSerializesOwnedValues(
  message: Message | CustomMessage | BashExecutionMessage,
): boolean {
  if (message.role === "toolResult") {
    return hasOwnProperty(message, "details");
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return message.content.some(
      (part) => part.type === "toolCall" && hasOwnProperty(part, "arguments"),
    );
  }
  return message.role === "custom" && hasOwnProperty(message, "details");
}

export function readSessionFileSnapshotIfExists(filePath: string): SessionFileSnapshot | undefined {
  try {
    return readSessionFileSnapshot(filePath);
  } catch {
    return undefined;
  }
}

export function sessionFileNeedsAppendSeparator(
  filePath: string,
  snapshot: SessionFileSnapshot | undefined,
): boolean {
  if (!snapshot || snapshot.size === 0n) {
    return false;
  }
  const resolvedPath = resolve(filePath);
  const cached = sessionEntriesCache.get(resolvedPath);
  if (cached && isSameSessionFileSnapshot(cached.snapshot, snapshot)) {
    return !cached.endsWithNewline;
  }
  const fileDescriptor = openSync(resolvedPath, "r");
  try {
    const lastByte = Buffer.allocUnsafe(1);
    const bytesRead = readSync(fileDescriptor, lastByte, 0, 1, snapshot.size - 1n);
    return bytesRead === 1 && lastByte[0] !== 0x0a;
  } finally {
    closeSync(fileDescriptor);
  }
}

export function revalidateLoadedSessionFile(
  filePath: string,
  loaded: LoadedSessionFile,
): LoadedSessionFile {
  const currentSnapshot = readSessionFileSnapshotIfExists(resolve(filePath));
  if (
    loaded.snapshot &&
    currentSnapshot &&
    isSameSessionFileSnapshot(loaded.snapshot, currentSnapshot)
  ) {
    return loaded;
  }
  if (!loaded.snapshot && !currentSnapshot) {
    return loaded;
  }
  return loadEntriesFromFileWithSnapshot(filePath);
}

export function loadSqliteMarkedSessionFile(
  sessionFile: string,
  loadEvents: (marker: SqliteSessionFileMarker) => FileEntry[],
  options: { cwdOverride?: string; fallbackCwd?: string } = {},
): LoadedSqliteSession | undefined {
  const sqliteMarker = parseSqliteSessionFileMarker(sessionFile);
  if (!sqliteMarker) {
    return undefined;
  }
  const sessionKey = resolveTranscriptSessionKeyBySessionId(sqliteMarker);
  if (!sessionKey) {
    throw new Error(`Cannot open SQLite session without session entry: ${sqliteMarker.sessionId}`);
  }
  const entries = loadEvents(sqliteMarker);
  const header = entries.find((entry) => isJsonRecord(entry) && entry.type === "session") as
    | SessionHeader
    | undefined;
  return {
    cwd: options.cwdOverride ?? header?.cwd ?? options.fallbackCwd ?? process.cwd(),
    entries,
    sessionKey,
    sqliteMarker,
  };
}

function copyFileEntries(entries: readonly FileEntry[]): FileEntry[] {
  const copy = entries.slice();
  const header = copy.at(0);
  if (header?.type === "session" && Object.isFrozen(header)) {
    copy[0] = structuredClone(header);
  }
  return copy;
}

function freezeFileEntry(entry: FileEntry): FileEntry {
  freezeJsonLikeValue(entry);
  return entry;
}

function freezeJsonLikeValue(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const item of Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>)) {
    freezeJsonLikeValue(item, seen);
  }
  Object.freeze(value);
}

export function recoverCorruptSessionEntries(filePath: string, cwd: string): FileEntry[] | null {
  const content = readFileSync(filePath, "utf8");
  if (content.trim().length === 0) {
    return null;
  }
  const parsedEntries = parseJsonlEntries(content);
  const recoveredHeader = parsedEntries.find(
    (entry): entry is SessionHeader => entry.type === "session" && typeof entry.id === "string",
  );
  const header =
    recoveredHeader ??
    ({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: createSessionId(),
      timestamp: new Date().toISOString(),
      cwd,
    } satisfies SessionHeader);
  const recoveredEntries = parsedEntries.filter((entry) => entry.type !== "session");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.corrupt-${timestamp}-${randomUUID().slice(0, 8)}.jsonl`;
  const backupMode = statSync(filePath).mode & 0o777;
  writeFileSync(backupPath, content, { encoding: "utf8", mode: backupMode || 0o600 });
  chmodSync(backupPath, backupMode || 0o600);
  return [header, ...recoveredEntries];
}

export function canPublishOwnedSessionAppend(
  sessionFile: string,
  snapshot: SessionFileSnapshot | undefined,
): boolean {
  return Boolean(snapshot && canAdvanceOwnedSessionEntryCache({ sessionFile, snapshot }));
}
import { randomUUID } from "node:crypto";
