import fsSync from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeAgentId } from "./config-utils.js";
import { readRegularFile, statRegularFile } from "./fs-utils.js";
import { hashText } from "./hash.js";
import { createSubsystemLogger, redactSensitiveText } from "./openclaw-runtime-io.js";
import {
  DREAMING_NARRATIVE_RUN_PREFIX,
  isDreamingNarrativeSessionStoreKey,
  extractAgentIdFromSessionPath,
  extractAgentIdFromSessionsDir,
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  hasInterSessionUserProvenance,
  isCompactionCheckpointTranscriptFileName,
  isCronRunSessionKey,
  isExecCompletionEvent,
  isHeartbeatUserMessage,
  isSessionArchiveArtifactName,
  isSilentReplyPayloadText,
  isUsageCountedSessionTranscriptFileName,
  loadTranscriptEventsSync,
  materializeSessionArchiveForRead,
  parseUsageCountedSessionIdFromFileName,
  parseSqliteSessionFileMarker,
  readTranscriptStatsSync,
  resolveTranscriptSessionKeyBySessionId,
  resolveSessionTranscriptsDirForAgent,
  stripInboundMetadata,
  stripInternalRuntimeContext,
} from "./openclaw-runtime-session.js";
import { retryTransientMemoryRead } from "./read-retry.js";
import { classifySessionMessageOrigin } from "./session-provenance.js";
import { resolveSessionResetRecallCutoff } from "./session-reset-recall.js";
import {
  listSessionTranscriptCorpusEntriesForAgentSync,
  type SessionTranscriptCorpusEntry,
} from "./session-transcript-corpus.js";
import type {
  MemorySessionSyncTarget,
  MemoryEntryProvenance,
  MemoryOriginClass,
  MemorySessionKind,
} from "./types.js";

export {
  listSessionTranscriptCorpusEntriesForAgent,
  type SessionTranscriptCorpusEntry,
  type SessionTranscriptCorpusOptions,
} from "./session-transcript-corpus.js";
export { readTranscriptStatsBatchReadOnlySync } from "./openclaw-runtime-session.js";

// Keep the historical one-line-per-message export shape for normal turns, but
// wrap pathological long messages so downstream indexers never ingest a single
// toxic line. Wrapped continuation lines still map back to the same JSONL line.
// This limit applies to content only; the role label adds up to 11 chars.
const SESSION_EXPORT_CONTENT_WRAP_CHARS = 800;
const SESSION_ENTRY_PARSE_YIELD_LINES = 250;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const DIRECT_CRON_PROMPT_RE = /^\[cron:[^\]]+\]\s*/;

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
  /** Maps each content line (0-indexed) to its 1-indexed JSONL source line. */
  lineMap: number[];
  /** Maps each content line (0-indexed) to epoch ms; 0 means unknown timestamp. */
  messageTimestampsMs: number[];
  /** Provenance aligned one-for-one with exported content lines. */
  lineProvenance: MemoryEntryProvenance[];
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
  /** True when this transcript belongs to an isolated cron run session. */
  generatedByCronRun?: boolean;
  sessionKind: MemorySessionKind;
};

export type SessionFileState = Pick<SessionFileEntry, "path" | "absPath" | "mtimeMs" | "size">;

export type BuildSessionEntryOptions = {
  /** Optional preclassification from a caller-managed dreaming transcript lookup. */
  generatedByDreamingNarrative?: boolean;
  /** Optional preclassification from a caller-managed cron transcript lookup. */
  generatedByCronRun?: boolean;
  sessionKind?: MemorySessionKind;
  /** Session key for identity-backed transcript readers. */
  sessionKey?: string;
  /** Direct SQLite identity for live runtime transcripts. */
  agentId?: string;
  sessionId?: string;
  storePath?: string;
  /** Activity timestamp for transcript sources that do not have filesystem stats. */
  updatedAtMs?: number;
  /** Override for tests or specialized callers that need a tighter parse yield cadence. */
  parseYieldEveryLines?: number;
  /** Observe persisted messages before memory indexing drops tool-only content. */
  onTranscriptMessage?: (message: unknown, observedAt: number) => void;
};

