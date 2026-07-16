// Memory Core plugin module owns session event and delta synchronization.
import fs from "node:fs/promises";
import path from "node:path";
import {
  createSubsystemLogger,
  onInternalSessionTranscriptUpdate,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  listSessionTranscriptCorpusEntriesForAgent,
  parseCanonicalSessionSyncTargetFromPath,
  parseSqliteSessionFileMarker,
  resolveSessionFileForSyncTarget,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  isFileMissingError,
  retryTransientMemoryRead,
  runWithConcurrency,
  type MemorySessionSyncTarget,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";
import {
  resolveMemorySessionStartupDirtyFiles,
  type MemorySessionStartupFileState,
} from "./manager-session-sync-state.js";
import { loadMemorySourceFileState } from "./manager-source-state.js";
import { MemoryManagerWatchOps } from "./manager-watch-ops.js";

const SESSION_DIRTY_DEBOUNCE_MS = 5000;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const log = createSubsystemLogger("memory");

type MemorySessionTranscriptUpdate = {
  agentId?: string;
  sessionFile?: string;
  sessionKey?: string;
  target?: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
  };
};

export abstract class MemoryManagerSessionSyncOps extends MemoryManagerWatchOps {
  protected sessionPathForCorpusEntry(entry: SessionTranscriptCorpusEntry): string {
    return entry.transcriptSource === "sqlite"
      ? sessionPathForSessionIdentity(entry.agentId, entry.sessionId)
      : sessionPathForFile(entry.sessionFile);
  }

  protected legacyExtensionlessSessionPathForIdentity(agentId: string, sessionId: string): string {
    return path.join("sessions", normalizeAgentId(agentId), sessionId).replace(/\\/g, "/");
  }

  protected buildSessionEntryOptions(entry: SessionTranscriptCorpusEntry) {
    return {
      generatedByDreamingNarrative: entry.generatedByDreamingNarrative === true,
      generatedByCronRun: entry.generatedByCronRun === true,
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
    };
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = this.subscribeSessionTranscriptUpdates((update) => {
      if (this.closed) {
        return;
      }
      const sessionFile = update.sessionFile;
      if (sessionFile && isSessionArchiveArtifactName(path.basename(sessionFile))) {
        return;
      }
      if (sessionFile && this.isSessionFileForAgent(sessionFile)) {
        this.scheduleSessionDirty(sessionFile);
        return;
      }
      const target = this.resolveSessionTranscriptUpdateSyncTarget(update);
      if (target) {
        this.scheduleSessionDirty(target);
        return;
      }
      if (sessionFile) {
        void this.scheduleCorpusSessionFileDirty(sessionFile).catch((err: unknown) => {
          log.warn(`memory session corpus update failed: ${String(err)}`);
        });
      }
    });
  }

  protected subscribeSessionTranscriptUpdates(
    listener: (update: MemorySessionTranscriptUpdate) => void,
  ): () => void {
    return onInternalSessionTranscriptUpdate(listener);
  }

  private async scheduleCorpusSessionFileDirty(sessionFile: string): Promise<void> {
    const resolvedSessionFile = path.resolve(sessionFile);
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    if (corpusEntries.some((entry) => path.resolve(entry.sessionFile) === resolvedSessionFile)) {
      this.scheduleSessionDirty(resolvedSessionFile);
    }
  }

  protected ensureSessionStartupCatchup(): void {
    if (!this.sources.has("sessions")) {
      return;
    }
    void this.runSessionStartupCatchup().catch((err: unknown) => {
      log.warn("memory session startup catch-up failed: " + String(err));
    });
  }

