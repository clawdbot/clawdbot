/**
 * Persisted session JSONL repair helpers.
 * Drops malformed transcript entries, rewrites unreplayable blank/error turns,
 * and inserts missing code-mode tool results before replay.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeInlineImageBase64 } from "@openclaw/media-core/inline-image-data-url";
import { parseSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeMissingToolResult } from "./session-transcript-repair.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "./stream-message-shared.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

/**
 * Placeholder for blank user messages.
 * Preserves the user turn so strict providers that require at least one user
 * message do not reject the transcript.
 */
const BLANK_USER_FALLBACK_TEXT = "(continue)";
const CORRUPTED_IMAGE_FALLBACK_TEXT = "[image omitted: corrupted base64 payload]";

type RepairReport = {
  repaired: boolean;
  droppedLines: number;
  validatedSnapshot?: SessionRepairFileSnapshot;
  rewrittenAssistantMessages?: number;
  droppedBlankUserMessages?: number;
  rewrittenUserMessages?: number;
  removedCorruptedImageBlocks?: number;
  insertedToolResults?: number;
  backupPath?: string;
  reason?: string;
};

type SessionRepairFileSnapshot = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type SessionRepairCacheEntry = {
  snapshot: SessionRepairFileSnapshot;
  toolResultIds: Set<string>;
  endsWithNewline: boolean;
};

const MAX_CACHED_SESSION_REPAIRS = 8;
const MAX_INCREMENTAL_REPAIR_BYTES = 8n * 1024n * 1024n;
const MAX_CACHED_REPAIR_TOOL_RESULT_IDS = 4_096;
const MAX_CACHED_REPAIR_TOOL_RESULT_ID_BYTES = 512 * 1024;
const sessionRepairCache = new Map<string, SessionRepairCacheEntry>();

export function invalidateSessionFileRepairCache(sessionFile: string): void {
  const trimmed = sessionFile.trim();
  if (trimmed) {
    if (parseSqliteSessionFileMarker(trimmed)) {
      sessionRepairCache.delete(trimmed);
      return;
    }
    sessionRepairCache.delete(path.resolve(trimmed));
  }
}

type SessionMessageEntry = {
  type: "message";
  message: { role: string; content?: unknown } & Record<string, unknown>;
} & Record<string, unknown>;

async function readSessionRepairSnapshot(
  sessionFile: string,
): Promise<SessionRepairFileSnapshot | undefined> {
  if (parseSqliteSessionFileMarker(sessionFile)) {
    return undefined;
  }
  try {
    const stat = await fs.stat(sessionFile, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch {
    return undefined;
  }
}

function isSameSessionRepairSnapshot(
  left: SessionRepairFileSnapshot,
  right: SessionRepairFileSnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isSameSessionRepairFile(
  left: SessionRepairFileSnapshot,
  right: SessionRepairFileSnapshot,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function rememberSessionRepair(sessionFile: string, state: SessionRepairCacheEntry): void {
  if (
    state.toolResultIds.size > MAX_CACHED_REPAIR_TOOL_RESULT_IDS ||
    countToolResultIdBytes(state.toolResultIds) > MAX_CACHED_REPAIR_TOOL_RESULT_ID_BYTES
  ) {
    sessionRepairCache.delete(sessionFile);
    return;
  }
  sessionRepairCache.delete(sessionFile);
  sessionRepairCache.set(sessionFile, state);
  while (sessionRepairCache.size > MAX_CACHED_SESSION_REPAIRS) {
    const oldestKey = sessionRepairCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionRepairCache.delete(oldestKey);
  }
}

function countToolResultIdBytes(ids: ReadonlySet<string>): number {
  let bytes = 0;
  for (const id of ids) {
    bytes += Buffer.byteLength(id, "utf8");
    if (bytes > MAX_CACHED_REPAIR_TOOL_RESULT_ID_BYTES) {
      break;
    }
  }
  return bytes;
}

async function readSessionRepairSuffix(
  sessionFile: string,
  offset: bigint,
  length: bigint,
): Promise<string | undefined> {
  if (
    offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    length > MAX_INCREMENTAL_REPAIR_BYTES ||
    length > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return undefined;
  }
  const buffer = Buffer.alloc(Number(length));
  const file = await fs.open(sessionFile, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Number(offset));
    return bytesRead === buffer.length ? buffer.toString("utf8") : undefined;
  } finally {
    await file.close();
  }
}

function isSessionHeader(entry: unknown): entry is { type: string; id: string } {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}

/**
 * Detect a `type: "message"` entry whose `message.role` is missing, `null`, or
 * not a non-empty string. Such entries surface in the wild as "null role"
 * JSONL corruption (e.g. #77228 reported transcripts that contained 935+
 * entries with null roles after an earlier failure). They cannot be replayed
 * to any provider — every provider router branches on `message.role` — and
 * preserving them through repair just relocates the corruption from the
 * original file into the post-repair file. Treat them as malformed lines:
 * drop during repair so the cleaned transcript no longer carries them.
 */
function isStructurallyInvalidMessageEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message") {
    return false;
  }
  if (!record.message || typeof record.message !== "object") {
    return true;
  }
  const role = (record.message as { role?: unknown }).role;
  return typeof role !== "string" || role.trim().length === 0;
}

function isAssistantEntryWithEmptyContent(entry: unknown): entry is SessionMessageEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
  };
  if (message.role !== "assistant") {
    return false;
  }
  if (!Array.isArray(message.content) || message.content.length !== 0) {
    return false;
  }
  // Only error stops — clean stops with empty content (NO_REPLY path) are
  // valid silent replies that must not be overwritten with synthetic text.
  return message.stopReason === "error";
}