type SessionTranscriptClassification = {
  dreamingNarrativeTranscriptPaths: ReadonlySet<string>;
  cronRunTranscriptPaths: ReadonlySet<string>;
};

type SessionTranscriptStoreEntry = {
  sessionFile?: unknown;
  sessionId?: unknown;
};

function shouldSkipTranscriptFileForDreaming(absPath: string): boolean {
  const fileName = path.basename(absPath);
  // Compaction checkpoints are always skipped: they are derived snapshots of an
  // active session and would double-index the same content.
  if (isCompactionCheckpointTranscriptFileName(fileName)) {
    return true;
  }
  // Legacy backups and `.jsonl.bak.<iso>` rotations are opaque pre-archive
  // copies, not a user-facing session artifact; skip them too.
  if (
    isSessionArchiveArtifactName(fileName) &&
    !isUsageCountedSessionTranscriptFileName(fileName)
  ) {
    return true;
  }
  // Usage-counted archives (`.jsonl.reset.<iso>` / `.jsonl.deleted.<iso>`) are
  // the rotated-but-retained copies of real sessions and must stay indexed so
  // `memory_search` can surface hits on post-reset / post-delete history.
  return false;
}

function isUsageCountedSessionArchiveTranscriptPath(absPath: string): boolean {
  const fileName = path.basename(absPath);
  return (
    isUsageCountedSessionTranscriptFileName(fileName) &&
    isSessionArchiveArtifactName(fileName) &&
    parseUsageCountedSessionIdFromFileName(fileName) !== null
  );
}

function hasDreamingNarrativeIdentity(value: unknown): boolean {
  return typeof value === "string" && isDreamingNarrativeSessionStoreKey(value);
}

function isDreamingNarrativeGeneratedRecord(record: unknown): boolean {
  const candidate = asOptionalRecord(record);
  if (!candidate) {
    return false;
  }
  const data = asOptionalRecord(candidate.data);
  if (
    candidate.type === "custom" &&
    candidate.customType === "openclaw:bootstrap-context:full" &&
    typeof data?.runId === "string" &&
    data.runId.startsWith(DREAMING_NARRATIVE_RUN_PREFIX)
  ) {
    return true;
  }
  const message = candidate.type === "message" ? asOptionalRecord(candidate.message) : undefined;
  const metadata = asOptionalRecord(message?.["__openclaw"]);
  return (
    hasDreamingNarrativeIdentity(candidate.runId) ||
    hasDreamingNarrativeIdentity(candidate.sessionKey) ||
    hasDreamingNarrativeIdentity(data?.runId) ||
    hasDreamingNarrativeIdentity(data?.sessionKey) ||
    ((message?.role === "assistant" || message?.role === "toolResult") &&
      hasDreamingNarrativeIdentity(metadata?.runId))
  );
}

function hasCronRunSessionKey(value: unknown): boolean {
  return typeof value === "string" && isCronRunSessionKey(value);
}

function isCronRunGeneratedRecord(record: unknown): boolean {
  const candidate = asOptionalRecord(record);
  return (
    hasCronRunSessionKey(candidate?.sessionKey) ||
    hasCronRunSessionKey(asOptionalRecord(candidate?.data)?.sessionKey)
  );
}

