import { stripCompactionReplayCheckpointInPlace } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
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

const sessionEntryTypeSchema = z.enum([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "reset",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const readableContentSchema = z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]);
const readableMessageSchema = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("user"), content: readableContentSchema }),
  z.looseObject({ role: z.literal("assistant"), content: readableContentSchema }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
    content: z.array(z.unknown()),
  }),
  z.looseObject({
    role: z.literal("custom"),
    customType: z.string(),
    content: readableContentSchema,
  }),
  z.looseObject({
    role: z.literal("bashExecution"),
    command: z.string(),
    output: z.string(),
  }),
]);
const indexedSessionEntryBaseShape = {
  id: z.string().min(1),
  parentId: z.union([z.string(), z.null()]).optional(),
  timestamp: z.string().optional(),
};
const indexedSessionEntrySchema = z.discriminatedUnion("type", [
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("message"),
    message: readableMessageSchema,
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("thinking_level_change"),
    thinkingLevel: z.string().min(1),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("model_change"),
    provider: z.string().min(1),
    modelId: z.string().min(1),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("compaction"),
    summary: z.string(),
    firstKeptEntryId: z.string().min(1),
    tokensBefore: z.custom<number>((value) => typeof value === "number"),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("reset"),
    reason: z.coerce.string().pipe(z.enum(["new", "reset", "idle", "daily", "cron-stale"])),
    firstKeptEntryId: z.string().optional(),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("branch_summary"),
    fromId: z.string(),
    summary: z.string(),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("custom"),
    customType: z.string().min(1),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("custom_message"),
    customType: z.string().min(1),
    content: readableContentSchema,
    display: z.boolean(),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("label"),
    targetId: z.string().min(1),
    label: z.string().optional(),
  }),
  z.looseObject({
    ...indexedSessionEntryBaseShape,
    type: z.literal("session_info"),
    name: z.string().optional(),
  }),
]);
const parentLinkedOpaqueEntrySchema = z.looseObject({
  type: z
    .unknown()
    .optional()
    .refine((type) => type !== "session" && type !== "leaf"),
  id: z.string().min(1),
  parentId: z.union([z.string(), z.null()]),
});
const opaqueLeafEntrySchema = z.looseObject({
  type: z.literal("leaf"),
  id: z.string().min(1),
  parentId: z.union([z.string(), z.null()]),
  targetId: z.union([z.string(), z.null()]),
  appendParentId: z.union([z.string(), z.null()]).optional(),
  appendMode: z.literal("side").optional(),
});
const sessionHeaderSchema = z.looseObject({ type: z.literal("session"), id: z.string() });

export function isSessionContextMetadataEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "thinking_level_change" ||
    entry.type === "model_change" ||
    entry.type === "custom" ||
    entry.type === "label" ||
    entry.type === "session_info"
  );
}

export type SessionFileEntryMigrationState = {
  createEntryId: (originalIndex: number) => string;
  previousId: string | null;
  resolveOriginalEntryId?: (originalIndex: number) => string | undefined;
  sourceVersion: number;
};

