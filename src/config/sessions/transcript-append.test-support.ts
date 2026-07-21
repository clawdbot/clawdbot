// Transcript append utilities create headers, migrate linear JSONL, and append parent-linked turns.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveTimestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "../../agents/runtime/index.js";
import {
  acquireSessionWriteLock,
  resolveSessionWriteLockOptions,
} from "../../agents/session-write-lock.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { redactSecrets } from "../../logging/redact.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { serializeJsonlEntry, serializeJsonlLine, writeJsonlLines } from "./transcript-jsonl.js";
import {
  streamSessionTranscriptLines,
  streamSessionTranscriptLinesReverse,
} from "./transcript-stream.js";
import { isCanonicalSessionTranscriptEntry } from "./transcript-tree.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

const SESSION_MANAGER_APPEND_MAX_BYTES = 8 * 1024 * 1024;

const transcriptAppendQueue = new KeyedAsyncQueue();

async function writeJsonlEntry(
  filePath: string,
  entry: unknown,
  options?: { encoding?: BufferEncoding; flag?: string; mode?: number },
): Promise<void> {
  await fs.writeFile(filePath, serializeJsonlEntry(entry), {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
}

async function appendSerializedJsonlEntry(
  filePath: string,
  serializedEntry: string,
): Promise<void> {
  const handle = await fs.open(filePath, "a+", 0o600);
  try {
    const stat = await handle.stat();
    let prefixNewline = false;
    if (stat.size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(lastByte, 0, 1, stat.size - 1);
      prefixNewline = bytesRead === 1 && lastByte[0] !== 0x0a;
    }
    await handle.appendFile(`${prefixNewline ? "\n" : ""}${serializedEntry}`, "utf-8");
  } finally {
    await handle.close();
  }
}

async function appendJsonlEntry(filePath: string, entry: unknown): Promise<void> {
  await appendSerializedJsonlEntry(filePath, serializeJsonlEntry(entry));
}

type TranscriptLeafInfo = {
  leafId?: string;
  appendMode: "active" | "side";
  hasParentLinkedEntries: boolean;
  nonSessionEntryCount: number;
};

type TranscriptLineInfo = {
  isNonSessionEntry: boolean;
  hasParentLinkedEntry: boolean;
  entryId?: string;
  isCanonicalEntry?: boolean;
  appendMode?: "side";
  leafControl?: {
    targetId: string | null;
    appendParentId?: string | null;
    appendMode?: "side";
  };
  invalidLeafControl?: boolean;
};

function readTranscriptLineInfo(line: string): TranscriptLineInfo {
  if (!line.trim()) {
    return { isNonSessionEntry: false, hasParentLinkedEntry: false };
  }
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      id?: unknown;
      parentId?: unknown;
      targetId?: unknown;
      appendParentId?: unknown;
      appendMode?: unknown;
    };
    if (parsed.type === "session") {
      return { isNonSessionEntry: false, hasParentLinkedEntry: false };
    }
    const entryId = normalizeEntryId(parsed.id);
    if (!entryId) {
      return { isNonSessionEntry: true, hasParentLinkedEntry: false };
    }
    if (!("parentId" in parsed)) {
      const isCanonicalEntry = isCanonicalSessionTranscriptEntry(parsed);
      return {
        isNonSessionEntry: true,
        hasParentLinkedEntry: false,
        ...(isCanonicalEntry ? { entryId, isCanonicalEntry: true as const } : {}),
        ...(isCanonicalEntry && parsed.appendMode === "side"
          ? { appendMode: parsed.appendMode }
          : {}),
      };
    }
    if (parsed.type === "leaf") {
      const targetId = parsed.targetId === null ? null : normalizeEntryId(parsed.targetId);
      const appendParentId =
        parsed.appendParentId === undefined
          ? undefined
          : parsed.appendParentId === null
            ? null
            : normalizeEntryId(parsed.appendParentId);
      if (
        (parsed.targetId !== null && targetId === undefined) ||
        (parsed.appendParentId !== undefined && appendParentId === undefined) ||
        (parsed.appendMode !== undefined && parsed.appendMode !== "side")
      ) {
        return {
          isNonSessionEntry: true,
          hasParentLinkedEntry: true,
          entryId,
          invalidLeafControl: true,
        };
      }
      return {
        isNonSessionEntry: true,
        hasParentLinkedEntry: true,
        entryId,
        leafControl: {
          targetId: targetId ?? null,
          ...(appendParentId !== undefined ? { appendParentId } : {}),
          ...(parsed.appendMode === "side" ? { appendMode: parsed.appendMode } : {}),
        },
      };
    }
    const isCanonicalEntry = isCanonicalSessionTranscriptEntry(parsed);
    return {
      isNonSessionEntry: true,
      hasParentLinkedEntry: true,
      entryId,
      ...(isCanonicalEntry ? { isCanonicalEntry: true as const } : {}),
      ...(isCanonicalEntry && parsed.appendMode === "side"
        ? { appendMode: parsed.appendMode }
        : {}),
    };
  } catch {
    return { isNonSessionEntry: false, hasParentLinkedEntry: false };
  }
}

