import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  parseUsageCountedSessionIdFromFileName,
  sessionPathForFile,
  statSessionEntrySync,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeSessionIngestionState,
  SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION,
  type SessionIngestionFileState,
  type SessionIngestionState,
} from "./dreaming-ingestion-state.js";
import {
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  SESSION_SEEN_HASHES_PER_CHUNK,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";

export type { SessionIngestionState } from "./dreaming-ingestion-state.js";

export const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
export const SESSION_INGESTION_SCORE = 0.58;
export const SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP = 240;
export const SESSION_INGESTION_MAX_MESSAGES_PER_FILE = 80;
export const SESSION_INGESTION_MIN_MESSAGES_PER_FILE = 12;
const SESSION_INGESTION_MIN_SNIPPET_CHARS = 12;
const SESSION_INGESTION_MAX_SNIPPET_CHARS = 280;
const SESSION_INGESTION_MAX_TRACKED_SCOPES = 2048;
type BuildSessionEntryOptions = NonNullable<Parameters<typeof buildSessionEntry>[1]>;

export type SessionIngestionMessage = {
  day: string;
  snippet: string;
  rendered: string;
  provenance: NonNullable<MemorySearchResult["provenance"]>;
};

export type SessionIngestionSource = {
  agentId: string;
  absolutePath: string;
  foreign: boolean;
  sessionPath: string;
  stateKey: string;
  scope: string;
  legacyScope?: string;
  buildOptions: BuildSessionEntryOptions;
};

export type SessionIngestionCandidate = SessionIngestionMessage & {
  contentIndex: number;
  hash: string;
  lineNumber: number;
  scope: string;
  stateKey: string;
};

type SessionIngestionScan = {
  status: "absent" | "excluded" | "unavailable" | "unchanged" | "scanned";
  candidates: SessionIngestionCandidate[];
  fileState?: SessionIngestionFileState;
  progressBlockIndex?: number;
  scannedEndIndex: number;
};

type DayDisposition = "include" | "skip" | "block";

function buildSessionScope(agentId: string, sessionId: string): string {
  const logicalId =
    parseUsageCountedSessionIdFromFileName(sessionId) ??
    parseUsageCountedSessionIdFromFileName(`${sessionId}.jsonl`) ??
    sessionId;
  return `${agentId}:${logicalId}`;
}

function sessionPathFromCorpus(entry: SessionTranscriptCorpusEntry): string {
  return entry.transcriptSource === "sqlite"
    ? path.join("sessions", entry.agentId, entry.sessionId).replace(/\\/g, "/")
    : sessionPathForFile(entry.sessionFile);
}

export function sessionIngestionSourceFromCorpus(
  entry: SessionTranscriptCorpusEntry,
): SessionIngestionSource | null {
  const sessionPath = sessionPathFromCorpus(entry);
  if (entry.sessionKind !== "interactive") {
    return null;
  }
  const scope =
    entry.transcriptSource === "sqlite"
      ? `${entry.agentId}:${sessionPath}`
      : buildSessionScope(entry.agentId, path.basename(entry.sessionFile));
  return {
    agentId: entry.agentId,
    absolutePath: entry.sessionFile,
    foreign: false,
    sessionPath,
    stateKey: `${entry.agentId}:${sessionPath}`,
    scope,
    ...(entry.transcriptSource === "sqlite"
      ? {
          legacyScope: buildSessionScope(entry.agentId, entry.sessionId),
        }
      : {}),
    buildOptions: {
      sessionKind: "interactive",
      ...(entry.transcriptSource === "sqlite"
        ? { agentId: entry.agentId, sessionId: entry.sessionId }
        : {}),
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.storePath ? { storePath: entry.storePath } : {}),
      ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
      ...(entry.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
      ...(entry.generatedByCronRun ? { generatedByCronRun: true } : {}),
    },
  };
}

export function sessionIngestionStateKeyFromCorpus(entry: SessionTranscriptCorpusEntry): string {
  return `${entry.agentId}:${sessionPathFromCorpus(entry)}`;
}

export function foreignSessionIngestionSource(
  agentId: string,
  archiveFile: string,
): SessionIngestionSource {
  const absolutePath = path.resolve(archiveFile);
  const normalizedPath = absolutePath.replaceAll("\\", "/");
  return {
    agentId,
    absolutePath,
    foreign: true,
    sessionPath: sessionPathForFile(absolutePath),
    stateKey: `session-backfill:${normalizedPath}`,
    scope: `archive:${agentId}:${normalizedPath}`,
    buildOptions: { sessionKind: "interactive" },
  };
}

function normalizeSessionCorpusSnippet(value: string): string {
  return truncateUtf16Safe(value.replace(/\s+/g, " ").trim(), SESSION_INGESTION_MAX_SNIPPET_CHARS);
}

function hashSessionMessageId(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

async function statSessionSource(source: SessionIngestionSource) {
  if (source.buildOptions.agentId && source.buildOptions.storePath) {
    try {
      const stat = statSessionEntrySync(source.absolutePath, source.buildOptions);
      return stat
        ? { mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)), size: Math.floor(stat.size) }
        : null;
    } catch {
      return undefined;
    }
  }
  const stat = await fs.stat(source.absolutePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  });
  return stat
    ? { mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)), size: Math.floor(stat.size) }
    : null;
}