function rewriteAssistantEntryWithEmptyContent(entry: SessionMessageEntry): SessionMessageEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
    },
  };
}

function isImageMimeType(value: unknown): value is string {
  return typeof value === "string" && /^image\//iu.test(value.trim());
}

function containsNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return true;
    }
  }
  return false;
}

function isCorruptedImageContentBlock(block: unknown): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return false;
  }
  const record = block as {
    type?: unknown;
    data?: unknown;
    mimeType?: unknown;
    mediaType?: unknown;
    media_type?: unknown;
  };
  if (record.type !== "image" || typeof record.data !== "string") {
    return false;
  }
  const mimeType = [record.mimeType, record.mediaType, record.media_type].find(isImageMimeType);
  if (!mimeType) {
    return false;
  }
  return (
    containsNonAscii(record.data) ||
    sanitizeInlineImageBase64({ base64: record.data, mimeType }) === undefined
  );
}

function repairEntryWithCorruptedImageBlocks(entry: SessionMessageEntry): {
  entry: SessionMessageEntry;
  removedCorruptedImageBlocks: number;
} {
  const content = entry.message.content;
  if (!Array.isArray(content)) {
    return { entry, removedCorruptedImageBlocks: 0 };
  }

  let removedCorruptedImageBlocks = 0;
  const nextContent = content.map((block) => {
    if (!isCorruptedImageContentBlock(block)) {
      return block;
    }
    removedCorruptedImageBlocks += 1;
    return { type: "text", text: CORRUPTED_IMAGE_FALLBACK_TEXT };
  });
  if (removedCorruptedImageBlocks === 0) {
    return { entry, removedCorruptedImageBlocks: 0 };
  }
  return {
    entry: {
      ...entry,
      message: {
        ...entry.message,
        content: nextContent,
      },
    },
    removedCorruptedImageBlocks,
  };
}

type UserEntryRepair =
  | { kind: "drop" }
  | { kind: "rewrite"; entry: SessionMessageEntry }
  | { kind: "keep" };

function repairUserEntryWithBlankTextContent(entry: SessionMessageEntry): UserEntryRepair {
  const content = entry.message.content;
  if (typeof content === "string") {
    if (content.trim()) {
      return { kind: "keep" };
    }
    return {
      kind: "rewrite",
      entry: {
        ...entry,
        message: {
          ...entry.message,
          content: BLANK_USER_FALLBACK_TEXT,
        },
      },
    };
  }
  if (!Array.isArray(content)) {
    return { kind: "keep" };
  }

  let touched = false;
  const nextContent = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    if ((block as { type?: unknown }).type !== "text") {
      return true;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim().length > 0) {
      return true;
    }
    touched = true;
    return false;
  });
  if (nextContent.length === 0) {
    return {
      kind: "rewrite",
      entry: {
        ...entry,
        message: {
          ...entry.message,
          content: [{ type: "text", text: BLANK_USER_FALLBACK_TEXT }],
        },
      },
    };
  }
  if (!touched) {
    return { kind: "keep" };
  }
  return {
    kind: "rewrite",
    entry: {
      ...entry,
      message: {
        ...entry.message,
        content: nextContent,
      },
    },
  };
}

