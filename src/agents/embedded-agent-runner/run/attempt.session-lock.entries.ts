import { isDeepStrictEqual } from "node:util";
import type { OwnedSessionTranscriptPublishedEntry } from "../../../config/sessions/transcript-write-context.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import type {
  CustomEntry,
  LabelEntry,
  SessionInfoEntry,
  SessionMessageEntry,
} from "../../sessions/session-manager.js";

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePromptReleasedMessageLine(
  line: string,
  options?: { allowAnyMessage?: boolean },
): SessionMessageEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      !isJsonRecord(parsed) ||
      parsed.type !== "message" ||
      typeof parsed.id !== "string" ||
      parsed.id.trim().length === 0 ||
      typeof parsed.timestamp !== "string" ||
      parsed.timestamp.trim().length === 0 ||
      (parsed.parentId !== undefined &&
        parsed.parentId !== null &&
        typeof parsed.parentId !== "string") ||
      (parsed.appendMode !== undefined && parsed.appendMode !== "side")
    ) {
      return undefined;
    }
    const message = parsed.message;
    if (!isJsonRecord(message)) {
      return undefined;
    }
    const isOpenClawTranscriptOnlyAssistant = isTranscriptOnlyOpenClawAssistantMessage(message);
    if (
      typeof message.role !== "string" ||
      (!options?.allowAnyMessage && !isOpenClawTranscriptOnlyAssistant)
    ) {
      return undefined;
    }
    return {
      type: "message",
      id: parsed.id,
      parentId: parsed.parentId ?? null,
      timestamp: parsed.timestamp,
      message: message as unknown as SessionMessageEntry["message"],
      ...(parsed.appendMode === "side" ? { appendMode: parsed.appendMode } : {}),
    };
  } catch {
    return undefined;
  }
}

function hasSessionEntryBase(record: Record<string, unknown>): boolean {
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    (record.parentId === null || typeof record.parentId === "string") &&
    typeof record.timestamp === "string" &&
    record.timestamp.trim().length > 0
  );
}

type PromptReleasedSessionMetadataEntry = CustomEntry | LabelEntry | SessionInfoEntry;

type PromptReleasedOpaqueEntry = {
  type: "prompt_released_opaque";
  record: unknown;
  /** Unowned side-leaf rows may extend only the current delivery side branch. */
  preserveActiveLeaf?: true;
};

export type PromptReleasedSessionEntry =
  | SessionMessageEntry
  | PromptReleasedSessionMetadataEntry
  | PromptReleasedOpaqueEntry;