export async function scanSessionIngestionSource(params: {
  source: SessionIngestionSource;
  previous?: SessionIngestionFileState;
  seenMessages: Record<string, string[]>;
  timezone?: string;
  maxCandidates?: number;
  verifyContent?: boolean;
  acceptProvenance?: (provenance: SessionIngestionMessage["provenance"]) => boolean;
  classifyDay: (day: string) => DayDisposition;
}): Promise<SessionIngestionScan> {
  const emptyScan = (
    status: SessionIngestionScan["status"],
    fileState?: SessionIngestionFileState,
  ): SessionIngestionScan => ({
    status,
    candidates: [],
    ...(fileState ? { fileState } : {}),
    scannedEndIndex: fileState?.lastContentLine ?? 0,
  });
  const fingerprint = await statSessionSource(params.source);
  if (fingerprint === null) {
    return emptyScan("absent");
  }
  if (
    !params.verifyContent &&
    fingerprint &&
    params.previous?.mtimeMs === fingerprint.mtimeMs &&
    params.previous.size === fingerprint.size &&
    params.previous.contentHash.length > 0 &&
    params.previous.lastContentLine >= params.previous.lineCount
  ) {
    return emptyScan("unchanged", params.previous);
  }
  const entry = await buildSessionEntry(params.source.absolutePath, params.source.buildOptions);
  if (!entry) {
    // Tolerant readers collapse transient failures to null. The stat boundary
    // above owns absence, so retain any prior checkpoint here.
    return emptyScan("unavailable", params.previous);
  }
  const fileFingerprint = {
    mtimeMs: Math.floor(Math.max(0, entry.mtimeMs)),
    size: Math.floor(Math.max(0, entry.size)),
  };
  const lines = entry.content ? entry.content.split("\n") : [];
  const terminalState = {
    ...fileFingerprint,
    contentHash: entry.hash.trim(),
    lineCount: lines.length,
    lastContentLine: lines.length,
  };
  if (entry.generatedByDreamingNarrative || entry.generatedByCronRun) {
    return emptyScan("excluded", terminalState);
  }
  if (
    params.previous?.mtimeMs === fileFingerprint.mtimeMs &&
    params.previous.size === fileFingerprint.size &&
    params.previous.contentHash === terminalState.contentHash &&
    params.previous.lineCount === lines.length &&
    params.previous.lastContentLine >= lines.length
  ) {
    return emptyScan("unchanged", params.previous);
  }
  const sameContent =
    params.previous?.mtimeMs === fileFingerprint.mtimeMs &&
    params.previous.size === fileFingerprint.size &&
    params.previous.contentHash === terminalState.contentHash &&
    params.previous.lineCount === lines.length;
  const startIndex = sameContent
    ? Math.max(0, Math.min(params.previous?.lastContentLine ?? 0, lines.length))
    : 0;
  const seen = new Set(params.seenMessages[params.source.scope] ?? []);
  const legacySeen = params.source.legacyScope
    ? new Set(params.seenMessages[params.source.legacyScope] ?? [])
    : undefined;
  const candidates: SessionIngestionCandidate[] = [];
  let progressBlockIndex: number | undefined;
  let scannedEndIndex = startIndex;
  for (let index = startIndex; index < lines.length; index += 1) {
    if (params.maxCandidates !== undefined && candidates.length >= params.maxCandidates) {
      break;
    }
    scannedEndIndex = index + 1;
    const snippet = normalizeSessionCorpusSnippet(lines[index] ?? "");
    if (snippet.length < SESSION_INGESTION_MIN_SNIPPET_CHARS) {
      continue;
    }
    const lineNumber = entry.lineMap[index] ?? index + 1;
    const timestampMs = entry.messageTimestampsMs[index] ?? 0;
    const parsedProvenance = entry.lineProvenance[index] ?? {
      originClass: "untrusted",
      sessionKind: "interactive",
      observedAt: timestampMs || entry.mtimeMs,
    };
    // Foreign JSONL is caller-controlled; only canonical stores authenticate provenance.
    const provenance = params.source.foreign
      ? { ...parsedProvenance, originClass: "untrusted" as const }
      : parsedProvenance;
    if (params.acceptProvenance && !params.acceptProvenance(provenance)) {
      continue;
    }
    const day = formatMemoryDreamingDay(timestampMs || entry.mtimeMs, params.timezone);
    const disposition = params.classifyDay(day);
    if (disposition !== "include") {
      if (disposition === "block") {
        progressBlockIndex ??= index;
      }
      continue;
    }
    const basis = timestampMs > 0 ? `ts:${Math.floor(timestampMs)}` : `line:${lineNumber}`;
    const hash = hashSessionMessageId(`${params.source.scope}\n${basis}\n${snippet}`);
    const legacyHash = params.source.legacyScope
      ? hashSessionMessageId(`${params.source.legacyScope}\n${basis}\n${snippet}`)
      : undefined;
    if (seen.has(hash) || (legacyHash && legacySeen?.has(legacyHash))) {
      continue;
    }
    candidates.push({
      contentIndex: index,
      day,
      hash,
      lineNumber,
      provenance,
      rendered: truncateUtf16Safe(
        `[${params.source.agentId}/${params.source.sessionPath}#L${lineNumber}] ${snippet}`,
        SESSION_INGESTION_MAX_SNIPPET_CHARS + 64,
      ),
      scope: params.source.scope,
      stateKey: params.source.stateKey,
      snippet,
    });
    seen.add(hash);
  }
  return {
    status: "scanned",
    candidates,
    fileState: { ...terminalState, lastContentLine: scannedEndIndex },
    ...(progressBlockIndex !== undefined ? { progressBlockIndex } : {}),
    scannedEndIndex,
  };
}

