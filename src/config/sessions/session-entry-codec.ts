import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type {
  FileEntry,
  SessionEntry,
  SessionHeader,
} from "../../agents/sessions/session-manager-types.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

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

export function findSessionTranscriptHeader(entries: Iterable<unknown>): SessionHeader | undefined {
  for (const entry of entries) {
    if (sessionHeaderSchema.safeParse(entry).success) {
      // SAFETY: The shared header schema preserves the existing readable header contract.
      return entry as SessionHeader;
    }
  }
  return undefined;
}

export function assertCurrentSessionTranscriptHeader(header: SessionHeader | undefined): void {
  if ((header?.version ?? 1) < CURRENT_SESSION_VERSION) {
    throw new Error(
      "Persisted legacy session transcripts require doctor/import migration before runtime use",
    );
  }
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

export function classifySessionFileEntry(rawEntry: unknown, sourceVersion: number) {
  const entry = normalizePersistedLegacyHookMessage(rawEntry);
  // Legacy rows can lack modern IDs; avoid constructing a discarded validation error for each one.
  if (
    (sourceVersion < CURRENT_SESSION_VERSION && isReadableLegacySessionEntry(entry)) ||
    isIndexedSessionEntry(entry)
  ) {
    return { entry, recognized: true as const };
  }
  return { entry, recognized: false as const };
}

export function partitionSessionFileEntries(entries: readonly FileEntry[]): {
  fileEntries: FileEntry[];
  opaqueEntries: Array<{ index: number; record: unknown }>;
  fileEntriesByOriginalIndex: Array<FileEntry | undefined>;
} {
  const fileEntries: FileEntry[] = [];
  const opaqueEntries: Array<{ index: number; record: unknown }> = [];
  const fileEntriesByOriginalIndex: Array<FileEntry | undefined> = [];
  const header = findSessionTranscriptHeader(entries);
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