function parsePromptReleasedGlobalMetadataLine(
  line: string,
): PromptReleasedSessionMetadataEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isJsonRecord(parsed) || !hasSessionEntryBase(parsed)) {
      return undefined;
    }
    const base = {
      id: parsed.id as string,
      parentId: parsed.parentId as string | null,
      timestamp: parsed.timestamp as string,
    };
    // These records are resolved globally rather than through the active branch.
    // Accepting them keeps an in-flight reply alive without losing branch-scoped
    // model or thinking state when the active SessionManager is stale.
    switch (parsed.type) {
      case "custom":
        return typeof parsed.customType === "string" && parsed.customType.trim().length > 0
          ? {
              ...base,
              type: "custom",
              customType: parsed.customType,
              ...(Object.hasOwn(parsed, "data") ? { data: parsed.data } : {}),
            }
          : undefined;
      case "label":
        return typeof parsed.targetId === "string" &&
          parsed.targetId.trim().length > 0 &&
          (parsed.label === undefined || typeof parsed.label === "string")
          ? {
              ...base,
              type: "label",
              targetId: parsed.targetId,
              label: parsed.label,
            }
          : undefined;
      case "session_info":
        return parsed.name === undefined || typeof parsed.name === "string"
          ? {
              ...base,
              type: "session_info",
              ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
            }
          : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function parsePromptReleasedOpaqueLine(line: string): PromptReleasedOpaqueEntry | undefined {
  try {
    const record = JSON.parse(line) as unknown;
    return !isJsonRecord(record) || record.type !== "message"
      ? { type: "prompt_released_opaque", record }
      : undefined;
  } catch {
    return undefined;
  }
}

function parsePromptReleasedSideLeafControlLine(
  line: string,
): PromptReleasedOpaqueEntry | undefined {
  try {
    const record = JSON.parse(line) as unknown;
    if (
      !isJsonRecord(record) ||
      record.type !== "leaf" ||
      !hasSessionEntryBase(record) ||
      (record.targetId !== null && typeof record.targetId !== "string") ||
      (record.appendParentId !== undefined &&
        record.appendParentId !== null &&
        typeof record.appendParentId !== "string") ||
      record.appendMode !== "side"
    ) {
      return undefined;
    }
    return { type: "prompt_released_opaque", record, preserveActiveLeaf: true };
  } catch {
    return undefined;
  }
}

export type PromptReleasedSessionChange =
  | {
      kind: "transcript-only";
      entries: SessionMessageEntry[];
      publishedEntries: OwnedSessionTranscriptPublishedEntry[];
    }
  | {
      kind: "global-metadata";
      entries: PromptReleasedSessionEntry[];
      publishedEntries: OwnedSessionTranscriptPublishedEntry[];
    }
  | {
      kind: "opaque";
      entries: PromptReleasedSessionEntry[];
      publishedEntries: OwnedSessionTranscriptPublishedEntry[];
    };

export function classifyPromptReleasedSessionLines(
  lines: string[],
  options?: {
    allowAnyMessage?: boolean;
    expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
    initialParentId?: string | null;
  },
): PromptReleasedSessionChange | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const entries: PromptReleasedSessionEntry[] = [];
  const publishedEntries: OwnedSessionTranscriptPublishedEntry[] = [];
  const remainingExpectedEntries = options?.expectedPublishedEntries
    ? [...options.expectedPublishedEntries]
    : undefined;
  let hasGlobalMetadata = false;
  let hasOpaqueEntries = false;
  let expectedParentId = options?.initialParentId ?? null;
  for (const line of lines) {
    const matchExpectedEntry = (
      id: string | undefined,
    ): OwnedSessionTranscriptPublishedEntry | undefined => {
      if (!remainingExpectedEntries) {
        if (id) {
          expectedParentId = id;
          return { kind: "id", id };
        }
        return { kind: "serialized", serialized: line };
      }
      let matchIndex = remainingExpectedEntries.findIndex(
        (entry) => entry.kind === "serialized" && entry.serialized === line,
      );
      let migratedParentId: string | undefined;
      if (matchIndex < 0 && id) {
        matchIndex = remainingExpectedEntries.findIndex(
          (entry) => entry.kind === "id" && entry.id === id,
        );
      }
      if (matchIndex < 0) {
        matchIndex = remainingExpectedEntries.findIndex((entry) => {
          if (entry.kind !== "serialized") {
            return false;
          }
          const lineMatch = lineMatchesLinearTranscriptMigration({
            previousLine: entry.serialized,
            currentLine: line,
            expectedParentId,
          });
          if (!lineMatch.ok) {
            return false;
          }
          migratedParentId = lineMatch.nextPreviousId;
          return true;
        });
      }
      if (matchIndex < 0) {
        return undefined;
      }
      const [matchedEntry] = remainingExpectedEntries.splice(matchIndex, 1);
      if (migratedParentId) {
        expectedParentId = migratedParentId;
      } else if (id) {
        expectedParentId = id;
      }
      return matchedEntry;
    };
    const transcriptEntry = parsePromptReleasedMessageLine(line, options);
    if (transcriptEntry) {
      const publishedEntry = matchExpectedEntry(transcriptEntry.id);
      if (!publishedEntry) {
        return undefined;
      }
      entries.push(transcriptEntry);
      publishedEntries.push(publishedEntry);
      continue;
    }
    const metadataEntry = parsePromptReleasedGlobalMetadataLine(line);
    if (metadataEntry) {
      const publishedEntry = matchExpectedEntry(metadataEntry.id);
      if (!publishedEntry) {
        return undefined;
      }
      entries.push(metadataEntry);
      publishedEntries.push(publishedEntry);
      hasGlobalMetadata = true;
      continue;
    }
    const opaqueEntry = options?.allowAnyMessage
      ? parsePromptReleasedOpaqueLine(line)
      : parsePromptReleasedSideLeafControlLine(line);
    const opaqueId =
      opaqueEntry && isJsonRecord(opaqueEntry.record)
        ? normalizeTranscriptEntryId(opaqueEntry.record.id)
        : undefined;
    const publishedEntry = opaqueEntry ? matchExpectedEntry(opaqueId) : undefined;
    if (!opaqueEntry || !publishedEntry) {
      return undefined;
    }
    entries.push(opaqueEntry);
    publishedEntries.push(publishedEntry);
    hasOpaqueEntries = true;
  }
  if (remainingExpectedEntries?.length) {
    return undefined;
  }
  if (hasOpaqueEntries) {
    return { kind: "opaque", entries, publishedEntries };
  }
  if (hasGlobalMetadata) {
    return { kind: "global-metadata", entries, publishedEntries };
  }
  return {
    kind: "transcript-only",
    entries: entries as SessionMessageEntry[],
    publishedEntries,
  };
}