function normalizeComparablePath(pathname: string): string {
  const resolved = path.resolve(pathname);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveSessionStoreTranscriptPath(
  sessionsDir: string,
  entry: { sessionFile?: unknown; sessionId?: unknown } | undefined,
): string | null {
  const resolved = resolveSessionStoreTranscriptResolvedPath(sessionsDir, entry);
  return resolved ? normalizeComparablePath(resolved) : null;
}

function resolveSessionStoreTranscriptResolvedPath(
  sessionsDir: string,
  entry: { sessionFile?: unknown; sessionId?: unknown } | undefined,
): string | null {
  if (typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0) {
    const sessionFile = entry.sessionFile.trim();
    return path.isAbsolute(sessionFile) ? sessionFile : path.resolve(sessionsDir, sessionFile);
  }
  if (typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0) {
    return path.join(sessionsDir, `${entry.sessionId.trim()}.jsonl`);
  }
  return null;
}

function isCanonicalSessionsDirForAgent(sessionsDir: string, agentId: string): boolean {
  return (
    normalizeComparablePath(sessionsDir) ===
    normalizeComparablePath(resolveSessionTranscriptsDirForAgent(agentId))
  );
}

function loadSessionTranscriptClassificationForSessionsDir(
  sessionsDir: string,
): SessionTranscriptClassification {
  const agentId = extractAgentIdFromSessionsDir(sessionsDir);
  if (agentId && isCanonicalSessionsDirForAgent(sessionsDir, agentId)) {
    return classifySessionTranscriptCorpusEntries(
      listSessionTranscriptCorpusEntriesForAgentSync(agentId),
    );
  }
  const storePath = path.join(sessionsDir, "sessions.json");
  const store = readSessionTranscriptClassificationStore(storePath);
  const dreamingTranscriptPaths = new Set<string>();
  const cronRunTranscriptPaths = new Set<string>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    const transcriptPath = resolveSessionStoreTranscriptPath(sessionsDir, entry);
    if (!transcriptPath) {
      continue;
    }
    if (isDreamingNarrativeSessionStoreKey(sessionKey)) {
      dreamingTranscriptPaths.add(transcriptPath);
    }
    if (isCronRunSessionKey(sessionKey)) {
      cronRunTranscriptPaths.add(transcriptPath);
    }
  }
  return {
    dreamingNarrativeTranscriptPaths: dreamingTranscriptPaths,
    cronRunTranscriptPaths,
  };
}

function readSessionTranscriptClassificationStore(
  storePath: string,
): Record<string, SessionTranscriptStoreEntry> {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(storePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, SessionTranscriptStoreEntry>;
  } catch {
    return {};
  }
}

function classifySessionTranscriptCorpusEntries(
  corpusEntries: readonly SessionTranscriptCorpusEntry[],
): SessionTranscriptClassification {
  const dreamingTranscriptPaths = new Set<string>();
  const cronRunTranscriptPaths = new Set<string>();
  for (const entry of corpusEntries) {
    if (entry.transcriptSource === "sqlite") {
      continue;
    }
    const normalizedPath = normalizeComparablePath(entry.sessionFile);
    if (entry.generatedByDreamingNarrative) {
      dreamingTranscriptPaths.add(normalizedPath);
    }
    if (entry.generatedByCronRun) {
      cronRunTranscriptPaths.add(normalizedPath);
    }
  }
  return {
    dreamingNarrativeTranscriptPaths: dreamingTranscriptPaths,
    cronRunTranscriptPaths,
  };
}

function classifySessionTranscriptFromSessionStore(absPath: string): {
  generatedByDreamingNarrative: boolean;
  generatedByCronRun: boolean;
} {
  const sessionsDir = path.dirname(absPath);
  const normalizedAbsPath = normalizeComparablePath(absPath);
  const primarySessionId = parseUsageCountedSessionIdFromFileName(path.basename(absPath));
  const normalizedPrimaryPath =
    primarySessionId && isSessionArchiveArtifactName(path.basename(absPath))
      ? normalizeComparablePath(path.join(sessionsDir, `${primarySessionId}.jsonl`))
      : null;
  const classification = loadSessionTranscriptClassificationForSessionsDir(sessionsDir);
  const hasClassifiedPath = (paths: ReadonlySet<string>) =>
    paths.has(normalizedAbsPath) ||
    (normalizedPrimaryPath !== null && paths.has(normalizedPrimaryPath));
  return {
    generatedByDreamingNarrative: hasClassifiedPath(
      classification.dreamingNarrativeTranscriptPaths,
    ),
    generatedByCronRun: hasClassifiedPath(classification.cronRunTranscriptPaths),
  };
}

