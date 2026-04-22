import fs from "node:fs/promises";
import path from "node:path";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { isUsageCountedSessionTranscriptFileName } from "../../config/sessions/artifacts.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");
const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";
// Keep the historical one-line-per-message export shape for normal turns, but
// wrap pathological long messages so downstream indexers never ingest a single
// toxic line. Wrapped continuation lines still map back to the same JSONL line.
// This limit applies to content only; the role label adds up to 11 chars.
const SESSION_EXPORT_CONTENT_WRAP_CHARS = 800;

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
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
};

export type BuildSessionEntryOptions = {
  /** Optional preclassification from a caller-managed dreaming transcript lookup. */
  generatedByDreamingNarrative?: boolean;
};

function isDreamingNarrativeBootstrapRecord(record: unknown): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const candidate = record as {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  };
  if (
    candidate.type !== "custom" ||
    candidate.customType !== "openclaw:bootstrap-context:full" ||
    !candidate.data ||
    typeof candidate.data !== "object" ||
    Array.isArray(candidate.data)
  ) {
    return false;
  }
  const runId = (candidate.data as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}

function hasDreamingNarrativeRunId(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}

function isDreamingNarrativeGeneratedRecord(record: unknown): boolean {
  if (isDreamingNarrativeBootstrapRecord(record)) {
    return true;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  const candidate = record as {
    runId?: unknown;
    sessionKey?: unknown;
    data?: unknown;
  };
  if (
    hasDreamingNarrativeRunId(candidate.runId) ||
    hasDreamingNarrativeRunId(candidate.sessionKey)
  ) {
    return true;
  }
  if (!candidate.data || typeof candidate.data !== "object" || Array.isArray(candidate.data)) {
    return false;
  }
  const nested = candidate.data as {
    runId?: unknown;
    sessionKey?: unknown;
  };
  return hasDreamingNarrativeRunId(nested.runId) || hasDreamingNarrativeRunId(nested.sessionKey);
}

function isDreamingNarrativeSessionStoreKey(sessionKey: string): boolean {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return false;
  }
  const firstSeparator = trimmed.indexOf(":");
  if (firstSeparator < 0) {
    return trimmed.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
  }
  const secondSeparator = trimmed.indexOf(":", firstSeparator + 1);
  const sessionSegment = secondSeparator < 0 ? trimmed : trimmed.slice(secondSeparator + 1);
  return sessionSegment.startsWith(DREAMING_NARRATIVE_RUN_PREFIX);
}

function normalizeComparablePath(pathname: string): string {
  const resolved = path.resolve(pathname);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function normalizeSessionTranscriptPathForComparison(pathname: string): string {
  return normalizeComparablePath(pathname);
}

function resolveSessionStoreTranscriptPath(
  sessionsDir: string,
  entry: { sessionFile?: unknown; sessionId?: unknown } | undefined,
): string | null {
  if (typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0) {
    const sessionFile = entry.sessionFile.trim();
    const resolved = path.isAbsolute(sessionFile)
      ? sessionFile
      : path.resolve(sessionsDir, sessionFile);
    return normalizeComparablePath(resolved);
  }
  if (typeof entry?.sessionId === "string" && entry.sessionId.trim().length > 0) {
    return normalizeComparablePath(path.join(sessionsDir, `${entry.sessionId.trim()}.jsonl`));
  }
  return null;
}

export function loadDreamingNarrativeTranscriptPathSetForSessionsDir(
  sessionsDir: string,
): ReadonlySet<string> {
  const storePath = path.join(sessionsDir, "sessions.json");
  const store = loadSessionStore(storePath);
  const dreamingTranscriptPaths = new Set<string>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!isDreamingNarrativeSessionStoreKey(sessionKey)) {
      continue;
    }
    const transcriptPath = resolveSessionStoreTranscriptPath(sessionsDir, entry);
    if (transcriptPath) {
      dreamingTranscriptPaths.add(transcriptPath);
    }
  }
  return dreamingTranscriptPaths;
}

export function loadDreamingNarrativeTranscriptPathSetForAgent(
  agentId: string,
): ReadonlySet<string> {
  return loadDreamingNarrativeTranscriptPathSetForSessionsDir(
    resolveSessionTranscriptsDirForAgent(agentId),
  );
}

function isDreamingNarrativeTranscriptFromSessionStore(absPath: string): boolean {
  const sessionsDir = path.dirname(absPath);
  const normalizedAbsPath = normalizeComparablePath(absPath);
  const dreamingTranscriptPaths = loadDreamingNarrativeTranscriptPathSetForSessionsDir(sessionsDir);
  return dreamingTranscriptPaths.has(normalizedAbsPath);
}

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => isUsageCountedSessionTranscriptFileName(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
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

/**
 * Strip OpenClaw-injected inbound metadata envelopes from a raw text block.
 *
 * User-role messages arriving from external channels (Telegram, Discord,
 * Slack, …) are stored with a multi-line prefix containing Conversation info,
 * Sender info, and other AI-facing metadata blocks. These envelopes must be
 * removed BEFORE normalization, because `stripInboundMetadata` relies on
 * newline structure and fenced `json` code fences to locate sentinels; once
 * `normalizeSessionText` collapses newlines into spaces, stripping is
 * impossible.
 *
 * See: https://github.com/openclaw/openclaw/issues/63921
 */
function stripInboundMetadataForUserRole(text: string, role: "user" | "assistant"): string {
  if (role !== "user") {
    return text;
  }
  return stripInboundMetadata(text);
}

export function extractSessionText(
  content: unknown,
  role: "user" | "assistant" = "assistant",
): string | null {
  const rawText = collectRawSessionText(content);
  if (rawText === null) {
    return null;
  }
  const stripped = stripInboundMetadataForUserRole(rawText, role);
  const normalized = normalizeSessionText(stripped);
  return normalized ? normalized : null;
}

function parseSessionTimestampMs(
  record: { timestamp?: unknown },
  message: { timestamp?: unknown },
): number {
  const candidates = [message.timestamp, record.timestamp];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 0 && value < 1e11 ? value * 1000 : value;
      if (Number.isFinite(ms) && ms > 0) {
        return ms;
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

export async function buildSessionEntry(
  absPath: string,
  opts: BuildSessionEntryOptions = {},
): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    const lineMap: number[] = [];
    const messageTimestampsMs: number[] = [];
    let generatedByDreamingNarrative =
      opts.generatedByDreamingNarrative ?? isDreamingNarrativeTranscriptFromSessionStore(absPath);
    for (let jsonlIdx = 0; jsonlIdx < lines.length; jsonlIdx++) {
      const line = lines[jsonlIdx];
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!generatedByDreamingNarrative && isDreamingNarrativeGeneratedRecord(record)) {
        generatedByDreamingNarrative = true;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content, message.role);
      if (!text) {
        continue;
      }
      if (generatedByDreamingNarrative) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      const renderedLines = renderSessionExportLines(label, safe);
      const timestampMs = parseSessionTimestampMs(
        record as { timestamp?: unknown },
        message as { timestamp?: unknown },
      );
      collected.push(...renderedLines);
      lineMap.push(...renderedLines.map(() => jsonlIdx + 1));
      messageTimestampsMs.push(...renderedLines.map(() => timestampMs));
    }
    const content = collected.join("\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content + "\n" + lineMap.join(",") + "\n" + messageTimestampsMs.join(",")),
      content,
      lineMap,
      messageTimestampsMs,
      ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