function normalizeEntryId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function generateEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = randomUUID();
  existingIds.add(id);
  return id;
}

async function validateTranscriptLeafControlReferences(params: {
  transcriptPath: string;
  leafControlId: string;
  leafControl: NonNullable<TranscriptLineInfo["leafControl"]>;
}): Promise<boolean> {
  const referenceIds = new Set(
    [params.leafControl.targetId, params.leafControl.appendParentId].filter(
      (id): id is string => typeof id === "string",
    ),
  );
  if (referenceIds.size === 0) {
    return true;
  }

  for await (const line of streamSessionTranscriptLines(params.transcriptPath)) {
    const lineInfo = readTranscriptLineInfo(line);
    if (lineInfo.entryId === params.leafControlId) {
      break;
    }
    if (!lineInfo.entryId || !referenceIds.has(lineInfo.entryId)) {
      continue;
    }
    if (
      lineInfo.invalidLeafControl ||
      (lineInfo.leafControl &&
        !(await validateTranscriptLeafControlReferences({
          transcriptPath: params.transcriptPath,
          leafControlId: lineInfo.entryId,
          leafControl: lineInfo.leafControl,
        })))
    ) {
      return false;
    }
    referenceIds.delete(lineInfo.entryId);
    if (referenceIds.size === 0) {
      return true;
    }
  }
  return false;
}

async function resolveTranscriptLeafIdFromTrailingControls(
  transcriptPath: string,
): Promise<{ leafId?: string; appendMode: "active" | "side" }> {
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    const lineInfo = readTranscriptLineInfo(line);
    if (!lineInfo.entryId || lineInfo.invalidLeafControl) {
      continue;
    }
    if (!lineInfo.leafControl) {
      return {
        leafId: lineInfo.entryId,
        appendMode: lineInfo.appendMode === "side" ? "side" : "active",
      };
    }
    const valid = await validateTranscriptLeafControlReferences({
      transcriptPath,
      leafControlId: lineInfo.entryId,
      leafControl: lineInfo.leafControl,
    });
    if (valid) {
      const { targetId, appendParentId, appendMode } = lineInfo.leafControl;
      const leafId = (appendParentId === undefined ? targetId : appendParentId) ?? undefined;
      return {
        ...(leafId ? { leafId } : {}),
        appendMode: appendMode === "side" ? "side" : "active",
      };
    }
  }
  return { appendMode: "active" };
}

