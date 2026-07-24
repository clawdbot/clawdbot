import { selectSessionTranscriptLeafControlledPath } from "../../config/sessions/transcript-tree.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import { logWarn } from "../../logger.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";
import { generateSessionEntryId } from "./session-manager-id.js";
import type {
  CompactionEntry,
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
} from "./session-manager-types.js";

function migrateV1ToV2(
  entries: FileEntry[],
  entriesByOriginalIndex?: readonly (FileEntry | undefined)[],
): void {
  const ids = new Set<string>();
  let previousId: string | null = null;

  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 2;
      continue;
    }

    entry.id = generateSessionEntryId(ids);
    ids.add(entry.id);
    entry.parentId = previousId;
    previousId = entry.id;

    if (entry.type === "compaction") {
      const compaction = entry as CompactionEntry & { firstKeptEntryIndex?: number };
      if (typeof compaction.firstKeptEntryIndex === "number") {
        const targetEntry = entriesByOriginalIndex
          ? entriesByOriginalIndex[compaction.firstKeptEntryIndex]
          : entries[compaction.firstKeptEntryIndex];
        if (targetEntry && targetEntry.type !== "session") {
          compaction.firstKeptEntryId = targetEntry.id;
        }
        delete compaction.firstKeptEntryIndex;
      }
    }
  }
}

function migrateV2ToV3(entries: FileEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 3;
      continue;
    }
    if (entry.type === "message" && entry.message) {
      const message = entry.message as { role: string };
      if (message.role === "hookMessage") {
        message.role = "custom";
      }
    }
  }
}

export function migrateToCurrentVersion(
  entries: FileEntry[],
  entriesByOriginalIndex?: readonly (FileEntry | undefined)[],
): boolean {
  const header = entries.find((entry) => entry.type === "session");
  const version = header?.version ?? 1;
  if (version >= CURRENT_SESSION_VERSION) {
    return false;
  }
  if (version < 2) {
    migrateV1ToV2(entries, entriesByOriginalIndex);
  }
  if (version < 3) {
    migrateV2ToV3(entries);
  }
  return true;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
  migrateToCurrentVersion(entries);
}

export function parseSessionEntries(content: string): FileEntry[] {
  return parseJsonlEntries(content);
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
  for (const entry of entries.toReversed()) {
    if (entry.type === "reset") {
      return null;
    }
    if (entry.type === "compaction") {
      return entry;
    }
  }
  return null;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byIdInput?: Map<string, SessionEntry>,
): SessionContext {
  let contextEntries = entries;
  let contextById = byIdInput;
  if (leafId === undefined) {
    const selectedEntries = selectSessionTranscriptLeafControlledPath(entries);
    if (selectedEntries !== undefined) {
      contextEntries = selectedEntries;
      contextById = undefined;
    }
  }

  let byId = contextById;
  if (!byId) {
    byId = new Map<string, SessionEntry>();
    for (const entry of contextEntries) {
      byId.set(entry.id, entry);
    }
  }

  if (leafId === null) {
    return { messages: [], thinkingLevel: "off", model: null };
  }
  let leaf = leafId ? byId.get(leafId) : undefined;
  leaf ??= contextEntries.at(-1);
  if (!leaf) {
    return { messages: [], thinkingLevel: "off", model: null };
  }

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return buildCoreSessionContext(path as CoreSessionTreeEntry[]) as SessionContext;
}

function parseJsonlEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let skipped = 0;
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(normalizeLoadedFileEntry(JSON.parse(line) as FileEntry));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    logWarn(
      `parseJsonlEntries: skipped ${skipped} malformed JSONL line(s) — ` +
        `${entries.length} valid entries were loaded`,
    );
  }
  return entries;
}

export function normalizeLoadedFileEntry(entry: FileEntry): FileEntry {
  if (!isJsonRecord(entry) || entry.type !== "message" || !isJsonRecord(entry.message)) {
    return entry;
  }
  const message: Record<string, unknown> = entry.message;
  if (
    (message.role === "assistant" || message.role === "toolResult") &&
    typeof message.content === "string"
  ) {
    message.content = [{ type: "text", text: message.content }];
  } else if (message.role === "toolResult" && isJsonRecord(message.content)) {
    message.content = [message.content];
  }
  return entry;
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionEntryType(type: unknown): boolean {
  switch (type) {
    case "message":
    case "thinking_level_change":
    case "model_change":
    case "compaction":
    case "reset":
    case "branch_summary":
    case "custom":
    case "custom_message":
    case "label":
    case "session_info":
      return true;
    default:
      return false;
  }
}

export function isIndexedSessionEntry(entry: unknown): entry is SessionEntry {
  if (
    !isJsonRecord(entry) ||
    !isSessionEntryType(entry.type) ||
    typeof entry.id !== "string" ||
    entry.id.length === 0 ||
    (entry.parentId !== undefined &&
      entry.parentId !== null &&
      typeof entry.parentId !== "string") ||
    (entry.timestamp !== undefined && typeof entry.timestamp !== "string")
  ) {
    return false;
  }
  switch (entry.type) {
    case "message":
      return isReadableMessage(entry.message);
    case "thinking_level_change":
      return typeof entry.thinkingLevel === "string" && entry.thinkingLevel.length > 0;
    case "model_change":
      return (
        typeof entry.provider === "string" &&
        entry.provider.length > 0 &&
        typeof entry.modelId === "string" &&
        entry.modelId.length > 0
      );
    case "compaction":
      return (
        typeof entry.summary === "string" &&
        typeof entry.firstKeptEntryId === "string" &&
        entry.firstKeptEntryId.length > 0 &&
        typeof entry.tokensBefore === "number"
      );
    case "reset":
      return (
        ["new", "reset", "idle", "daily", "cron-stale"].includes(String(entry.reason)) &&
        (entry.firstKeptEntryId === undefined || typeof entry.firstKeptEntryId === "string")
      );
    case "branch_summary":
      return typeof entry.fromId === "string" && typeof entry.summary === "string";
    case "custom":
      return typeof entry.customType === "string" && entry.customType.length > 0;
    case "custom_message":
      return (
        typeof entry.customType === "string" &&
        entry.customType.length > 0 &&
        isReadableContent(entry.content) &&
        typeof entry.display === "boolean"
      );
    case "label":
      return (
        typeof entry.targetId === "string" &&
        entry.targetId.length > 0 &&
        (entry.label === undefined || typeof entry.label === "string")
      );
    case "session_info":
      return entry.name === undefined || typeof entry.name === "string";
    default:
      return false;
  }
}

function isReadableContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every((part) => isJsonRecord(part) && typeof part.type === "string"))
  );
}