function buildRepairSummaryParts(params: {
  droppedLines: number;
  rewrittenAssistantMessages: number;
  droppedBlankUserMessages: number;
  rewrittenUserMessages: number;
  removedCorruptedImageBlocks: number;
  insertedToolResults: number;
}): string {
  const parts: string[] = [];
  if (params.droppedLines > 0) {
    parts.push(`dropped ${params.droppedLines} malformed line(s)`);
  }
  if (params.rewrittenAssistantMessages > 0) {
    parts.push(`rewrote ${params.rewrittenAssistantMessages} assistant message(s)`);
  }
  if (params.droppedBlankUserMessages > 0) {
    parts.push(`dropped ${params.droppedBlankUserMessages} blank user message(s)`);
  }
  if (params.rewrittenUserMessages > 0) {
    parts.push(`rewrote ${params.rewrittenUserMessages} user message(s)`);
  }
  if (params.removedCorruptedImageBlocks > 0) {
    parts.push(`removed ${params.removedCorruptedImageBlocks} corrupted image block(s)`);
  }
  if (params.insertedToolResults > 0) {
    parts.push(`inserted ${params.insertedToolResults} missing tool result(s)`);
  }
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

function isCodeModeToolCallRepairCandidate(entry: unknown): entry is SessionMessageEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as {
    role?: unknown;
    api?: unknown;
    provider?: unknown;
    stopReason?: unknown;
  };
  return (
    message.role === "assistant" &&
    message.api === "openai-chatgpt-responses" &&
    message.provider === "openai" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

function normalizeTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isOpenAIResponsesReplayApi(value: unknown): boolean {
  const api = normalizeTrimmedString(value);
  return (
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    api === "openai-codex-responses"
  );
}

function isTranscriptOnlyDeliveryMirrorEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as { role?: unknown; provider?: unknown; model?: unknown };
  return (
    message.role === "assistant" &&
    normalizeTrimmedString(message.provider) === "openclaw" &&
    (normalizeTrimmedString(message.model) === "delivery-mirror" ||
      normalizeTrimmedString(message.model) === "gateway-injected")
  );
}

function isResponsesMessageToolRepairCandidate(entry: unknown): entry is SessionMessageEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as {
    role?: unknown;
    api?: unknown;
    stopReason?: unknown;
  };
  return (
    message.role === "assistant" &&
    isOpenAIResponsesReplayApi(message.api) &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

function isMessageToolCallName(value: unknown): boolean {
  return normalizeTrimmedString(value).toLowerCase() === "message";
}

function findNextSessionMessageEntry(
  entries: unknown[],
  startIndex: number,
): SessionMessageEntry | undefined {
  for (let i = startIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { type?: unknown; message?: unknown };
    if (record.type === "message" && record.message && typeof record.message === "object") {
      return entry as SessionMessageEntry;
    }
  }
  return undefined;
}

function collectPersistedToolResultIds(entries: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { type?: unknown; message?: unknown };
    if (record.type !== "message" || !record.message || typeof record.message !== "object") {
      continue;
    }
    const message = record.message as AgentMessage;
    if (message.role !== "toolResult") {
      continue;
    }
    const id = extractToolResultId(message);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function makeSyntheticToolResultEntry(params: {
  parent: SessionMessageEntry;
  toolCallId: string;
  toolName?: string;
}): SessionMessageEntry {
  const message = makeMissingToolResult({
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    text: "aborted",
  });
  return {
    type: "message",
    id: `repair-${randomUUID()}`,
    parentId: typeof params.parent.id === "string" ? params.parent.id : undefined,
    timestamp: new Date().toISOString(),
    message: message as unknown as SessionMessageEntry["message"],
  };
}

function insertMissingCodeModeToolResults(
  entries: unknown[],
  existingResultIds: ReadonlySet<string> = new Set(),
): {
  entries: unknown[];
  insertedToolResults: number;
  resultIds: Set<string>;
} {
  const resultIds = new Set(existingResultIds);
  for (const resultId of collectPersistedToolResultIds(entries)) {
    resultIds.add(resultId);
  }
  let insertedToolResults = 0;
  const out: unknown[] = [];

  for (const entry of entries) {
    out.push(entry);
    if (!isCodeModeToolCallRepairCandidate(entry)) {
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(
      entry.message as unknown as Extract<AgentMessage, { role: "assistant" }>,
    );
    for (const toolCall of toolCalls) {
      if (resultIds.has(toolCall.id)) {
        continue;
      }
      out.push(
        makeSyntheticToolResultEntry({
          parent: entry,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        }),
      );
      resultIds.add(toolCall.id);
      insertedToolResults += 1;
    }
  }

  return {
    entries: insertedToolResults > 0 ? out : entries,
    insertedToolResults,
    resultIds,
  };
}

function insertMissingMessageToolDeliveryMirrorResults(
  entries: unknown[],
  existingResultIds: ReadonlySet<string> = new Set(),
): {
  entries: unknown[];
  insertedToolResults: number;
  resultIds: Set<string>;
} {
  const resultIds = new Set(existingResultIds);
  for (const resultId of collectPersistedToolResultIds(entries)) {
    resultIds.add(resultId);
  }
  let insertedToolResults = 0;
  const out: unknown[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    out.push(entry);
    if (!isResponsesMessageToolRepairCandidate(entry)) {
      continue;
    }
    if (!isTranscriptOnlyDeliveryMirrorEntry(findNextSessionMessageEntry(entries, i))) {
      continue;
    }
    const toolCalls = extractToolCallsFromAssistant(
      entry.message as unknown as Extract<AgentMessage, { role: "assistant" }>,
    );
    for (const toolCall of toolCalls) {
      if (!isMessageToolCallName(toolCall.name) || resultIds.has(toolCall.id)) {
        continue;
      }
      out.push(
        makeSyntheticToolResultEntry({
          parent: entry,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        }),
      );
      resultIds.add(toolCall.id);
      insertedToolResults += 1;
    }
  }

  return {
    entries: insertedToolResults > 0 ? out : entries,
    insertedToolResults,
    resultIds,
  };
}

type RepairEntriesResult = {
  entries: unknown[];
  droppedLines: number;
  rewrittenAssistantMessages: number;
  droppedBlankUserMessages: number;
  rewrittenUserMessages: number;
  removedCorruptedImageBlocks: number;
};

function repairSessionLines(lines: string[]): RepairEntriesResult {
  const entries: unknown[] = [];
  let droppedLines = 0;
  let rewrittenAssistantMessages = 0;
  let droppedBlankUserMessages = 0;
  let rewrittenUserMessages = 0;
  let removedCorruptedImageBlocks = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      if (isStructurallyInvalidMessageEntry(entry)) {
        droppedLines += 1;
        continue;
      }
      if (isAssistantEntryWithEmptyContent(entry)) {
        entries.push(rewriteAssistantEntryWithEmptyContent(entry));
        rewrittenAssistantMessages += 1;
        continue;
      }
      let entryForUserRepair = entry;
      if (
        entry &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "message" &&
        typeof (entry as { message?: unknown }).message === "object"
      ) {
        const imageRepair = repairEntryWithCorruptedImageBlocks(entry as SessionMessageEntry);
        entryForUserRepair = imageRepair.entry;
        removedCorruptedImageBlocks += imageRepair.removedCorruptedImageBlocks;
      }
      if (
        entryForUserRepair &&
        typeof entryForUserRepair === "object" &&
        (entryForUserRepair as { type?: unknown }).type === "message" &&
        typeof (entryForUserRepair as { message?: unknown }).message === "object" &&
        ((entryForUserRepair as { message: { role?: unknown } }).message?.role ?? undefined) ===
          "user"
      ) {
        const repairedUser = repairUserEntryWithBlankTextContent(
          entryForUserRepair as SessionMessageEntry,
        );
        if (repairedUser.kind === "drop") {
          droppedBlankUserMessages += 1;
          continue;
        }
        if (repairedUser.kind === "rewrite") {
          entries.push(repairedUser.entry);
          rewrittenUserMessages += 1;
          continue;
        }
      }
      entries.push(entryForUserRepair);
    } catch {
      droppedLines += 1;
    }
  }

  return {
    entries,
    droppedLines,
    rewrittenAssistantMessages,
    droppedBlankUserMessages,
    rewrittenUserMessages,
    removedCorruptedImageBlocks,
  };
}

function hasEntryRepairs(result: RepairEntriesResult): boolean {
  return (
    result.droppedLines > 0 ||
    result.rewrittenAssistantMessages > 0 ||
    result.droppedBlankUserMessages > 0 ||
    result.rewrittenUserMessages > 0 ||
    result.removedCorruptedImageBlocks > 0
  );
}

async function tryIncrementalSessionRepair(params: {
  sessionFile: string;
  currentSnapshot: SessionRepairFileSnapshot;
  cached: SessionRepairCacheEntry;
  trustedSnapshot: SessionRepairFileSnapshot | undefined;
}): Promise<RepairReport | undefined> {
  if (isSameSessionRepairSnapshot(params.cached.snapshot, params.currentSnapshot)) {
    return {
      repaired: false,
      droppedLines: 0,
      validatedSnapshot: params.currentSnapshot,
    };
  }
  if (
    !params.trustedSnapshot ||
    !isSameSessionRepairSnapshot(params.trustedSnapshot, params.currentSnapshot) ||
    !params.cached.endsWithNewline ||
    !isSameSessionRepairFile(params.cached.snapshot, params.currentSnapshot) ||
    params.currentSnapshot.size <= params.cached.snapshot.size
  ) {
    return undefined;
  }

  const appendedText = await readSessionRepairSuffix(
    params.sessionFile,
    params.cached.snapshot.size,
    params.currentSnapshot.size - params.cached.snapshot.size,
  );
  if (!appendedText?.endsWith("\n")) {
    return undefined;
  }
  const afterReadSnapshot = await readSessionRepairSnapshot(params.sessionFile);
  if (
    !afterReadSnapshot ||
    !isSameSessionRepairSnapshot(params.currentSnapshot, afterReadSnapshot)
  ) {
    return undefined;
  }

  const repairedEntries = repairSessionLines(appendedText.split(/\r?\n/));
  if (hasEntryRepairs(repairedEntries)) {
    return undefined;
  }
  const codeModeToolResultRepair = insertMissingCodeModeToolResults(
    repairedEntries.entries,
    params.cached.toolResultIds,
  );
  if (codeModeToolResultRepair.insertedToolResults > 0) {
    return undefined;
  }
  const messageDeliveryToolResultRepair = insertMissingMessageToolDeliveryMirrorResults(
    codeModeToolResultRepair.entries,
    codeModeToolResultRepair.resultIds,
  );
  if (messageDeliveryToolResultRepair.insertedToolResults > 0) {
    return undefined;
  }

  rememberSessionRepair(params.sessionFile, {
    snapshot: afterReadSnapshot,
    toolResultIds: messageDeliveryToolResultRepair.resultIds,
    endsWithNewline: true,
  });
  return {
    repaired: false,
    droppedLines: 0,
    validatedSnapshot: afterReadSnapshot,
  };
}

/** Repair a persisted session JSONL file in place when replay-breaking corruption is found. */
export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
  trustedSnapshot?: SessionRepairFileSnapshot;
  debug?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const sessionFileInput = params.sessionFile.trim();
  if (!sessionFileInput) {
    return { repaired: false, droppedLines: 0, reason: "missing session file" };
  }
  if (parseSqliteSessionFileMarker(sessionFileInput)) {
    return { repaired: false, droppedLines: 0, reason: "sqlite transcript" };
  }
  const sessionFile = path.resolve(sessionFileInput);
  const beforeReadSnapshot = await readSessionRepairSnapshot(sessionFile);
  if (beforeReadSnapshot) {
    const cached = sessionRepairCache.get(sessionFile);
    if (cached) {
      const incremental = await tryIncrementalSessionRepair({
        sessionFile,
        currentSnapshot: beforeReadSnapshot,
        cached,
        trustedSnapshot: params.trustedSnapshot,
      });
      if (incremental) {
        return incremental;
      }
    }
  } else {
    sessionRepairCache.delete(sessionFile);
  }

  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch (err) {
    sessionRepairCache.delete(sessionFile);
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return { repaired: false, droppedLines: 0, reason: "missing session file" };
    }
    const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
    params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
    return { repaired: false, droppedLines: 0, reason };
  }

  const repairedEntries = repairSessionLines(content.split(/\r?\n/));
  const {
    entries,
    droppedLines,
    rewrittenAssistantMessages,
    droppedBlankUserMessages,
    rewrittenUserMessages,
    removedCorruptedImageBlocks,
  } = repairedEntries;

  if (entries.length === 0) {
    sessionRepairCache.delete(sessionFile);
    return { repaired: false, droppedLines, reason: "empty session file" };
  }
  if (!isSessionHeader(entries[0])) {
    sessionRepairCache.delete(sessionFile);
    params.warn?.(
      `session file repair skipped: invalid session header (${path.basename(sessionFile)})`,
    );
    return { repaired: false, droppedLines, reason: "invalid session header" };
  }

  const codeModeToolResultRepair = insertMissingCodeModeToolResults(entries);
  let insertedToolResults = codeModeToolResultRepair.insertedToolResults;
  if (codeModeToolResultRepair.insertedToolResults > 0) {
    entries.splice(0, entries.length, ...codeModeToolResultRepair.entries);
  }

  const messageDeliveryToolResultRepair = insertMissingMessageToolDeliveryMirrorResults(
    entries,
    codeModeToolResultRepair.resultIds,
  );
  insertedToolResults += messageDeliveryToolResultRepair.insertedToolResults;
  if (messageDeliveryToolResultRepair.insertedToolResults > 0) {
    entries.splice(0, entries.length, ...messageDeliveryToolResultRepair.entries);
  }
  const repairedToolResultIds = messageDeliveryToolResultRepair.resultIds;

  if (!hasEntryRepairs(repairedEntries) && insertedToolResults === 0) {
    const afterReadSnapshot = await readSessionRepairSnapshot(sessionFile);
    const validatedSnapshot =
      beforeReadSnapshot &&
      afterReadSnapshot &&
      isSameSessionRepairSnapshot(beforeReadSnapshot, afterReadSnapshot)
        ? afterReadSnapshot
        : undefined;
    if (validatedSnapshot) {
      rememberSessionRepair(sessionFile, {
        snapshot: validatedSnapshot,
        toolResultIds: repairedToolResultIds,
        endsWithNewline: content.endsWith("\n"),
      });
    } else {
      sessionRepairCache.delete(sessionFile);
    }
    return {
      repaired: false,
      droppedLines: 0,
      ...(validatedSnapshot ? { validatedSnapshot } : {}),
    };
  }

  const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  let retainedBackupPath: string | undefined;
  try {
    const stat = await fs.stat(sessionFile).catch(() => null);
    await fs.writeFile(backupPath, content, "utf-8");
    if (stat) {
      await fs.chmod(backupPath, stat.mode);
    }
    await replaceFileAtomic({
      filePath: sessionFile,
      content: cleaned,
      preserveExistingMode: true,
      tempPrefix: `${path.basename(sessionFile)}.repair`,
    });
    await fs.unlink(backupPath).catch((cleanupErr: unknown) => {
      retainedBackupPath = backupPath;
      params.debug?.(
        `session file repair backup cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"} (${path.basename(
          backupPath,
        )})`,
      );
    });
  } catch (err) {
    sessionRepairCache.delete(sessionFile);
    return {
      repaired: false,
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      removedCorruptedImageBlocks,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  let repairedSnapshot: SessionRepairFileSnapshot | undefined;
  try {
    const beforeVerifySnapshot = await readSessionRepairSnapshot(sessionFile);
    const persistedContent = await fs.readFile(sessionFile, "utf8");
    const afterVerifySnapshot = await readSessionRepairSnapshot(sessionFile);
    if (
      beforeVerifySnapshot &&
      afterVerifySnapshot &&
      persistedContent === cleaned &&
      isSameSessionRepairSnapshot(beforeVerifySnapshot, afterVerifySnapshot)
    ) {
      repairedSnapshot = afterVerifySnapshot;
    }
  } catch {
    repairedSnapshot = undefined;
  }
  if (repairedSnapshot) {
    rememberSessionRepair(sessionFile, {
      snapshot: repairedSnapshot,
      toolResultIds: repairedToolResultIds,
      endsWithNewline: true,
    });
  } else {
    sessionRepairCache.delete(sessionFile);
  }
  params.debug?.(
    `session file repaired: ${buildRepairSummaryParts({
      droppedLines,
      rewrittenAssistantMessages,
      droppedBlankUserMessages,
      rewrittenUserMessages,
      removedCorruptedImageBlocks,
      insertedToolResults,
    })} (${path.basename(sessionFile)})`,
  );
  return {
    repaired: true,
    droppedLines,
    ...(repairedSnapshot ? { validatedSnapshot: repairedSnapshot } : {}),
    rewrittenAssistantMessages,
    droppedBlankUserMessages,
    rewrittenUserMessages,
    removedCorruptedImageBlocks,
    insertedToolResults,
    ...(retainedBackupPath ? { backupPath: retainedBackupPath } : {}),
  };
}