async function readTranscriptLeafInfoForward(transcriptPath: string): Promise<TranscriptLeafInfo> {
  let leafId: string | undefined;
  let hasParentLinkedEntries = false;
  let nonSessionEntryCount = 0;
  let hasTrailingLeafControl = false;
  let appendMode: "active" | "side" = "active";
  for await (const line of streamSessionTranscriptLines(transcriptPath)) {
    const lineInfo = readTranscriptLineInfo(line);
    if (lineInfo.isNonSessionEntry) {
      nonSessionEntryCount += 1;
    }
    if (lineInfo.hasParentLinkedEntry) {
      hasParentLinkedEntries = true;
    }
    if (!lineInfo.entryId) {
      continue;
    }
    if (lineInfo.invalidLeafControl || lineInfo.leafControl) {
      if (lineInfo.leafControl) {
        appendMode = lineInfo.leafControl.appendMode === "side" ? "side" : "active";
      }
      hasTrailingLeafControl = true;
      continue;
    }
    leafId = lineInfo.entryId;
    if (lineInfo.isCanonicalEntry) {
      appendMode = lineInfo.appendMode === "side" ? "side" : "active";
    }
    hasTrailingLeafControl = false;
  }
  if (hasTrailingLeafControl) {
    const resolvedLeaf = await resolveTranscriptLeafIdFromTrailingControls(transcriptPath);
    leafId = resolvedLeaf.leafId;
    appendMode = resolvedLeaf.appendMode;
  }
  return {
    ...(leafId ? { leafId } : {}),
    appendMode,
    hasParentLinkedEntries,
    nonSessionEntryCount,
  };
}

async function readTranscriptLeafInfo(transcriptPath: string): Promise<TranscriptLeafInfo> {
  let latestEntryId: string | undefined;
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    const lineInfo = readTranscriptLineInfo(line);
    if (!lineInfo.entryId) {
      continue;
    }
    if (lineInfo.invalidLeafControl) {
      break;
    }
    if (lineInfo.leafControl) {
      if (latestEntryId) {
        const valid = await validateTranscriptLeafControlReferences({
          transcriptPath,
          leafControlId: lineInfo.entryId,
          leafControl: lineInfo.leafControl,
        });
        if (!valid) {
          break;
        }
        return {
          leafId: latestEntryId,
          appendMode: lineInfo.leafControl.appendMode === "side" ? "side" : "active",
          hasParentLinkedEntries: true,
          nonSessionEntryCount: 0,
        };
      }
      const resolvedLeaf = await resolveTranscriptLeafIdFromTrailingControls(transcriptPath);
      return {
        ...(resolvedLeaf.leafId ? { leafId: resolvedLeaf.leafId } : {}),
        appendMode: resolvedLeaf.appendMode,
        hasParentLinkedEntries: true,
        nonSessionEntryCount: 0,
      };
    }
    latestEntryId ??= lineInfo.entryId;
    if (lineInfo.isCanonicalEntry && lineInfo.hasParentLinkedEntry) {
      return {
        leafId: latestEntryId,
        appendMode: lineInfo.appendMode === "side" ? "side" : "active",
        hasParentLinkedEntries: true,
        nonSessionEntryCount: 0,
      };
    }
    // A latest entry without parent linkage may be a legacy linear transcript.
    // Fall back to the full scan only when migration detection needs it.
    break;
  }
  return await readTranscriptLeafInfoForward(transcriptPath);
}

async function migrateLinearTranscriptToParentLinked(transcriptPath: string): Promise<{
  leafId?: string;
}> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  const existingIds = new Set<string>();
  const output: string[] = [];
  let previousId: string | null = null;
  let leafId: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.push(line);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      output.push(line);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "session") {
      output.push(serializeJsonlLine({ ...record, version: CURRENT_SESSION_VERSION }));
      continue;
    }
    const id = normalizeEntryId(record.id) ?? generateEntryId(existingIds);
    existingIds.add(id);
    record.id = id;
    if (!Object.hasOwn(record, "parentId")) {
      // Legacy linear transcripts become a linked list while preserving existing ids when present.
      record.parentId = previousId;
    }
    previousId = id;
    leafId = id;
    output.push(serializeJsonlLine(record));
  }
  await writeJsonlLines(transcriptPath, output, { mode: 0o600 });
  const result: { leafId?: string } = {};
  if (leafId) {
    result.leafId = leafId;
  }
  return result;
}

