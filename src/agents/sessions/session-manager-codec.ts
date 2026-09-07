import { stripCompactionReplayCheckpointInPlace } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
} from "./session-manager-types.js";

export {
  classifySessionFileEntry,
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  partitionSessionFileEntries,
} from "../../config/sessions/session-entry-codec.js";

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
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    // SAFETY: The reverse index stays within the canonical session entries.
    const entry = entries[index]!;
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
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
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