  protected async markSessionStartupCatchupDirtyFiles(): Promise<string[]> {
    if (!this.sources.has("sessions") || this.closed) {
      return [];
    }
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    if (corpusEntries.length === 0 || this.closed) {
      return [];
    }
    const existingRows = loadMemorySourceFileState({
      db: this.db,
      source: "sessions",
    }).rows;
    const fileStates = (
      await runWithConcurrency(
        corpusEntries.map(
          (corpusEntry) => async (): Promise<MemorySessionStartupFileState | null> => {
            if (corpusEntry.transcriptSource === "sqlite") {
              return statSessionEntrySync(
                corpusEntry.sessionFile,
                this.buildSessionEntryOptions(corpusEntry),
              );
            }
            const file = corpusEntry.sessionFile;
            try {
              const stat = await fs.stat(file);
              if (!stat.isFile()) {
                return null;
              }
              return {
                absPath: file,
                path: this.sessionPathForCorpusEntry(corpusEntry),
                mtimeMs: stat.mtimeMs,
                size: stat.size,
              };
            } catch (err) {
              if (isFileMissingError(err)) {
                return null;
              }
              throw err;
            }
          },
        ),
        this.getIndexConcurrency(),
      )
    ).filter((file): file is MemorySessionStartupFileState => file !== null);
    const dirtyFiles = resolveMemorySessionStartupDirtyFiles({ files: fileStates, existingRows });
    if (dirtyFiles.length === 0 || this.closed) {
      return dirtyFiles;
    }
    for (const file of dirtyFiles) {
      this.sessionsDirtyFiles.add(file);
    }
    this.sessionsDirty = true;
    return dirtyFiles;
  }

  protected async runSessionStartupCatchup(): Promise<string[]> {
    const dirtyFiles = await this.markSessionStartupCatchupDirtyFiles();
    if (dirtyFiles.length === 0 || this.closed) {
      return dirtyFiles;
    }
    void this.sync({ reason: "session-startup-catchup" }).catch((err: unknown) => {
      log.warn("memory sync failed (session-startup-catchup): " + String(err));
    });
    return dirtyFiles;
  }

