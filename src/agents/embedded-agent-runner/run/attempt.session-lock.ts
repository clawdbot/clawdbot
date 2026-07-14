/**
 * Coordinates embedded-attempt session ownership, takeover, and prompt locks.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { type BigIntStats, readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { parseSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import {
  type OwnedSessionTranscriptPublishedEntry,
  type OwnedSessionTranscriptWriteOptions,
  type OwnedSessionTranscriptCacheSnapshot,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { toErrorObject } from "../../../infra/errors.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../shared/transcript-only-openclaw-assistant.js";
import { isSessionWriteLockAcquireError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import type {
  CustomEntry,
  LabelEntry,
  SessionInfoEntry,
  SessionMessageEntry,
} from "../../sessions/session-manager.js";
import { resolveEmbeddedSessionFileKey } from "../session-file-key.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;
type PhysicalWriteLockScope = {
  active: boolean;
  completion: Promise<void>;
  pendingOperations: Set<Promise<void>>;
};
type ActiveWriteLockState =
  | {
      active: boolean;
      scope: PhysicalWriteLockScope;
      publishingOwnedWrite: false;
    }
  | {
      active: boolean;
      scope: PhysicalWriteLockScope;
      publishingOwnedWrite: true;
      acceptingNestedPublications: boolean;
      pendingNestedPublications: Set<Promise<void>>;
      publishedEntries?: OwnedSessionTranscriptPublishedEntry[];
    };
type RootWriteLockState = Extract<ActiveWriteLockState, { publishingOwnedWrite: false }>;

function createActiveWriteLockScope(): {
  state: RootWriteLockState;
  complete: () => void;
} {
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    state: {
      active: true,
      scope: {
        active: true,
        completion,
        pendingOperations: new Set(),
      },
      publishingOwnedWrite: false,
    },
    complete,
  };
}

function trackWriteLockOperation<T>(
  scope: PhysicalWriteLockScope,
  operation: Promise<T>,
  additionalSet?: Set<Promise<void>>,
): Promise<T> {
  const settlement = operation.then(
    () => undefined,
    () => undefined,
  );
  scope.pendingOperations.add(settlement);
  additionalSet?.add(settlement);
  void settlement.finally(() => {
    scope.pendingOperations.delete(settlement);
    additionalSet?.delete(settlement);
  });
  return operation;
}

async function drainWriteLockScope(scope: PhysicalWriteLockScope): Promise<void> {
  while (scope.pendingOperations.size > 0) {
    await Promise.all(scope.pendingOperations);
  }
}

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionFileWriteAppendValidator<T> = (result: T, appendedText: string) => boolean;

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

type TrustedSessionFileSnapshot = Extract<SessionFileFingerprint, { exists: true }>;

const MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES = 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES =
  MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES + MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES;
const MAX_BENIGN_SESSION_FENCE_CONTENT_DIGEST_BYTES = 32 * 1024 * 1024;
const MAX_SAFE_FILE_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

type SessionFileFenceSnapshot = {
  fingerprint: SessionFileFingerprint;
  bytes?: Buffer;
  digest?: string;
};

type SessionFileHandle = Awaited<ReturnType<typeof fs.open>>;

function sessionFileFingerprintFromStat(stat: BigIntStats): SessionFileFingerprint {
  return {
    exists: true,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameSessionFileFingerprint(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  if (!left || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameSessionFileIdentity(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  return Boolean(left?.exists && right.exists && left.dev === right.dev && left.ino === right.ino);
}

function sameSessionFileIdentityAndSize(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  return Boolean(
    left?.exists &&
    right.exists &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size,
  );
}

function splitSessionFileLines(text: string): string[] {
  return normalizeStringEntries(text.split(/\r?\n/));
}

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

type PromptReleasedSessionEntry =
  | SessionMessageEntry
  | PromptReleasedSessionMetadataEntry
  | PromptReleasedOpaqueEntry;

type PromptReleasedSessionMergeResult = {
  sessionFileSnapshot?: OwnedSessionTranscriptCacheSnapshot;
  publishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
  requiresReload?: true;
};

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

type PromptReleasedSessionChange =
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

function classifyPromptReleasedSessionLines(
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

function haveSamePublishedEntries(
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

function lineMatchesLinearTranscriptMigration(params: {
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

async function readAppendedSessionFileText(params: {
  sessionFile: string;
  previous: Extract<SessionFileFingerprint, { exists: true }>;
  current: Extract<SessionFileFingerprint, { exists: true }>;
  maxBytes?: number;
}): Promise<string | undefined> {
  if (params.current.size <= params.previous.size || params.previous.size > MAX_SAFE_FILE_OFFSET) {
    return undefined;
  }
  const appendedBytes = params.current.size - params.previous.size;
  if (
    (params.maxBytes !== undefined && appendedBytes > BigInt(params.maxBytes)) ||
    appendedBytes > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  const length = Number(appendedBytes);
  const buffer = Buffer.alloc(length);
  const file = await fs.open(params.sessionFile, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, length, Number(params.previous.size));
    if (bytesRead !== length) {
      return undefined;
    }
  } finally {
    await file.close();
  }
  return buffer.toString("utf8");
}

async function readSessionFileFenceSnapshot(
  sessionFile: string,
): Promise<SessionFileFenceSnapshot> {
  const fingerprint = await readSessionFileFingerprint(sessionFile);
  if (!fingerprint.exists) {
    return { fingerprint };
  }
  if (fingerprint.size > BigInt(MAX_BENIGN_SESSION_FENCE_CONTENT_DIGEST_BYTES)) {
    return { fingerprint };
  }
  let file: SessionFileHandle;
  try {
    file = await fs.open(sessionFile, "r");
  } catch {
    return { fingerprint };
  }
  try {
    const openedFingerprint = sessionFileFingerprintFromStat(await file.stat({ bigint: true }));
    if (!sameSessionFileIdentityAndSize(fingerprint, openedFingerprint)) {
      return { fingerprint: await readSessionFileFingerprint(sessionFile) };
    }

    let bytes: Buffer | undefined;
    let digest: string | undefined;
    if (
      fingerprint.size <= BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES) &&
      fingerprint.size <= MAX_SAFE_FILE_OFFSET
    ) {
      bytes = await readSessionFileBytes(file, Number(fingerprint.size));
    } else if (fingerprint.size <= BigInt(MAX_BENIGN_SESSION_FENCE_CONTENT_DIGEST_BYTES)) {
      digest = await readSessionFileDigest(file, Number(fingerprint.size));
    }

    const postReadFingerprint = sessionFileFingerprintFromStat(await file.stat({ bigint: true }));
    const resolvedFingerprint = await readSessionFileFingerprint(sessionFile);
    if (
      !sameSessionFileIdentityAndSize(openedFingerprint, postReadFingerprint) ||
      !sameSessionFileFingerprint(fingerprint, resolvedFingerprint) ||
      !sameSessionFileIdentityAndSize(postReadFingerprint, resolvedFingerprint)
    ) {
      return { fingerprint: resolvedFingerprint };
    }
    return {
      fingerprint: resolvedFingerprint,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(digest !== undefined ? { digest } : {}),
    };
  } catch {
    return { fingerprint: await readSessionFileFingerprint(sessionFile) };
  } finally {
    await file.close();
  }
}

async function readSessionFileBytes(
  file: SessionFileHandle,
  length: number,
): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, offset);
    if (bytesRead === 0) {
      return undefined;
    }
    offset += bytesRead;
  }
  return buffer;
}

async function readSessionFileDigest(
  file: SessionFileHandle,
  length: number,
): Promise<string | undefined> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(length, 64 * 1024));
  let offset = 0;
  while (offset < length) {
    const nextLength = Math.min(buffer.length, length - offset);
    const { bytesRead } = await file.read(buffer, 0, nextLength, offset);
    if (bytesRead === 0) {
      return undefined;
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function classifySessionFenceAdvance(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  allowAnyMessage?: boolean;
  expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current)
  ) {
    return undefined;
  }
  const text = await readAppendedSessionFileText({
    sessionFile: params.sessionFile,
    previous: params.previous.fingerprint,
    current: params.current,
    // Exact IDs come from the lock owner. Replaying the persisted entry needs
    // its full payload, so only unowned benign classification uses the size cap.
    ...(params.allowAnyMessage ? {} : { maxBytes: MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES }),
  });
  if (!text?.endsWith("\n")) {
    return undefined;
  }
  const lines = normalizeStringEntries(text.split("\n"));
  return classifyPromptReleasedSessionLines(lines, params);
}

async function classifyOwnedSessionFileInitialization(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  expectedPublishedEntries: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.current.exists ||
    (params.previous?.fingerprint.exists === true && params.previous.fingerprint.size > 0n) ||
    params.current.size > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  let text: string;
  try {
    text = await fs.readFile(params.sessionFile, "utf8");
  } catch {
    return undefined;
  }
  if (!text.endsWith("\n")) {
    return undefined;
  }
  const lines = normalizeStringEntries(text.split("\n"));
  const expectedHeader = params.expectedPublishedEntries.find((entry) => entry.kind === "header");
  if (expectedHeader) {
    if (lines[0] !== expectedHeader.serialized) {
      return undefined;
    }
    lines.shift();
  }
  const remainingExpectedEntries = expectedHeader
    ? params.expectedPublishedEntries.filter((entry) => entry !== expectedHeader)
    : params.expectedPublishedEntries;
  const change = classifyPromptReleasedSessionLines(lines, {
    allowAnyMessage: true,
    expectedPublishedEntries: remainingExpectedEntries,
  });
  if (!change && lines.length > 0) {
    return undefined;
  }
  const resolvedChange =
    change ??
    ({
      kind: "transcript-only",
      entries: [],
      publishedEntries: [],
    } satisfies PromptReleasedSessionChange);
  return expectedHeader
    ? {
        ...resolvedChange,
        publishedEntries: [expectedHeader, ...resolvedChange.publishedEntries],
      }
    : resolvedChange;
}

async function readByteIdenticalSessionFenceSnapshot(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
}): Promise<SessionFileFenceSnapshot | undefined> {
  const previous = params.previous;
  if (
    previous?.fingerprint.exists !== true ||
    !params.current.exists ||
    !sameSessionFileIdentityAndSize(previous.fingerprint, params.current)
  ) {
    return undefined;
  }
  const verified = await readSessionFileFenceSnapshot(params.sessionFile);
  if (!sameSessionFileIdentityAndSize(params.current, verified.fingerprint)) {
    return undefined;
  }
  // Truncate-and-rewrite keeps inode and size while advancing timestamps.
  // Install only the stable snapshot whose exact bytes were compared here.
  if (previous.bytes !== undefined && verified.bytes !== undefined) {
    return previous.bytes.equals(verified.bytes) ? verified : undefined;
  }
  return previous.digest !== undefined && previous.digest === verified.digest
    ? verified
    : undefined;
}

async function classifySessionFenceRewrite(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  allowAnyMessage?: boolean;
  expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    params.previous.bytes === undefined ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current) ||
    (!params.allowAnyMessage &&
      params.current.size > BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES)) ||
    params.current.size > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  let currentText: string;
  try {
    currentText = await fs.readFile(params.sessionFile, "utf8");
  } catch {
    return undefined;
  }
  if (!currentText.endsWith("\n")) {
    return undefined;
  }
  const previousLines = splitSessionFileLines(params.previous.bytes.toString("utf8"));
  const currentLines = splitSessionFileLines(currentText);
  if (currentLines.length <= previousLines.length) {
    return undefined;
  }
  let expectedParentId: string | null = null;
  for (let index = 0; index < previousLines.length; index += 1) {
    const lineMatch = lineMatchesLinearTranscriptMigration({
      previousLine: previousLines[index] ?? "",
      currentLine: currentLines[index] ?? "",
      expectedParentId,
    });
    if (!lineMatch.ok) {
      return undefined;
    }
    expectedParentId = lineMatch.nextPreviousId ?? expectedParentId;
  }
  const appendedLines = currentLines.slice(previousLines.length);
  return classifyPromptReleasedSessionLines(appendedLines, {
    ...params,
    initialParentId: expectedParentId,
  });
}

async function classifySessionFenceChange(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  const allowAnyMessage = params.expectedPublishedEntries !== undefined;
  return (
    (params.expectedPublishedEntries
      ? await classifyOwnedSessionFileInitialization({
          ...params,
          expectedPublishedEntries: params.expectedPublishedEntries,
        })
      : undefined) ??
    (await classifySessionFenceAdvance({ ...params, allowAnyMessage })) ??
    (await classifySessionFenceRewrite({ ...params, allowAnyMessage }))
  );
}

type OwnedSessionFileWrite = {
  generation: number;
  fingerprint: SessionFileFingerprint;
  publishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
  requiresReload?: true;
};

type OwnedSessionFileWriteHistory = {
  activeFenceGenerations: Map<symbol, number>;
  writes: OwnedSessionFileWrite[];
};

type TrustedSessionFileState = {
  generation: number;
  fingerprint: SessionFileFingerprint;
};

// Controllers in the same OpenClaw process can legitimately take turns writing
// the same session file while another attempt is released for model I/O. Track
// only fingerprints that changed while OpenClaw held the write lock so the
// takeover fence can distinguish those locked in-process writes from unowned
// external file changes.
const ownedSessionFileWrites = new Map<string, OwnedSessionFileWriteHistory>();
const trustedSessionFileStates = new Map<string, TrustedSessionFileState>();
let ownedSessionFileWriteGeneration = 0;

function resolveSessionFileFenceKey(sessionFile: string): string {
  return resolveEmbeddedSessionFileKey(sessionFile);
}

type SessionFileOwnerWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
};

type SessionFileOwnerEntry = {
  ownerId: symbol;
  waiters: Set<SessionFileOwnerWaiter>;
};

type SessionFileOwnerState = {
  owners: Map<string, SessionFileOwnerEntry>;
};

const EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY = Symbol.for(
  "openclaw.embeddedAttemptSessionFileOwnerState",
);

const sessionFileOwnerState = resolveGlobalSingleton(
  EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY,
  (): SessionFileOwnerState => ({
    owners: new Map<string, SessionFileOwnerEntry>(),
  }),
);

export type EmbeddedAttemptSessionFileOwner = {
  sessionFileKey: string;
  release(): void;
};

class EmbeddedAttemptSessionFileOwnerTimeoutError extends Error {
  constructor(sessionFile: string, timeoutMs: number) {
    super(`timed out waiting for embedded session file owner after ${timeoutMs}ms: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionFileOwnerTimeoutError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

function abortOwnerWaitReason(signal: AbortSignal): unknown {
  return abortReason(signal) ?? new Error("operation aborted", { cause: signal });
}

function resolveSessionFileOwnerWaitTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  return clampTimerTimeoutMs(timeoutMs);
}

function waitForSessionFileOwnerRelease(params: {
  sessionFile: string;
  entry: SessionFileOwnerEntry;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    return Promise.reject(
      toErrorObject(abortOwnerWaitReason(params.signal), "Non-Error rejection"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: SessionFileOwnerWaiter = {
      resolve,
      reject,
      signal: params.signal,
    };
    const cleanup = () => {
      params.entry.waiters.delete(waiter);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
    };
    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error) => {
      cleanup();
      reject(toErrorObject(error, "Non-Error rejection"));
    };
    const timeoutMs = resolveSessionFileOwnerWaitTimeoutMs(params.timeoutMs);
    if (timeoutMs !== undefined) {
      waiter.timer = setTimeout(() => {
        waiter.reject(
          new EmbeddedAttemptSessionFileOwnerTimeoutError(params.sessionFile, timeoutMs),
        );
      }, timeoutMs);
      waiter.timer.unref?.();
    }
    if (params.signal) {
      waiter.abortListener = () => {
        waiter.reject(abortOwnerWaitReason(params.signal!));
      };
      params.signal.addEventListener("abort", waiter.abortListener, { once: true });
    }
    params.entry.waiters.add(waiter);
  });
}

export async function acquireEmbeddedAttemptSessionFileOwner(params: {
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EmbeddedAttemptSessionFileOwner> {
  const sessionFileKey = resolveEmbeddedSessionFileKey(params.sessionFile);
  const ownerId = Symbol(sessionFileKey);
  while (true) {
    if (params.signal?.aborted) {
      throw abortOwnerWaitReason(params.signal);
    }
    const entry = sessionFileOwnerState.owners.get(sessionFileKey);
    if (!entry) {
      sessionFileOwnerState.owners.set(sessionFileKey, {
        ownerId,
        waiters: new Set(),
      });
      return {
        sessionFileKey,
        release() {
          const current = sessionFileOwnerState.owners.get(sessionFileKey);
          if (!current || current.ownerId !== ownerId) {
            return;
          }
          sessionFileOwnerState.owners.delete(sessionFileKey);
          for (const waiter of current.waiters) {
            waiter.resolve();
          }
        },
      };
    }
    await waitForSessionFileOwnerRelease({
      sessionFile: params.sessionFile,
      entry,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  }
}

export function resetEmbeddedAttemptSessionFileOwnersForTest(): void {
  for (const entry of sessionFileOwnerState.owners.values()) {
    for (const waiter of entry.waiters) {
      waiter.reject(
        new Error("embedded attempt session file owners reset", {
          cause: "resetEmbeddedAttemptSessionFileOwnersForTest",
        }),
      );
    }
  }
  sessionFileOwnerState.owners.clear();
  ownedSessionFileWrites.clear();
  trustedSessionFileStates.clear();
  ownedSessionFileWriteGeneration = 0;
}

function resolveOwnedSessionFileWriteHistory(sessionFileKey: string): OwnedSessionFileWriteHistory {
  const existing = ownedSessionFileWrites.get(sessionFileKey);
  if (existing) {
    return existing;
  }
  const created = {
    activeFenceGenerations: new Map<symbol, number>(),
    writes: [],
  };
  ownedSessionFileWrites.set(sessionFileKey, created);
  return created;
}

function pruneOwnedSessionFileWriteHistory(
  sessionFileKey: string,
  history: OwnedSessionFileWriteHistory,
): void {
  if (history.activeFenceGenerations.size === 0) {
    ownedSessionFileWrites.delete(sessionFileKey);
    return;
  }
  const oldestFenceGeneration = Math.min(...history.activeFenceGenerations.values());
  history.writes = history.writes.filter((write) => write.generation > oldestFenceGeneration);
}

function recordOwnedSessionFileWrite(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
  publishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[],
  requiresReload?: true,
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
    ...(publishedEntries ? { publishedEntries: [...publishedEntries] } : {}),
    ...(requiresReload ? { requiresReload } : {}),
  };
  const history = resolveOwnedSessionFileWriteHistory(sessionFileKey);
  history.writes.push(state);
  pruneOwnedSessionFileWriteHistory(sessionFileKey, history);
  trustedSessionFileStates.set(sessionFileKey, state);
  return ownedSessionFileWriteGeneration;
}

function recordTrustedSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  };
  trustedSessionFileStates.set(sessionFileKey, state);
  return ownedSessionFileWriteGeneration;
}

function trustSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number | undefined {
  const trusted = trustedSessionFileStates.get(sessionFileKey);
  if (trusted) {
    return sameSessionFileFingerprint(trusted.fingerprint, fingerprint)
      ? trusted.generation
      : undefined;
  }
  ownedSessionFileWriteGeneration += 1;
  trustedSessionFileStates.set(sessionFileKey, {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  });
  return ownedSessionFileWriteGeneration;
}

function isTrustedSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): boolean {
  const trusted = trustedSessionFileStates.get(sessionFileKey);
  return trusted !== undefined && sameSessionFileFingerprint(trusted.fingerprint, fingerprint);
}

async function readSessionFileFingerprint(sessionFile: string): Promise<SessionFileFingerprint> {
  if (parseSqliteSessionFileMarker(sessionFile)) {
    return { exists: false };
  }
  try {
    return sessionFileFingerprintFromStat(await fs.stat(sessionFile, { bigint: true }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

function readSessionFileFingerprintSync(sessionFile: string): SessionFileFingerprint {
  if (parseSqliteSessionFileMarker(sessionFile)) {
    return { exists: false };
  }
  try {
    return sessionFileFingerprintFromStat(statSync(sessionFile, { bigint: true }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function waitForSessionEventQueue(_session: unknown): Promise<void> {}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export type EmbeddedAttemptSessionLockController = {
  canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  readTrustedCurrentSessionFileSnapshot(): Promise<TrustedSessionFileSnapshot | undefined>;
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  withOwnedSessionFileWrite<T>(
    run: () => T,
    validateAppend?: SessionFileWriteAppendValidator<T>,
  ): T;
  reacquireAfterPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  initialAcquireSignal?: AbortSignal;
  lockOptions: LockOptions;
  mergePromptReleasedSessionEntries?: (
    entries: readonly PromptReleasedSessionEntry[],
  ) => Promise<PromptReleasedSessionMergeResult | void> | PromptReleasedSessionMergeResult | void;
  reloadPromptReleasedSessionFile?: () => Promise<void> | void;
}): Promise<EmbeddedAttemptSessionLockController> {
  const acquireLock = async (signal?: AbortSignal): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
      ...(signal ? { signal } : {}),
    });

  let heldLock: SessionLock | undefined = await acquireLock(params.initialAcquireSignal);
  const activeWriteLock = new AsyncLocalStorage<ActiveWriteLockState>();
  let ownedPublicationQueue: Promise<void> = Promise.resolve();
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceSnapshot: SessionFileFenceSnapshot | undefined;
  let fenceGeneration = 0;
  let fenceActive = false;
  let takeoverDetected = false;
  // An aborted prompt can settle after attempt teardown. Never let its finally
  // path reacquire a retained lock that no owner remains to release.
  let disposed = false;
  // Prompt-finally reacquisition can overlap attempt cleanup. Serialize that
  // ownership handoff so cleanup adopts an in-flight reacquire, and skip any
  // later reacquire once cleanup has begun or it could orphan a retained lock.
  let lockLifecycle: Promise<void> = Promise.resolve();
  let cleanupStarted = false;
  // Set when an active retained write prevents immediate held-lock release.
  // The scope completion path retries release after the retained use unwinds.
  let releaseHeldLockDeferred = false;
  let retainedLockUseCount = 0;
  const retainedLockIdleWaiters = new Set<() => void>();
  let heldLockDraining = false;
  let heldLockDrainOwner: symbol | undefined;
  const heldLockDrainWaiters = new Set<() => void>();
  const sessionFileFenceKey = resolveSessionFileFenceKey(params.lockOptions.sessionFile);
  const controllerFenceId = Symbol(sessionFileFenceKey);

  function runLockLifecycle<T>(run: () => Promise<T>): Promise<T> {
    const operation = lockLifecycle.then(run);
    lockLifecycle = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function setFenceGeneration(generation: number): void {
    fenceGeneration = generation;
    if (!fenceActive) {
      return;
    }
    const history = resolveOwnedSessionFileWriteHistory(sessionFileFenceKey);
    history.activeFenceGenerations.set(controllerFenceId, generation);
    pruneOwnedSessionFileWriteHistory(sessionFileFenceKey, history);
  }

  function activateFence(generation: number): void {
    fenceActive = true;
    setFenceGeneration(generation);
  }

  function deactivateFence(): void {
    if (!fenceActive) {
      return;
    }
    fenceActive = false;
    const history = ownedSessionFileWrites.get(sessionFileFenceKey);
    if (!history) {
      return;
    }
    history.activeFenceGenerations.delete(controllerFenceId);
    pruneOwnedSessionFileWriteHistory(sessionFileFenceKey, history);
  }

  async function mergePromptReleasedSessionChange(
    previous: SessionFileFenceSnapshot | undefined,
    current: SessionFileFingerprint,
    options?: {
      expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
    },
  ): Promise<
    | {
        snapshot: SessionFileFenceSnapshot;
        publishedEntries?: OwnedSessionTranscriptPublishedEntry[];
        postMergePublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
        requiresReload?: true;
      }
    | undefined
  > {
    if (!params.mergePromptReleasedSessionEntries) {
      return undefined;
    }
    const change = await classifySessionFenceChange({
      sessionFile: params.lockOptions.sessionFile,
      previous,
      current,
      expectedPublishedEntries: options?.expectedPublishedEntries,
    });
    if (!change) {
      return undefined;
    }
    if (
      options?.expectedPublishedEntries &&
      !haveSamePublishedEntries(change.publishedEntries, options.expectedPublishedEntries)
    ) {
      return undefined;
    }
    let mergeResult: PromptReleasedSessionMergeResult | void;
    try {
      mergeResult = await params.mergePromptReleasedSessionEntries(change.entries);
    } catch (error) {
      takeoverDetected = true;
      throw error;
    }
    const refreshedSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
    const expectedFingerprint = mergeResult?.sessionFileSnapshot
      ? { exists: true as const, ...mergeResult.sessionFileSnapshot }
      : current;
    if (!sameSessionFileFingerprint(expectedFingerprint, refreshedSnapshot.fingerprint)) {
      takeoverDetected = true;
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    return {
      snapshot: refreshedSnapshot,
      publishedEntries: mergeResult?.requiresReload
        ? undefined
        : mergeResult?.publishedEntries
          ? [...change.publishedEntries, ...mergeResult.publishedEntries]
          : change.publishedEntries,
      ...(mergeResult?.publishedEntries
        ? { postMergePublishedEntries: mergeResult.publishedEntries }
        : {}),
      ...(mergeResult?.requiresReload ? { requiresReload: true as const } : {}),
    };
  }

  async function reloadPromptReleasedSessionFile(
    expectedFingerprint: SessionFileFingerprint,
  ): Promise<SessionFileFenceSnapshot | undefined> {
    if (!params.reloadPromptReleasedSessionFile) {
      return undefined;
    }
    try {
      await params.reloadPromptReleasedSessionFile();
    } catch (error) {
      takeoverDetected = true;
      throw error;
    }
    const snapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
    if (!sameSessionFileFingerprint(expectedFingerprint, snapshot.fingerprint)) {
      takeoverDetected = true;
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    return snapshot;
  }

  function beginRetainedLockUse(): () => void {
    retainedLockUseCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      retainedLockUseCount -= 1;
      if (retainedLockUseCount === 0 && retainedLockIdleWaiters.size > 0) {
        const waiters = Array.from(retainedLockIdleWaiters);
        retainedLockIdleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
  }

  async function waitForRetainedLockIdle(): Promise<boolean> {
    if (retainedLockUseCount === 0) {
      return true;
    }
    if (activeWriteLock.getStore()?.scope.active === true) {
      return false;
    }
    await new Promise<void>((resolve) => {
      retainedLockIdleWaiters.add(resolve);
    });
    return true;
  }

  async function acquireWriteLock(): Promise<{
    lock: SessionLock;
    owned: boolean;
    releaseRetainedUse?: () => void;
  }> {
    await waitForHeldLockDrain();
    if (heldLock) {
      return { lock: heldLock, owned: false, releaseRetainedUse: beginRetainedLockUse() };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        takeoverDetected = true;
      }
      throw err;
    }
  }

  async function waitForHeldLockDrain(): Promise<void> {
    for (;;) {
      if (!heldLockDraining) {
        return;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  async function beginHeldLockDrain(): Promise<symbol> {
    for (;;) {
      if (!heldLockDraining) {
        const owner = Symbol("held-lock-drain");
        heldLockDraining = true;
        heldLockDrainOwner = owner;
        return owner;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  function finishHeldLockDrain(owner: symbol): void {
    if (!heldLockDraining || heldLockDrainOwner !== owner) {
      return;
    }
    heldLockDraining = false;
    heldLockDrainOwner = undefined;
    if (heldLockDrainWaiters.size === 0) {
      return;
    }
    const waiters = Array.from(heldLockDrainWaiters);
    heldLockDrainWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  async function assertSessionFileFence(): Promise<void> {
    if (!fenceActive) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(fenceFingerprint, current)) {
      return;
    }

    const ownedWriteHistory = ownedSessionFileWrites.get(sessionFileFenceKey)?.writes ?? [];
    const ownedWrite = ownedWriteHistory.at(-1);
    if (
      ownedWrite &&
      ownedWrite.generation > fenceGeneration &&
      sameSessionFileFingerprint(ownedWrite.fingerprint, current)
    ) {
      const unseenOwnedWrites = ownedWriteHistory.filter(
        (write) => write.generation > fenceGeneration,
      );
      if (unseenOwnedWrites.some((write) => write.requiresReload)) {
        const reloadedSnapshot = await reloadPromptReleasedSessionFile(current);
        if (!reloadedSnapshot) {
          takeoverDetected = true;
          throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
        }
        fenceFingerprint = reloadedSnapshot.fingerprint;
        fenceSnapshot = reloadedSnapshot;
        setFenceGeneration(ownedWrite.generation);
        return;
      }
      const canValidateExactEntries = unseenOwnedWrites.every(
        (write) => write.publishedEntries !== undefined,
      );
      const expectedPublishedEntries = canValidateExactEntries
        ? unseenOwnedWrites.flatMap((write) => write.publishedEntries ?? [])
        : undefined;
      const mergedChange = await mergePromptReleasedSessionChange(
        fenceSnapshot,
        current,
        expectedPublishedEntries ? { expectedPublishedEntries } : undefined,
      );
      if (params.mergePromptReleasedSessionEntries && !mergedChange) {
        takeoverDetected = true;
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      const mergedFingerprint = mergedChange?.snapshot.fingerprint ?? current;
      const mergedGeneration =
        mergedChange && !sameSessionFileFingerprint(current, mergedFingerprint)
          ? recordOwnedSessionFileWrite(
              sessionFileFenceKey,
              mergedFingerprint,
              mergedChange.postMergePublishedEntries,
              mergedChange.requiresReload,
            )
          : ownedWrite.generation;
      fenceFingerprint = mergedFingerprint;
      fenceSnapshot = mergedChange?.snapshot ?? { fingerprint: current };
      setFenceGeneration(mergedGeneration);
      return;
    }

    const byteIdenticalSnapshot = await readByteIdenticalSessionFenceSnapshot({
      sessionFile: params.lockOptions.sessionFile,
      previous: fenceSnapshot,
      current,
    });
    if (byteIdenticalSnapshot) {
      fenceSnapshot = byteIdenticalSnapshot;
      fenceFingerprint = byteIdenticalSnapshot.fingerprint;
      setFenceGeneration(
        recordTrustedSessionFileState(sessionFileFenceKey, byteIdenticalSnapshot.fingerprint),
      );
      return;
    }

    const changeKind = await classifySessionFenceChange({
      sessionFile: params.lockOptions.sessionFile,
      previous: fenceSnapshot,
      current,
    });
    if (changeKind?.kind === "transcript-only" && !params.mergePromptReleasedSessionEntries) {
      fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
      fenceFingerprint = fenceSnapshot.fingerprint;
      setFenceGeneration(trustSessionFileState(sessionFileFenceKey, current) ?? fenceGeneration);
      return;
    }
    if (changeKind && params.mergePromptReleasedSessionEntries) {
      const mergedChange = await mergePromptReleasedSessionChange(fenceSnapshot, current);
      if (!mergedChange) {
        takeoverDetected = true;
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      fenceSnapshot = mergedChange.snapshot;
      fenceFingerprint = mergedChange.snapshot.fingerprint;
      setFenceGeneration(
        recordOwnedSessionFileWrite(
          sessionFileFenceKey,
          mergedChange.snapshot.fingerprint,
          mergedChange.publishedEntries,
          mergedChange.requiresReload,
        ),
      );
      return;
    }

    takeoverDetected = true;
    throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
  }

  async function refreshSessionFileFence(beforeWrite: SessionFileFingerprint): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const snapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
    if (!sameSessionFileFingerprint(beforeWrite, snapshot.fingerprint) && fenceActive) {
      fenceFingerprint = snapshot.fingerprint;
      fenceSnapshot = snapshot;
    }
  }

  async function captureOwnedSessionFileWriteStart(): Promise<SessionFileFenceSnapshot> {
    const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    const currentFenceSnapshot = fenceSnapshot;
    if (
      currentFenceSnapshot &&
      sameSessionFileFingerprint(currentFenceSnapshot.fingerprint, fingerprint)
    ) {
      return currentFenceSnapshot;
    }
    return { fingerprint };
  }

  async function publishOwnedSessionFileFence(
    beforeWrite: SessionFileFenceSnapshot,
    expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[],
  ): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(beforeWrite.fingerprint, current)) {
      return;
    }
    const beforeWriteIsTrusted =
      (fenceActive && sameSessionFileFingerprint(fenceFingerprint, beforeWrite.fingerprint)) ||
      isTrustedSessionFileState(sessionFileFenceKey, beforeWrite.fingerprint);
    if (!beforeWriteIsTrusted) {
      return;
    }
    const mergedChange = await mergePromptReleasedSessionChange(
      beforeWrite,
      current,
      expectedPublishedEntries ? { expectedPublishedEntries } : undefined,
    );
    if (params.mergePromptReleasedSessionEntries && !mergedChange) {
      takeoverDetected = true;
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    const publishedEntries = mergedChange
      ? mergedChange.publishedEntries
      : expectedPublishedEntries;
    const publishedFingerprint = mergedChange?.snapshot.fingerprint ?? current;
    const generation = recordOwnedSessionFileWrite(
      sessionFileFenceKey,
      publishedFingerprint,
      publishedEntries,
      mergedChange?.requiresReload,
    );
    if (fenceActive) {
      fenceFingerprint = publishedFingerprint;
      fenceSnapshot =
        mergedChange?.snapshot ??
        (await readSessionFileFenceSnapshot(params.lockOptions.sessionFile));
      setFenceGeneration(generation);
    }
  }

  // Synchronous append paths cannot await withSessionWriteLock. Only publish
  // their post-write fingerprint when the pre-write state was already trusted.
  function publishOwnedSessionFileFenceSync<T>(write: {
    beforeWrite: SessionFileFingerprint;
    result: T;
    beforeText?: string;
    validateAppend?: SessionFileWriteAppendValidator<T>;
  }): void {
    if (takeoverDetected) {
      return;
    }
    const fingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
    const beforeWriteIsTrusted =
      (fenceActive && sameSessionFileFingerprint(fenceFingerprint, write.beforeWrite)) ||
      isTrustedSessionFileState(sessionFileFenceKey, write.beforeWrite);
    if (sameSessionFileFingerprint(write.beforeWrite, fingerprint) || !beforeWriteIsTrusted) {
      return;
    }
    if (write.validateAppend) {
      const afterText = readFileSync(params.lockOptions.sessionFile, "utf8");
      if (
        write.beforeText === undefined ||
        !afterText.startsWith(write.beforeText) ||
        !write.validateAppend(write.result, afterText.slice(write.beforeText.length))
      ) {
        return;
      }
    }
    const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, fingerprint);
    if (fenceActive) {
      fenceFingerprint = fingerprint;
      fenceSnapshot = { fingerprint };
      setFenceGeneration(generation);
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  async function releaseHeldLockWithFence(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        releaseHeldLockDeferred = true;
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      // Clearing `heldLock` transfers release ownership to this block. Fence reads can
      // throw after that transfer; release the underlying file lock anyway so later
      // turns do not wait for the maxHoldMs watchdog.
      try {
        const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
        const ownedWrite = ownedSessionFileWrites.get(sessionFileFenceKey)?.writes.at(-1);
        const trustedGeneration = trustSessionFileState(sessionFileFenceKey, fingerprint);
        fenceFingerprint = fingerprint;
        fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
        const releasedFenceGeneration =
          ownedWrite && sameSessionFileFingerprint(ownedWrite.fingerprint, fingerprint)
            ? ownedWrite.generation
            : (trustedGeneration ?? fenceGeneration);
        activateFence(releasedFenceGeneration);
      } finally {
        await lock.release();
      }
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function takeHeldLockAfterRetainedIdle(): Promise<SessionLock | undefined> {
    if (!heldLock) {
      return undefined;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        // Do not wait for retained idle from inside the active scope; that
        // scope must unwind before the retained-use waiter can resolve.
        return undefined;
      }
      if (!heldLock) {
        return undefined;
      }
      const lock = heldLock;
      heldLock = undefined;
      return lock;
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function disposeHeldLockAfterRetainedIdle(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        // Same active-scope self-deadlock guard as takeHeldLockAfterRetainedIdle.
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      await lock.release();
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function releaseHeldLockAfterTakeover(): Promise<void> {
    if (!takeoverDetected) {
      return;
    }
    await disposeHeldLockAfterRetainedIdle();
  }

  async function acquireCleanupLock(): Promise<SessionLock | undefined> {
    const retainedLock = await takeHeldLockAfterRetainedIdle();
    if (retainedLock) {
      return retainedLock;
    }
    await waitForHeldLockDrain();
    try {
      return await acquireLock();
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        takeoverDetected = true;
        return undefined;
      }
      throw err;
    }
  }

  async function runWithPhysicalWriteLockScope<T>(
    run: () => Promise<T>,
    release: () => Promise<void> | void,
  ): Promise<T> {
    const scope = createActiveWriteLockScope();
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await activeWriteLock.run(scope.state, run) };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      try {
        await drainWriteLockScope(scope.state.scope);
      } finally {
        scope.state.active = false;
        scope.state.scope.active = false;
        try {
          await release();
        } finally {
          scope.complete();
        }
      }
    }
    await releaseHeldLockAfterTakeover();
    // Retained use has been released and the active scope is no longer live,
    // so a prior active-scope release bailout can drain the held file lock now.
    if (releaseHeldLockDeferred) {
      releaseHeldLockDeferred = false;
      await releaseHeldLockWithFence();
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (takeoverDetected) {
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    return outcome.value;
  }

  async function runWithRetainedLock<T>(
    run: () => Promise<T>,
    releaseRetainedUse: () => void,
  ): Promise<T> {
    return await runWithPhysicalWriteLockScope(run, releaseRetainedUse);
  }

  async function runPublishingOwnedSessionFileWrite<T>(
    run: () => Promise<T> | T,
    resolvePublishedEntries?: (result: T) => readonly OwnedSessionTranscriptPublishedEntry[],
    resolvePublishedEntriesAfterFailure?: () => readonly OwnedSessionTranscriptPublishedEntry[],
  ): Promise<T> {
    const parentLockState = activeWriteLock.getStore();
    if (!parentLockState?.active || !parentLockState.scope.active) {
      throw new Error("owned session publication requires an active session write lock");
    }
    if (parentLockState?.publishingOwnedWrite && parentLockState.acceptingNestedPublications) {
      const nestedPublication = (async () => {
        let nestedEntries: readonly OwnedSessionTranscriptPublishedEntry[] | undefined;
        try {
          const result = await run();
          nestedEntries = resolvePublishedEntries?.(result);
          return result;
        } catch (error) {
          nestedEntries = resolvePublishedEntriesAfterFailure?.();
          throw error;
        } finally {
          if (nestedEntries !== undefined) {
            parentLockState.publishedEntries ??= [];
            parentLockState.publishedEntries.push(...nestedEntries);
          }
        }
      })();
      return await trackWriteLockOperation(
        parentLockState.scope,
        nestedPublication,
        parentLockState.pendingNestedPublications,
      );
    }
    const publication = (async () => {
      let releaseQueue!: () => void;
      const currentQueueEntry = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      const previousQueueEntry = ownedPublicationQueue.catch(() => undefined);
      ownedPublicationQueue = previousQueueEntry.then(() => currentQueueEntry);
      await previousQueueEntry;
      try {
        if (takeoverDetected) {
          throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
        }
        const beforeWrite = await captureOwnedSessionFileWriteStart();
        const publicationLockState: ActiveWriteLockState = {
          active: true,
          scope: parentLockState.scope,
          publishingOwnedWrite: true,
          acceptingNestedPublications: true,
          pendingNestedPublications: new Set(),
          publishedEntries: undefined,
        };
        try {
          return await activeWriteLock.run(publicationLockState, async () => {
            let ownEntries: readonly OwnedSessionTranscriptPublishedEntry[] | undefined;
            try {
              const result = await run();
              ownEntries = resolvePublishedEntries?.(result);
              return result;
            } catch (error) {
              ownEntries = resolvePublishedEntriesAfterFailure?.();
              throw error;
            } finally {
              // Nested transcript callbacks inherit this publication owner.
              // Drain them before freezing the expected fence entry set.
              while (publicationLockState.pendingNestedPublications.size > 0) {
                await Promise.all(publicationLockState.pendingNestedPublications);
              }
              publicationLockState.acceptingNestedPublications = false;
              publicationLockState.active = false;
              const nestedEntries = publicationLockState.publishedEntries;
              const expectedPublishedEntries =
                nestedEntries === undefined
                  ? ownEntries
                  : ownEntries === undefined
                    ? nestedEntries
                    : [...nestedEntries, ...ownEntries];
              await publishOwnedSessionFileFence(beforeWrite, expectedPublishedEntries);
            }
          });
        } finally {
          publicationLockState.active = false;
        }
      } finally {
        releaseQueue();
      }
    })();
    return await trackWriteLockOperation(parentLockState.scope, publication);
  }

  async function runInheritedWriteLockOperation<T>(
    state: ActiveWriteLockState,
    run: () => Promise<T> | T,
  ): Promise<T> {
    const operation = (async () => await run())();
    return await trackWriteLockOperation(state.scope, operation);
  }

  async function withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ): Promise<T> {
    if (takeoverDetected) {
      throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
    }
    const inheritedLockState = activeWriteLock.getStore();
    if (inheritedLockState && (!inheritedLockState.active || !inheritedLockState.scope.active)) {
      await inheritedLockState.scope.completion;
      return await activeWriteLock.exit(() => withSessionWriteLock(run, options));
    }
    if (inheritedLockState?.active === true) {
      if (options?.publishOwnedWrite !== true) {
        return await runInheritedWriteLockOperation(inheritedLockState, run);
      }
      return await runPublishingOwnedSessionFileWrite(
        run,
        options.resolvePublishedEntries,
        options.resolvePublishedEntriesAfterFailure,
      );
    }
    const { lock, owned, releaseRetainedUse } = await acquireWriteLock();
    const runLockedOperation = async () => {
      await assertSessionFileFence();
      if (options?.publishOwnedWrite === true) {
        return await runPublishingOwnedSessionFileWrite(
          run,
          options.resolvePublishedEntries,
          options.resolvePublishedEntriesAfterFailure,
        );
      }
      const beforeWrite = await readSessionFileFingerprint(params.lockOptions.sessionFile);
      try {
        return await run();
      } finally {
        await refreshSessionFileFence(beforeWrite);
      }
    };
    if (!owned) {
      return await runWithRetainedLock(runLockedOperation, releaseRetainedUse ?? (() => {}));
    }

    return await runWithPhysicalWriteLockScope(runLockedOperation, () => lock.release());
  }

  return {
    canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      const state = activeWriteLock.getStore();
      if (takeoverDetected || state?.active !== true || !state.scope.active) {
        return false;
      }
      const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
      return (
        (fenceActive && sameSessionFileFingerprint(fenceFingerprint, fingerprint)) ||
        isTrustedSessionFileState(sessionFileFenceKey, fingerprint)
      );
    },
    publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      const state = activeWriteLock.getStore();
      if (takeoverDetected || state?.active !== true || !state.scope.active) {
        return false;
      }
      const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
      const current = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      if (!sameSessionFileFingerprint(fingerprint, current)) {
        return false;
      }
      const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, current);
      if (fenceActive) {
        fenceFingerprint = current;
        fenceSnapshot = { fingerprint: current };
        setFenceGeneration(generation);
      }
      return true;
    },
    publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
      if (takeoverDetected || !heldLock || heldLockDraining) {
        return false;
      }
      const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
      const current = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      if (!sameSessionFileFingerprint(fingerprint, current)) {
        return false;
      }
      setFenceGeneration(recordTrustedSessionFileState(sessionFileFenceKey, current));
      if (fenceActive) {
        fenceFingerprint = current;
        fenceSnapshot = { fingerprint: current };
      }
      return true;
    },
    async readTrustedCurrentSessionFileSnapshot(): Promise<TrustedSessionFileSnapshot | undefined> {
      const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
      return fingerprint.exists && isTrustedSessionFileState(sessionFileFenceKey, fingerprint)
        ? fingerprint
        : undefined;
    },
    async releaseForPrompt(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    async releaseHeldLockForAbort(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    refreshAfterOwnedSessionWrite(): void {
      if (takeoverDetected) {
        return;
      }
      const beforeWrite = fenceFingerprint;
      const fingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      if (!fenceActive) {
        // User-message persistence occurs before the prompt fence activates.
        // The retained session lock owns that write, so publish its exact state
        // for the next attempt before release establishes the active fence.
        setFenceGeneration(recordTrustedSessionFileState(sessionFileFenceKey, fingerprint));
        return;
      }
      if (
        !sameSessionFileFingerprint(beforeWrite, fingerprint) &&
        isTrustedSessionFileState(sessionFileFenceKey, beforeWrite ?? { exists: false })
      ) {
        setFenceGeneration(recordOwnedSessionFileWrite(sessionFileFenceKey, fingerprint));
      }
      fenceFingerprint = fingerprint;
      fenceSnapshot = { fingerprint };
    },
    withOwnedSessionFileWrite<T>(
      run: () => T,
      validateAppend?: SessionFileWriteAppendValidator<T>,
    ): T {
      const beforeWrite = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      const beforeText = validateAppend
        ? readFileSync(params.lockOptions.sessionFile, "utf8")
        : undefined;
      const result = run();
      publishOwnedSessionFileFenceSync({
        beforeWrite,
        result,
        ...(beforeText !== undefined ? { beforeText } : {}),
        ...(validateAppend ? { validateAppend } : {}),
      });
      return result;
    },
    async reacquireAfterPrompt(): Promise<void> {
      if (cleanupStarted) {
        return;
      }
      await runLockLifecycle(async () => {
        await waitForHeldLockDrain();
        if (disposed || takeoverDetected || heldLock) {
          return;
        }
        let lock: SessionLock;
        try {
          lock = await acquireLock();
        } catch (err) {
          if (isSessionWriteLockAcquireError(err)) {
            takeoverDetected = true;
          }
          throw err;
        }
        if (disposed) {
          await lock.release();
          return;
        }
        try {
          heldLock = lock;
          await assertSessionFileFence();
        } catch (err) {
          heldLock = undefined;
          await lock.release();
          throw err;
        }
      });
    },
    waitForSessionEvents: waitForSessionEventQueue,
    withSessionWriteLock,
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      cleanupStarted = true;
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session);
      }
      return await runLockLifecycle(async () => {
        if (takeoverDetected) {
          return noopLock;
        }
        const cleanupLock = await acquireCleanupLock();
        if (!cleanupLock) {
          return noopLock;
        }
        try {
          await assertSessionFileFence();
        } catch (err) {
          await cleanupLock.release();
          if (err instanceof EmbeddedAttemptSessionTakeoverError) {
            return noopLock;
          }
          throw err;
        }
        return cleanupLock;
      });
    },
    hasSessionTakeover(): boolean {
      return takeoverDetected;
    },
    async dispose(): Promise<void> {
      disposed = true;
      try {
        await disposeHeldLockAfterRetainedIdle();
      } finally {
        deactivateFence();
      }
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
  sessionFile?: string;
  sessionKey?: string;
  withSessionWriteLock?: <T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ) => Promise<T>;
  canAdvanceSessionEntryCache?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  publishSessionFileSnapshot?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn["__openclawSessionLockPromptReleaseInstalled"] === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    try {
      if (params.sessionFile && params.withSessionWriteLock) {
        return await withOwnedSessionTranscriptWrites(
          {
            sessionFile: params.sessionFile,
            sessionKey: params.sessionKey,
            withSessionWriteLock: params.withSessionWriteLock,
            canAdvanceSessionEntryCache: params.canAdvanceSessionEntryCache,
            publishSessionFileSnapshot: params.publishSessionFileSnapshot,
          },
          async () => await originalStreamFn(...args),
        );
      }
      return await originalStreamFn(...args);
    } finally {
      await params.waitForSessionEvents(params.session);
      await params.reacquireAfterPrompt();
    }
  };
  wrappedStreamFn["__openclawSessionLockPromptReleaseInstalled"] = true;
  agent.streamFn = wrappedStreamFn;
}