export function sessionPathForFile(absPath: string): string {
  const agentId = extractAgentIdFromSessionPath(absPath);
  return path
    .join("sessions", ...(agentId ? [agentId] : []), path.basename(absPath))
    .replace(/\\/g, "/");
}

/** Returns the logical memory path for a live SQLite-backed session transcript. */
export function sessionPathForSessionIdentity(agentId: string, sessionId: string): string {
  return path.join("sessions", normalizeAgentId(agentId), `${sessionId}.jsonl`).replace(/\\/g, "/");
}

/**
 * Parses a deprecated path-shaped memory sync hint only when it points at an
 * OpenClaw-owned usage-counted transcript in the canonical agent sessions dir.
 */
export function parseCanonicalSessionSyncTargetFromPath(
  sessionFile: string,
): MemorySessionSyncTarget | null {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    return null;
  }
  const resolved = path.resolve(trimmed);
  const fileName = path.basename(resolved);
  const sessionId = parseUsageCountedSessionIdFromFileName(fileName);
  if (!sessionId || !isUsageCountedSessionTranscriptFileName(fileName)) {
    return null;
  }
  const agentId = extractAgentIdFromSessionPath(resolved);
  if (!agentId) {
    return null;
  }
  const canonicalSessionsDir = normalizeComparablePath(
    resolveSessionTranscriptsDirForAgent(agentId),
  );
  if (normalizeComparablePath(path.dirname(resolved)) !== canonicalSessionsDir) {
    return null;
  }
  return { agentId, sessionId };
}

async function logSessionFileReadFailure(absPath: string, err: unknown): Promise<void> {
  createSubsystemLogger("memory").debug(`Failed reading session file ${absPath}: ${String(err)}`);
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function splitLongSessionLine(
  text: string,
  maxChars: number = SESSION_EXPORT_CONTENT_WRAP_CHARS,
): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const segments: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const remaining = normalized.length - cursor;
    if (remaining <= maxChars) {
      segments.push(normalized.slice(cursor).trim());
      break;
    }

    const limit = cursor + maxChars;
    let splitAt = limit;
    for (let index = limit; index > cursor; index -= 1) {
      if (normalized[index] === " ") {
        splitAt = index;
        break;
      }
    }
    if (
      splitAt < normalized.length &&
      splitAt > cursor &&
      isHighSurrogate(normalized.charCodeAt(splitAt - 1)) &&
      isLowSurrogate(normalized.charCodeAt(splitAt))
    ) {
      splitAt -= 1;
    }
    segments.push(normalized.slice(cursor, splitAt).trim());
    cursor = splitAt;
    while (cursor < normalized.length && normalized[cursor] === " ") {
      cursor += 1;
    }
  }

  return segments.filter(Boolean);
}

function renderSessionExportLines(label: string, text: string): string[] {
  return splitLongSessionLine(text).map((segment) => `${label}: ${segment}`);
}

const GENERATED_SYSTEM_MESSAGE_RE = /^System(?: \(untrusted\))?: \[[^\]]+\]\s*/;