export function migrateSessionFileEntryToCurrentVersion(
  entry: FileEntry,
  originalIndex: number,
  state: SessionFileEntryMigrationState,
): void {
  if (state.sourceVersion < 2) {
    if (entry.type === "session") {
      entry.version = 2;
    } else {
      entry.id = state.createEntryId(originalIndex);
      entry.parentId = state.previousId;
      state.previousId = entry.id;

      if (entry.type === "compaction") {
        const compaction = entry as CompactionEntry & { firstKeptEntryIndex?: number };
        if (typeof compaction.firstKeptEntryIndex === "number") {
          const firstKeptEntryId = state.resolveOriginalEntryId?.(compaction.firstKeptEntryIndex);
          if (firstKeptEntryId) {
            compaction.firstKeptEntryId = firstKeptEntryId;
          }
          delete compaction.firstKeptEntryIndex;
        }
      }
    }
  }

  if (state.sourceVersion < 3) {
    if (entry.type === "session") {
      entry.version = 3;
    } else if (entry.type === "message" && entry.message) {
      const message = entry.message as { role: string; customType?: string };
      if (message.role === "hookMessage") {
        message.role = "custom";
        message.customType ||= "hook";
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
  const state: SessionFileEntryMigrationState = {
    createEntryId: generateSessionEntryId,
    previousId: null,
    resolveOriginalEntryId: (originalIndex) => {
      const targetEntry = entriesByOriginalIndex
        ? entriesByOriginalIndex[originalIndex]
        : entries[originalIndex];
      return targetEntry && targetEntry.type !== "session" ? targetEntry.id : undefined;
    },
    sourceVersion: version,
  };
  for (const [index, entry] of entries.entries()) {
    migrateSessionFileEntryToCurrentVersion(entry, index, state);
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
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
    return entry;
  }
  const message: Record<string, unknown> = entry.message;
  if (
    (message.role === "assistant" || message.role === "toolResult") &&
    typeof message.content === "string"
  ) {
    message.content = [{ type: "text", text: message.content }];
    stripCompactionReplayCheckpointInPlace(message);
  } else if (message.role === "toolResult" && isRecord(message.content)) {
    message.content = [message.content];
  }
  return entry;
}

function isSessionEntryType(type: unknown): boolean {
  return sessionEntryTypeSchema.safeParse(type).success;
}

export function isIndexedSessionEntry(entry: unknown): entry is SessionEntry {
  return indexedSessionEntrySchema.safeParse(entry).success;
}

function isReadableContent(value: unknown): boolean {
  return readableContentSchema.safeParse(value).success;
}

function isReadableMessage(value: unknown): boolean {
  return readableMessageSchema.safeParse(value).success;
}

function isReadableLegacySessionEntry(value: unknown): value is FileEntry {
  const message = isRecord(value) && value.type === "message" ? value.message : undefined;
  return (
    isRecord(value) &&
    isSessionEntryType(value.type) &&
    (value.type !== "message" ||
      (isRecord(message) && message.role === "hookMessage"
        ? isReadableContent(message.content)
        : isReadableMessage(message)))
  );
}

function normalizePersistedLegacyHookMessage(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) {
    return value;
  }
  const message = value.message;
  if (
    message.role !== "custom" ||
    message.customType !== undefined ||
    !isReadableContent(message.content)
  ) {
    return value;
  }
  return { ...value, message: { ...message, customType: "hook" } };
}

export function parseParentLinkedOpaqueEntry(
  record: unknown,
): { id: string; parentId: string | null } | undefined {
  const parsed = parentLinkedOpaqueEntrySchema.safeParse(record);
  return parsed.success ? { id: parsed.data.id, parentId: parsed.data.parentId } : undefined;
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
  const parsed = opaqueLeafEntrySchema.safeParse(record);
  if (!parsed.success) {
    return undefined;
  }
  const leaf = parsed.data;
  return {
    id: leaf.id,
    parentId: leaf.parentId,
    targetId: leaf.targetId,
    ...(leaf.appendParentId !== undefined ? { appendParentId: leaf.appendParentId } : {}),
    ...(leaf.appendMode === "side" ? { appendMode: leaf.appendMode } : {}),
  };
}

export function classifySessionFileEntry(rawEntry: FileEntry, sourceVersion: number) {
  const entry = normalizePersistedLegacyHookMessage(rawEntry) as FileEntry;
  // Legacy rows can lack modern IDs; avoid constructing a discarded validation error for each one.
  const recognized =
    (sourceVersion < CURRENT_SESSION_VERSION && isReadableLegacySessionEntry(entry)) ||
    isIndexedSessionEntry(entry);
  return { entry, recognized };
}

export function partitionSessionFileEntries(entries: readonly FileEntry[]): {
  fileEntries: FileEntry[];
  opaqueEntries: Array<{ index: number; record: unknown }>;
  fileEntriesByOriginalIndex: Array<FileEntry | undefined>;
} {
  const fileEntries: FileEntry[] = [];
  const opaqueEntries: Array<{ index: number; record: unknown }> = [];
  const fileEntriesByOriginalIndex: Array<FileEntry | undefined> = [];
  const header = entries.find((entry) => sessionHeaderSchema.safeParse(entry).success) as
    | SessionHeader
    | undefined;
  const sourceVersion = header?.version ?? 1;
  let hasHeader = false;
  for (const [originalIndex, rawEntry] of entries.entries()) {
    if (!hasHeader && sessionHeaderSchema.safeParse(rawEntry).success) {
      fileEntries.push(rawEntry);
      fileEntriesByOriginalIndex[originalIndex] = rawEntry;
      hasHeader = true;
      continue;
    }
    const { entry, recognized } = classifySessionFileEntry(rawEntry, sourceVersion);
    if (recognized) {
      fileEntries.push(entry);
      fileEntriesByOriginalIndex[originalIndex] = entry;
      continue;
    }
    opaqueEntries.push({ index: fileEntries.length, record: entry });
  }
  return { fileEntries, opaqueEntries, fileEntriesByOriginalIndex };
}