function isReadableMessage(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value.role !== "string") {
    return false;
  }
  switch (value.role) {
    case "user":
    case "assistant":
      return isReadableContent(value.content);
    case "toolResult":
      return (
        typeof value.toolCallId === "string" &&
        typeof value.toolName === "string" &&
        typeof value.isError === "boolean" &&
        Array.isArray(value.content)
      );
    case "custom":
      return typeof value.customType === "string" && isReadableContent(value.content);
    case "bashExecution":
      return typeof value.command === "string" && typeof value.output === "string";
    default:
      return false;
  }
}

function isReadableLegacySessionEntry(value: unknown): value is FileEntry {
  const message = isJsonRecord(value) && value.type === "message" ? value.message : undefined;
  const readableLegacyMessage =
    isJsonRecord(message) && message.role === "hookMessage"
      ? isReadableContent(message.content)
      : isReadableMessage(message);
  return (
    isJsonRecord(value) &&
    isSessionEntryType(value.type) &&
    (value.type !== "message" || readableLegacyMessage)
  );
}

export function parseParentLinkedOpaqueEntry(
  record: unknown,
): { id: string; parentId: string | null } | undefined {
  if (
    !isJsonRecord(record) ||
    record.type === "session" ||
    record.type === "leaf" ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    (record.parentId !== null && typeof record.parentId !== "string")
  ) {
    return undefined;
  }
  return { id: record.id, parentId: record.parentId };
}

export function parseOpaqueLeafEntry(record: unknown):
  | {
      id: string;
      parentId: string | null;
      targetId: string | null;
      appendParentId?: string | null;
      appendMode?: "side";
    }
  | undefined {
  if (
    !isJsonRecord(record) ||
    record.type !== "leaf" ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    (record.parentId !== null && typeof record.parentId !== "string") ||
    (record.targetId !== null && typeof record.targetId !== "string") ||
    (record.appendParentId !== undefined &&
      record.appendParentId !== null &&
      typeof record.appendParentId !== "string") ||
    (record.appendMode !== undefined && record.appendMode !== "side")
  ) {
    return undefined;
  }
  return {
    id: record.id,
    parentId: record.parentId,
    targetId: record.targetId,
    ...(record.appendParentId !== undefined ? { appendParentId: record.appendParentId } : {}),
    ...(record.appendMode === "side" ? { appendMode: record.appendMode } : {}),
  };
}

export function partitionSessionFileEntries(entries: readonly FileEntry[]): {
  fileEntries: FileEntry[];
  opaqueEntries: Array<{ index: number; record: unknown }>;
  fileEntriesByOriginalIndex: Array<FileEntry | undefined>;
} {
  const fileEntries: FileEntry[] = [];
  const opaqueEntries: Array<{ index: number; record: unknown }> = [];
  const fileEntriesByOriginalIndex: Array<FileEntry | undefined> = [];
  const header = entries.find(
    (entry) => isJsonRecord(entry) && entry.type === "session" && typeof entry.id === "string",
  ) as SessionHeader | undefined;
  const acceptsLegacyEntries = (header?.version ?? 1) < CURRENT_SESSION_VERSION;
  let hasHeader = false;
  for (const [originalIndex, entry] of entries.entries()) {
    if (
      !hasHeader &&
      isJsonRecord(entry) &&
      entry.type === "session" &&
      typeof entry.id === "string"
    ) {
      fileEntries.push(entry as unknown as SessionHeader);
      fileEntriesByOriginalIndex[originalIndex] = entry;
      hasHeader = true;
      continue;
    }
    if (
      isIndexedSessionEntry(entry) ||
      (acceptsLegacyEntries && isReadableLegacySessionEntry(entry))
    ) {
      fileEntries.push(entry);
      fileEntriesByOriginalIndex[originalIndex] = entry;
      continue;
    }
    opaqueEntries.push({ index: fileEntries.length, record: entry });
  }
  return { fileEntries, opaqueEntries, fileEntriesByOriginalIndex };
}