export function haveSamePublishedEntries(
  actual: readonly OwnedSessionTranscriptPublishedEntry[],
  expected: readonly OwnedSessionTranscriptPublishedEntry[],
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  const unmatched = [...expected];
  for (const entry of actual) {
    const matchIndex = unmatched.findIndex((candidate) => isDeepStrictEqual(candidate, entry));
    if (matchIndex < 0) {
      return false;
    }
    unmatched.splice(matchIndex, 1);
  }
  return true;
}

function normalizeTranscriptEntryId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function omitRecordKeys(
  record: Record<string, unknown>,
  keys: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

export function lineMatchesLinearTranscriptMigration(params: {
  previousLine: string;
  currentLine: string;
  expectedParentId: string | null;
}): { ok: true; nextPreviousId?: string } | { ok: false } {
  let previousParsed: unknown;
  let currentParsed: unknown;
  try {
    previousParsed = JSON.parse(params.previousLine);
    currentParsed = JSON.parse(params.currentLine);
  } catch {
    return params.previousLine === params.currentLine ? { ok: true } : { ok: false };
  }
  if (!isJsonRecord(previousParsed)) {
    return params.previousLine === params.currentLine ? { ok: true } : { ok: false };
  }
  if (!isJsonRecord(currentParsed)) {
    return { ok: false };
  }
  if (previousParsed.type === "session") {
    return isDeepStrictEqual(
      omitRecordKeys(previousParsed, new Set(["version"])),
      omitRecordKeys(currentParsed, new Set(["version"])),
    )
      ? { ok: true }
      : { ok: false };
  }

  const previousId = normalizeTranscriptEntryId(previousParsed.id);
  const currentId = normalizeTranscriptEntryId(currentParsed.id);
  if (previousId ? currentId !== previousId : !currentId) {
    return { ok: false };
  }
  if (Object.hasOwn(previousParsed, "parentId")) {
    if (!isDeepStrictEqual(previousParsed.parentId, currentParsed.parentId)) {
      return { ok: false };
    }
  } else if (!isDeepStrictEqual(currentParsed.parentId, params.expectedParentId)) {
    return { ok: false };
  }

  return isDeepStrictEqual(
    omitRecordKeys(previousParsed, new Set(["id", "parentId"])),
    omitRecordKeys(currentParsed, new Set(["id", "parentId"])),
  )
    ? { ok: true, nextPreviousId: currentId }
    : { ok: false };
}