  private scheduleSessionDirty(target: string | MemorySessionSyncTarget) {
    if (typeof target === "string") {
      this.sessionPendingFiles.add(target);
    } else {
      this.sessionPendingTargets.set(this.memorySessionSyncTargetKey(target), target);
    }
    if (this.sessionWatchTimer) {
      return;
    }
    this.sessionWatchTimer = setTimeout(() => {
      this.sessionWatchTimer = null;
      void this.processSessionDeltaBatch().catch((err: unknown) => {
        log.warn(`memory session delta failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionDeltaBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0 && this.sessionPendingTargets.size === 0) {
      return;
    }
    const pending = Array.from(this.sessionPendingFiles);
    const pendingTargets = Array.from(this.sessionPendingTargets.values());
    this.sessionPendingFiles.clear();
    this.sessionPendingTargets.clear();
    pending.push(...Array.from(await this.resolveArchiveFilesForSyncTargets(pendingTargets)));
    let shouldSync = false;
    for (const sessionFile of pending) {
      if (!path.isAbsolute(sessionFile)) {
        this.sessionsDirtyFiles.add(sessionFile);
        this.sessionsDirty = true;
        shouldSync = true;
        continue;
      }
      // Usage-counted session archives (`.jsonl.reset.<iso>` and
      // `.jsonl.deleted.<iso>`) are one-shot mutation events: the file is
      // written once by the archive rotation and then never touched again.
      // They carry no incremental `append` semantics, so the delta-bytes /
      // delta-messages thresholds (designed for live transcripts accumulating
      // appended messages) cannot gate them correctly — a short archive
      // below the threshold would simply never reindex. Mark them dirty
      // directly and skip the delta accounting.
      const baseName = path.basename(sessionFile);
      if (
        isSessionArchiveArtifactName(baseName) &&
        isUsageCountedSessionTranscriptFileName(baseName)
      ) {
        this.sessionsDirtyFiles.add(sessionFile);
        this.sessionsDirty = true;
        shouldSync = true;
        continue;
      }
      const delta = await this.updateSessionDelta(sessionFile);
      if (!delta) {
        continue;
      }
      const bytesThreshold = delta.deltaBytes;
      const messagesThreshold = delta.deltaMessages;
      const bytesHit =
        bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
      const messagesHit =
        messagesThreshold <= 0
          ? delta.pendingMessages > 0
          : delta.pendingMessages >= messagesThreshold;
      if (!bytesHit && !messagesHit) {
        continue;
      }
      this.sessionsDirtyFiles.add(sessionFile);
      this.sessionsDirty = true;
      delta.pendingBytes =
        bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
      delta.pendingMessages =
        messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
      shouldSync = true;
    }
    if (shouldSync) {
      void this.sync({ reason: "session-delta" }).catch((err: unknown) => {
        log.warn(`memory sync failed (session-delta): ${String(err)}`);
      });
    }
  }

  private async updateSessionDelta(sessionFile: string): Promise<{
    deltaBytes: number;
    deltaMessages: number;
    pendingBytes: number;
    pendingMessages: number;
  } | null> {
    const thresholds = this.settings.sync.sessions;
    if (!thresholds) {
      return null;
    }
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }
    const size = stat.size;
    let state = this.sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }
    const deltaBytes = Math.max(0, size - state.lastSize);
    if (deltaBytes === 0 && size === state.lastSize) {
      return {
        deltaBytes: thresholds.deltaBytes,
        deltaMessages: thresholds.deltaMessages,
        pendingBytes: state.pendingBytes,
        pendingMessages: state.pendingMessages,
      };
    }
    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
    } else {
      state.pendingBytes += deltaBytes;
      const shouldCountMessages =
        thresholds.deltaMessages > 0 &&
        (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes);
      if (shouldCountMessages) {
        state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
      }
      state.lastSize = size;
    }
    this.sessionDeltas.set(sessionFile, state);
    return {
      deltaBytes: thresholds.deltaBytes,
      deltaMessages: thresholds.deltaMessages,
      pendingBytes: state.pendingBytes,
      pendingMessages: state.pendingMessages,
    };
  }

  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    let handle;
    try {
      handle = await retryTransientMemoryRead(
        () => fs.open(absPath, "r"),
        `open session transcript for newline count ${absPath}`,
      );
    } catch (err) {
      if (isFileMissingError(err)) {
        return 0;
      }
      throw err;
    }
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await retryTransientMemoryRead(
          () => handle.read(buffer, 0, toRead, offset),
          `count session transcript newlines ${absPath}`,
        );
        if (bytesRead <= 0) {
          break;
        }
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }
      return count;
    } finally {
      await handle.close();
    }
  }

  protected resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private isSessionFileForAgent(sessionFile: string): boolean {
    if (!sessionFile) {
      return false;
    }
    const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
    const resolvedFile = path.resolve(sessionFile);
    const resolvedDir = path.resolve(sessionsDir);
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
  }

  private resolveSessionTranscriptUpdateSyncTarget(
    update: MemorySessionTranscriptUpdate,
  ): MemorySessionSyncTarget | null {
    if (update.sessionFile && isSessionArchiveArtifactName(path.basename(update.sessionFile))) {
      return null;
    }
    if (update.target) {
      const agentId = update.target.agentId.trim();
      const sessionId = update.target.sessionId.trim();
      const sessionKey = update.target.sessionKey.trim();
      if (!agentId || !sessionId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
        return null;
      }
      return {
        agentId,
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
      };
    }
    if (!update.sessionFile) {
      return null;
    }
    const parsed = parseCanonicalSessionSyncTargetFromPath(update.sessionFile);
    if (!parsed) {
      return null;
    }
    const agentId = update.agentId?.trim() || parsed.agentId;
    if (!agentId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
      return null;
    }
    const sessionKey = update.sessionKey?.trim();
    return {
      agentId,
      sessionId: parsed.sessionId,
      ...(sessionKey ? { sessionKey } : {}),
    };
  }

  protected normalizeTargetArchiveFiles(
    archiveFiles?: string[],
    corpusEntries: readonly SessionTranscriptCorpusEntry[] = [],
  ): Set<string> | null {
    if (!archiveFiles || archiveFiles.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    const corpusMarkers = new Set(
      corpusEntries
        .filter((entry) => entry.transcriptSource === "sqlite")
        .map((entry) => entry.sessionFile),
    );
    const corpusPaths = new Set(
      corpusEntries
        .filter((entry) => entry.transcriptSource !== "sqlite")
        .map((entry) => path.resolve(entry.sessionFile)),
    );
    for (const sessionFile of archiveFiles) {
      const trimmed = sessionFile.trim();
      if (!trimmed) {
        continue;
      }
      if (corpusMarkers.has(trimmed)) {
        normalized.add(trimmed);
        continue;
      }
      const sqliteMarker = parseSqliteSessionFileMarker(trimmed);
      if (
        sqliteMarker &&
        normalizeAgentId(sqliteMarker.agentId) === normalizeAgentId(this.agentId)
      ) {
        normalized.add(trimmed);
        continue;
      }
      const resolved = path.resolve(trimmed);
      if (
        this.isSessionFileForAgent(resolved) &&
        parseCanonicalSessionSyncTargetFromPath(resolved)
      ) {
        normalized.add(resolved);
        continue;
      }
      if (corpusPaths.has(resolved)) {
        normalized.add(resolved);
      }
    }
    return normalized.size > 0 ? normalized : null;
  }

  private normalizeTargetSessions(
    sessions?: MemorySessionSyncTarget[],
  ): Map<string, MemorySessionSyncTarget> | null {
    if (!sessions || sessions.length === 0) {
      return null;
    }
    const normalized = new Map<string, MemorySessionSyncTarget>();
    for (const session of sessions) {
      const sessionId = session.sessionId.trim();
      const agentId = session.agentId?.trim() || this.agentId;
      if (!sessionId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
        continue;
      }
      const sessionKey = session.sessionKey?.trim();
      const target = {
        agentId,
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
      };
      normalized.set(this.memorySessionSyncTargetKey(target), target);
    }
    return normalized.size > 0 ? normalized : null;
  }

  private async resolveArchiveFilesForSyncTargets(
    sessions?: Iterable<MemorySessionSyncTarget> | null,
    knownCorpusEntries?: readonly SessionTranscriptCorpusEntry[],
  ): Promise<Set<string>> {
    const files = new Set<string>();
    const targets = Array.from(sessions ?? []);
    if (targets.length === 0) {
      return files;
    }
    const corpusEntries =
      knownCorpusEntries ?? (await listSessionTranscriptCorpusEntriesForAgent(this.agentId));
    for (const session of targets) {
      const sessionKey = session.sessionKey?.trim();
      let matchedCorpusEntry = false;
      for (const entry of corpusEntries) {
        if (normalizeAgentId(entry.agentId) !== normalizeAgentId(this.agentId)) {
          continue;
        }
        if (entry.sessionId !== session.sessionId) {
          continue;
        }
        if (sessionKey && entry.sessionKey !== sessionKey) {
          continue;
        }
        files.add(
          entry.transcriptSource === "sqlite" ? entry.sessionFile : path.resolve(entry.sessionFile),
        );
        matchedCorpusEntry = true;
      }
      if (matchedCorpusEntry) {
        continue;
      }
      const resolved = resolveSessionFileForSyncTarget(session, this.agentId);
      if (!resolved || normalizeAgentId(resolved.agentId) !== normalizeAgentId(this.agentId)) {
        continue;
      }
      const sessionFile = path.resolve(resolved.sessionFile);
      if (
        this.isSessionFileForAgent(sessionFile) &&
        parseCanonicalSessionSyncTargetFromPath(sessionFile)
      ) {
        files.add(sessionFile);
      }
    }
    return files;
  }

  protected async combineTargetArchiveFiles(params: {
    sessions?: MemorySessionSyncTarget[];
    archiveFiles?: string[];
  }): Promise<Set<string> | null> {
    const files = new Set<string>();
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    for (const file of this.normalizeTargetArchiveFiles(params.archiveFiles, corpusEntries) ?? []) {
      files.add(file);
    }
    for (const file of await this.resolveArchiveFilesForSyncTargets(
      this.normalizeTargetSessions(params.sessions)?.values(),
      corpusEntries,
    )) {
      files.add(file);
    }
    return files.size > 0 ? files : null;
  }

  private memorySessionSyncTargetKey(target: MemorySessionSyncTarget): string {
    return [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0");
  }

  protected shouldSyncSessions(params?: MemorySyncParams, needsFullReindex = false) {
    return shouldSyncSessionsForReindex({
      hasSessionSource: this.sources.has("sessions"),
      sessionsDirty: this.sessionsDirty,
      sessionsFullRetryDirty: this.sessionsFullRetryDirty,
      dirtySessionFileCount: this.sessionsDirtyFiles.size,
      sync: params,
      needsFullReindex,
    });
  }
}