export function mergeTrackedMessageHashes(existing: string[], additions: string[]): string[] {
  const merged = [...new Set([...existing, ...additions])];
  return merged.slice(-SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION);
}

export function trimTrackedSessionScopes(seenMessages: Record<string, string[]>) {
  const keep = new Set(
    Object.keys(seenMessages).toSorted().slice(-SESSION_INGESTION_MAX_TRACKED_SCOPES),
  );
  return Object.fromEntries(Object.entries(seenMessages).filter(([scope]) => keep.has(scope)));
}

export async function readSessionIngestionState(
  workspaceDir: string,
): Promise<SessionIngestionState> {
  const [files, seenChunks] = await Promise.all([
    readMemoryCoreWorkspaceEntries<SessionIngestionFileState>({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    }),
    readMemoryCoreWorkspaceEntries<{ scope: string; index: number; hashes: string[] }>({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir,
    }),
  ]);
  const seenMessages: Record<string, string[]> = {};
  for (const { value } of seenChunks.toSorted((a, b) => a.value.index - b.value.index)) {
    if (!value.scope.trim()) {
      continue;
    }
    seenMessages[value.scope] = [...(seenMessages[value.scope] ?? []), ...value.hashes];
  }
  return normalizeSessionIngestionState({
    version: 3,
    files: Object.fromEntries(files.map((entry) => [entry.key, entry.value])),
    seenMessages,
  });
}

export async function writeSessionIngestionState(
  workspaceDir: string,
  state: SessionIngestionState,
): Promise<void> {
  const seenEntries = Object.entries(state.seenMessages).flatMap(([scope, hashes]) =>
    Array.from(
      { length: Math.ceil(hashes.length / SESSION_SEEN_HASHES_PER_CHUNK) },
      (_, index) => ({
        key: `${scope}:${index}`,
        value: {
          scope,
          index,
          hashes: hashes.slice(
            index * SESSION_SEEN_HASHES_PER_CHUNK,
            (index + 1) * SESSION_SEEN_HASHES_PER_CHUNK,
          ),
        },
      }),
    ),
  );
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
      workspaceDir,
      entries: seenEntries,
    }),
  ]);
}

export async function appendSessionCorpusLines(params: {
  workspaceDir: string;
  day: string;
  lines: SessionIngestionMessage[];
}): Promise<MemorySearchResult[]> {
  if (params.lines.length === 0) {
    return [];
  }
  const relativePath = path.posix.join("memory", ".dreams", "session-corpus", `${params.day}.txt`);
  const absolutePath = path.join(
    params.workspaceDir,
    SESSION_CORPUS_RELATIVE_DIR,
    `${params.day}.txt`,
  );
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const existing = await fs.readFile(absolutePath, "utf-8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const normalized = existing.replace(/\r\n/g, "\n");
  const existingLines = normalized
    ? (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n").length
    : 0;
  await appendRegularFile({
    filePath: absolutePath,
    content: `${params.lines.map((entry) => entry.rendered).join("\n")}\n`,
    rejectSymlinkParents: true,
  });
  return params.lines.map((entry, index) => ({
    path: relativePath,
    startLine: existingLines + index + 1,
    endLine: existingLines + index + 1,
    score: SESSION_INGESTION_SCORE,
    snippet: entry.snippet,
    source: "memory",
    provenance: entry.provenance,
  }));
}