function sanitizeSessionText(text: string, role: "user" | "assistant"): string | null {
  // Metadata envelopes require their original newlines; strip them before whitespace normalization.
  const strippedInbound = role === "user" ? stripInboundMetadata(text) : text;
  const strippedInternal = stripInternalRuntimeContext(strippedInbound);
  const normalized = normalizeSessionText(strippedInternal);
  if (!normalized) {
    return null;
  }
  if (
    role === "user" &&
    (GENERATED_SYSTEM_MESSAGE_RE.test(normalized) ||
      DIRECT_CRON_PROMPT_RE.test(normalized) ||
      isHeartbeatUserMessage({ role, content: normalized }, HEARTBEAT_PROMPT))
  ) {
    return null;
  }
  if (isSilentReplyPayloadText(normalized)) {
    return null;
  }
  // Assistant-side machinery acks: HEARTBEAT_OK is the canonical "all clear,
  // nothing to do" reply to a heartbeat tick. Drop on the assistant side
  // directly so we do not have to rely on cross-message coupling with the
  // preceding user message (which a real user could spoof).
  if (role === "assistant" && normalized === HEARTBEAT_TOKEN) {
    return null;
  }
  const withoutSystemEnvelope = normalized.replace(GENERATED_SYSTEM_MESSAGE_RE, "").trim();
  if (isExecCompletionEvent(withoutSystemEnvelope)) {
    return null;
  }
  return normalized;
}

function isRecalledMemoryMessage(message: { provenance?: unknown }): boolean {
  const provenance = message.provenance as { kind?: unknown; sourceTool?: unknown } | undefined;
  return (
    provenance?.kind === "internal_system" &&
    (provenance.sourceTool === "memory_search" || provenance.sourceTool === "memory_get")
  );
}

function parseSessionTimestampMs(
  record: { timestamp?: unknown },
  message: { timestamp?: unknown },
): number {
  const candidates = [message.timestamp, record.timestamp];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 0 && value < 1e11 ? value * 1000 : value;
      if (Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_TIMESTAMP_MS) {
        return Math.floor(ms);
      }
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return 0;
}

function resolveSessionEntryParseYieldLines(opts: BuildSessionEntryOptions): number {
  const configured = opts.parseYieldEveryLines;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(1, Math.floor(configured));
  }
  return SESSION_ENTRY_PARSE_YIELD_LINES;
}

function resolveBuildSessionSqliteIdentity(absPath: string, opts: BuildSessionEntryOptions) {
  if (opts.agentId && opts.sessionId && opts.storePath) {
    return {
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
      storePath: opts.storePath,
    };
  }
  const marker = parseSqliteSessionFileMarker(absPath);
  return marker && opts.sessionKey ? { ...marker, sessionKey: opts.sessionKey } : marker;
}

export function statSessionEntrySync(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
): SessionFileState | null {
  const sqliteIdentity = resolveBuildSessionSqliteIdentity(absPath, opts);
  if (sqliteIdentity) {
    const stats = readTranscriptStatsSync({
      ...sqliteIdentity,
    });
    return {
      absPath,
      path: sessionPathForSessionIdentity(sqliteIdentity.agentId, sqliteIdentity.sessionId),
      mtimeMs: opts.updatedAtMs ?? stats.maxSeq,
      size: stats.sizeBytes,
    };
  }
  try {
    const stat = fsSync.statSync(absPath);
    return stat.isFile()
      ? {
          absPath,
          path: sessionPathForFile(absPath),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        }
      : null;
  } catch {
    return null;
  }
}