async function ensureTranscriptHeader(
  transcriptPath: string,
  params: { sessionId?: string; cwd?: string } = {},
): Promise<string | undefined> {
  const stat = await fs.stat(transcriptPath).catch(() => null);
  if (stat?.isFile() && stat.size > 0) {
    return undefined;
  }
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const header = createSessionTranscriptHeader(params);
  await writeJsonlEntry(transcriptPath, header, {
    mode: 0o600,
    flag: stat?.isFile() ? "w" : "wx",
  });
  return serializeJsonlLine(header);
}

async function resolveTranscriptAppendQueueKey(transcriptPath: string): Promise<string> {
  const resolvedTranscriptPath = path.resolve(transcriptPath);
  const transcriptDir = path.dirname(resolvedTranscriptPath);
  await fs.mkdir(transcriptDir, { recursive: true });
  try {
    return path.join(await fs.realpath(transcriptDir), path.basename(resolvedTranscriptPath));
  } catch {
    return resolvedTranscriptPath;
  }
}

async function withSessionTranscriptAppendQueue<T>(
  transcriptPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const queueKey = await resolveTranscriptAppendQueueKey(transcriptPath);
  // Per-file queue is in-process only; the external session write lock still owns cross-process
  // ordering.
  return await transcriptAppendQueue.enqueue(queueKey, fn);
}

type AppendSessionTranscriptMessageParams<TMessage = unknown> = {
  transcriptPath: string;
  message: TMessage;
  now?: number;
  sessionId?: string;
  cwd?: string;
  useRawWhenLinear?: boolean;
  /** Opt into transcript idempotency lookup; default append stays O(1) for fresh keyed messages. */
  idempotencyLookup?: "scan" | "caller-checked";
  /** Runs under the transcript write lock after idempotency replay checks and before append. */
  prepareMessageAfterIdempotencyCheck?: (message: TMessage) => TMessage | undefined;
  config?: OpenClawConfig;
  /** Internal owned-batch hook for publishing a newly created transcript header. */
  onHeaderCreated?: (serializedHeader: string) => void;
};

type AppendSessionTranscriptMessageResult<TMessage> = {
  messageId: string;
  message: TMessage;
  appended: boolean;
};

function isTranscriptAgentMessage(value: unknown): value is AgentMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { role?: unknown }).role === "string"
  );
}

export async function appendSessionTranscriptMessage<TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage> & {
    prepareMessageAfterIdempotencyCheck: (message: TMessage) => TMessage | undefined;
  },
): Promise<AppendSessionTranscriptMessageResult<TMessage> | undefined>;
export async function appendSessionTranscriptMessage<TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage>,
): Promise<AppendSessionTranscriptMessageResult<TMessage>>;
export async function appendSessionTranscriptMessage<TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage>,
): Promise<AppendSessionTranscriptMessageResult<TMessage> | undefined> {
  return await withSessionTranscriptAppendQueue(params.transcriptPath, () =>
    withSessionTranscriptWriteLock(params, () => appendSessionTranscriptMessageLocked(params)),
  );
}

type AppendSessionTranscriptEventParams = {
  config?: OpenClawConfig;
  event: unknown;
  transcriptPath: string;
};

/** Appends a raw transcript event using the same write lock and FIFO as message appends. */
export async function appendSessionTranscriptEvent(
  params: AppendSessionTranscriptEventParams,
): Promise<void> {
  await withSessionTranscriptAppendQueue(params.transcriptPath, () =>
    withSessionTranscriptWriteLock(params, () => appendSessionTranscriptEventLocked(params)),
  );
}