async function yieldSessionEntryParseIfNeeded(
  lineIndex: number,
  everyLines: number,
): Promise<void> {
  if (lineIndex > 0 && lineIndex % everyLines === 0) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export async function buildSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
): Promise<SessionFileEntry | null> {
  try {
    const sqliteIdentity = resolveBuildSessionSqliteIdentity(absPath, opts);
    const sqliteSource = sqliteIdentity
      ? (() => {
          const stats = readTranscriptStatsSync(sqliteIdentity);
          const records = loadTranscriptEventsSync(sqliteIdentity);
          const resetRecallCutoff = resolveSessionResetRecallCutoff(records);
          return {
            mtimeMs: opts.updatedAtMs ?? stats.maxSeq,
            path: sessionPathForSessionIdentity(sqliteIdentity.agentId, sqliteIdentity.sessionId),
            records,
            resetRecallCutoff,
            size: stats.sizeBytes,
          };
        })()
      : null;
    let raw = "";
    let mtimeMs: number;
    let size: number;
    let memoryPath: string;
    if (sqliteSource) {
      mtimeMs = sqliteSource.mtimeMs;
      size = sqliteSource.size;
      memoryPath = sqliteSource.path;
    } else {
      const regularFile = await statRegularFile(absPath);
      if (regularFile.missing) {
        return null;
      }
      const stat = regularFile.stat;
      if (shouldSkipTranscriptFileForDreaming(absPath)) {
        return {
          path: sessionPathForFile(absPath),
          absPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          hash: hashText("\n\n"),
          content: "",
          lineMap: [],
          messageTimestampsMs: [],
          lineProvenance: [],
          sessionKind: opts.sessionKind ?? "unknown",
        };
      }
      raw = (
        await retryTransientMemoryRead(
          () =>
            readRegularFile({
              filePath: isUsageCountedSessionArchiveTranscriptPath(absPath)
                ? materializeSessionArchiveForRead(absPath)
                : absPath,
            }),
          `read session transcript ${absPath}`,
        )
      ).buffer.toString("utf-8");
      mtimeMs = stat.mtimeMs;
      size = stat.size;
      memoryPath = sessionPathForFile(absPath);
    }
    const collected: string[] = [];
    const lineMap: number[] = [];
    const messageTimestampsMs: number[] = [];
    const lineProvenance: MemoryEntryProvenance[] = [];
    const parseYieldEveryLines = resolveSessionEntryParseYieldLines(opts);
    const sqliteSessionKey =
      sqliteIdentity && !opts.sessionKey
        ? resolveTranscriptSessionKeyBySessionId({
            agentId: sqliteIdentity.agentId,
            sessionId: sqliteIdentity.sessionId,
            storePath: sqliteIdentity.storePath,
          })
        : undefined;
    const sessionStoreClassification =
      !sqliteIdentity &&
      (opts.generatedByDreamingNarrative === undefined || opts.generatedByCronRun === undefined)
        ? classifySessionTranscriptFromSessionStore(absPath)
        : null;
    let generatedByDreamingNarrative =
      opts.generatedByDreamingNarrative ??
      (sqliteSessionKey ? isDreamingNarrativeSessionStoreKey(sqliteSessionKey) : undefined) ??
      sessionStoreClassification?.generatedByDreamingNarrative ??
      false;
    let generatedByCronRun =
      opts.generatedByCronRun ??
      (sqliteSessionKey ? isCronRunSessionKey(sqliteSessionKey) : undefined) ??
      sessionStoreClassification?.generatedByCronRun ??
      false;
    const sessionKind = opts.sessionKind ?? "unknown";
    const allowArchiveRecordCronClassification =
      isUsageCountedSessionArchiveTranscriptPath(absPath);
    // A heartbeat owns every generated response until the next user turn. The
    // persisted runtime provenance makes this coupling safe from text spoofing.
    let insideHeartbeatTurn = false;
    let insideRecalledMemoryTurn = false;
    let turnOrigin: MemoryOriginClass = "untrusted";
    // SQLite is fully snapshotted before yielding or invoking observers. Archives
    // retain raw line ordinals, including blank and malformed JSONL entries.
    for (
      let jsonlIdx = 0, lineStart = 0;
      sqliteSource ? jsonlIdx < sqliteSource.records.length : lineStart <= raw.length;
      jsonlIdx++
    ) {
      await yieldSessionEntryParseIfNeeded(jsonlIdx, parseYieldEveryLines);
      let record: unknown;
      if (sqliteSource) {
        record = sqliteSource.records[jsonlIdx];
      } else {
        const newlineIndex = raw.indexOf("\n", lineStart);
        const lineEnd = newlineIndex === -1 ? raw.length : newlineIndex;
        const line = raw.slice(lineStart, lineEnd);
        lineStart = newlineIndex === -1 ? raw.length + 1 : newlineIndex + 1;
        if (!line.trim()) {
          continue;
        }
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
      }
      const identifiesDreamingNarrative =
        !generatedByDreamingNarrative && isDreamingNarrativeGeneratedRecord(record);
      const identifiesCronRun =
        !generatedByCronRun &&
        allowArchiveRecordCronClassification &&
        isCronRunGeneratedRecord(record);
      if (identifiesDreamingNarrative || identifiesCronRun) {
        generatedByDreamingNarrative ||= identifiesDreamingNarrative;
        generatedByCronRun ||= identifiesCronRun;
        collected.length = 0;
        lineMap.length = 0;
        messageTimestampsMs.length = 0;
        lineProvenance.length = 0;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown; provenance?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const timestampMs = parseSessionTimestampMs(
        record as { timestamp?: unknown },
        message as { timestamp?: unknown },
      );
      opts.onTranscriptMessage?.(message, Math.max(0, Math.floor(timestampMs || mtimeMs)));
      const inputProvenance = message.provenance as
        | { kind?: unknown; sourceTool?: unknown }
        | undefined;
      const isHeartbeatUser =
        message.role === "user" &&
        inputProvenance?.kind === "internal_system" &&
        inputProvenance.sourceTool === "heartbeat";
      if (message.role === "user") {
        insideHeartbeatTurn = isHeartbeatUser;
        insideRecalledMemoryTurn = isRecalledMemoryMessage(message);
        turnOrigin = classifySessionMessageOrigin(message, turnOrigin);
      }
      if (message.role === "user" && hasInterSessionUserProvenance(message)) {
        continue;
      }
      // Observers and turn provenance still see excluded messages; text export does not.
      if (
        insideHeartbeatTurn ||
        insideRecalledMemoryTurn ||
        generatedByDreamingNarrative ||
        generatedByCronRun
      ) {
        continue;
      }
      const rawText = collectRawSessionText(message.content);
      if (rawText === null) {
        continue;
      }

      // User text is not trusted archive-wide provenance. Per-message sanitization
      // drops cron prompts without clearing unrelated content from the archive.
      const text = sanitizeSessionText(rawText, message.role);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      const renderedLines = renderSessionExportLines(label, safe);
      const memoryProvenance: MemoryEntryProvenance = {
        originClass: classifySessionMessageOrigin(message, turnOrigin),
        sessionKind,
        observedAt: Math.max(0, Math.floor(timestampMs || mtimeMs)),
      };
      collected.push(...renderedLines);
      lineMap.push(...renderedLines.map(() => jsonlIdx + 1));
      messageTimestampsMs.push(...renderedLines.map(() => timestampMs));
      lineProvenance.push(...renderedLines.map(() => memoryProvenance));
    }
    const content = collected.join("\n");
    const entry: SessionFileEntry = {
      path: memoryPath,
      absPath,
      mtimeMs,
      size,
      hash: hashText(
        content +
          "\n" +
          lineMap.join(",") +
          "\n" +
          messageTimestampsMs.join(",") +
          "\n" +
          JSON.stringify(lineProvenance) +
          "\n" +
          JSON.stringify(sqliteSource?.resetRecallCutoff ?? { state: "absent" }),
      ),
      content,
      lineMap,
      messageTimestampsMs,
      lineProvenance,
      sessionKind,
      ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
      ...(generatedByCronRun ? { generatedByCronRun: true } : {}),
    };
    Object.defineProperty(entry, Symbol.for("openclaw.memory.sessionResetRecallCutoff"), {
      configurable: false,
      enumerable: false,
      value: sqliteSource?.resetRecallCutoff ?? { state: "absent" },
      writable: false,
    });
    return entry;
  } catch (err) {
    void logSessionFileReadFailure(absPath, err);
    return null;
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