async function withSessionTranscriptWriteLock<T>(
  params: Pick<AppendSessionTranscriptMessageParams, "transcriptPath" | "config">,
  run: () => Promise<T> | T,
): Promise<T> {
  const lock = await acquireSessionWriteLock({
    sessionFile: params.transcriptPath,
    ...resolveSessionWriteLockOptions(params.config),
    allowReentrant: true,
  });
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

async function appendSessionTranscriptEventLocked(
  params: AppendSessionTranscriptEventParams,
): Promise<{ serializedEntry: string }> {
  await fs.mkdir(path.dirname(params.transcriptPath), { recursive: true });
  const serializedEvent = serializeJsonlEntry(params.event);
  await appendSerializedJsonlEntry(params.transcriptPath, serializedEvent);
  return { serializedEntry: serializedEvent.slice(0, -1) };
}

async function appendSessionTranscriptMessageLocked<TMessage>(
  params: AppendSessionTranscriptMessageParams<TMessage>,
): Promise<AppendSessionTranscriptMessageResult<TMessage> | undefined> {
  const now = params.now ?? Date.now();
  const serializedHeader = await ensureTranscriptHeader(params.transcriptPath, {
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
  });
  if (serializedHeader) {
    params.onHeaderCreated?.(serializedHeader);
  }
  const idempotencyKey = readMessageIdempotencyKey(params.message);
  const existing =
    idempotencyKey && params.idempotencyLookup === "scan"
      ? await findTranscriptMessageByIdempotencyKey(params.transcriptPath, idempotencyKey)
      : undefined;
  if (existing) {
    return { ...existing, message: existing.message as TMessage, appended: false };
  }

  const message = params.prepareMessageAfterIdempotencyCheck
    ? params.prepareMessageAfterIdempotencyCheck(params.message)
    : params.message;
  if (message === undefined) {
    return undefined;
  }

  const messageId = randomUUID();
  const stat = await fs.stat(params.transcriptPath).catch(() => null);
  let leafInfo: TranscriptLeafInfo = await readTranscriptLeafInfo(params.transcriptPath).catch(
    () => ({
      hasParentLinkedEntries: false,
      nonSessionEntryCount: 0,
      appendMode: "active",
    }),
  );
  const hasLinearEntries = !leafInfo.hasParentLinkedEntries && leafInfo.nonSessionEntryCount > 0;
  const allowRawWhenLinear = params.useRawWhenLinear !== false;
  const shouldRawAppend =
    allowRawWhenLinear && hasLinearEntries && (stat?.size ?? 0) > SESSION_MANAGER_APPEND_MAX_BYTES;
  if (hasLinearEntries && !shouldRawAppend) {
    const migrated = await migrateLinearTranscriptToParentLinked(params.transcriptPath);
    leafInfo = {
      ...(migrated.leafId ? { leafId: migrated.leafId } : {}),
      appendMode: "active",
      hasParentLinkedEntries: Boolean(migrated.leafId),
      nonSessionEntryCount: leafInfo.nonSessionEntryCount,
    };
  }
  const finalMessage = (
    isTranscriptAgentMessage(message)
      ? redactTranscriptMessage(message, params.config)
      : redactSecrets(message)
  ) as TMessage;
  const entry = {
    type: "message",
    id: messageId,
    ...(shouldRawAppend ? {} : { parentId: leafInfo.leafId ?? null }),
    timestamp: resolveTimestampMsToIsoString(now),
    message: finalMessage,
    ...(leafInfo.appendMode === "side" && isTranscriptOnlyOpenClawAssistantMessage(finalMessage)
      ? { appendMode: "side" as const }
      : {}),
  };
  await appendJsonlEntry(params.transcriptPath, entry);
  return { messageId, message: finalMessage, appended: true };
}

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function findTranscriptMessageByIdempotencyKey(
  transcriptPath: string,
  idempotencyKey: string,
): Promise<{ messageId: string; message: unknown } | undefined> {
  for await (const line of streamSessionTranscriptLinesReverse(transcriptPath)) {
    try {
      const parsed = JSON.parse(line) as {
        id?: unknown;
        message?: unknown;
      };
      const message = parsed.message;
      if (readMessageIdempotencyKey(message) !== idempotencyKey) {
        continue;
      }
      return {
        messageId:
          typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id : idempotencyKey,
        message,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}
