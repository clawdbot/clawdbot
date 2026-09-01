// Memory Core plugin module owns session event and delta synchronization.
import fs from "node:fs/promises";
import path from "node:path";
import {
  createSubsystemLogger,
  onInternalSessionTranscriptUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  loadArchivedSessions,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  isFileMissingError,
  runWithConcurrency,
  type MemorySessionSyncTarget,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { listMemorySessionTombstones } from "../memory-entry-origins.js";
import { runInMemoryBackgroundContext } from "./background-context.js";
import { shouldSyncSessionsForReindex } from "./manager-session-reindex.js";
import {
  isMemorySessionIndexable,
  resolveMemorySessionStartupState,
  type MemorySessionStartupFileState,
} from "./manager-session-sync-state.js";
import { inspectMemorySourceState, loadMemorySourceFileState } from "./manager-source-state.js";
import { MemoryManagerWatchOps } from "./manager-watch-ops.js";

const SESSION_DIRTY_DEBOUNCE_MS = 5000;
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
  protected async inspectDiagnosticSourceState(): Promise<void> {
    if (this.sources.has("memory")) {
      try {
        const inspection = await inspectMemorySourceState({
          db: this.db,
          workspaceDir: this.workspaceDir,
          settings: this.settings,
          concurrency: this.getIndexConcurrency(),
        });
        this.sourceInspections.set("memory", inspection);
        this.dirty ||= inspection.dirty;
      } catch (error) {
        this.sourceInspections.set("memory", { eligible: null, issues: [String(error)] });
        this.dirty = true;
      }
    }
    if (this.sources.has("sessions")) {
      try {
        await this.markSessionStartupCatchupDirtyFiles(true);
      } catch (error) {
        this.sourceInspections.set("sessions", { eligible: null, issues: [String(error)] });
        this.sessionsDirty = true;
      }
    }
  }

  protected async listSessionCorpusEntries(): Promise<SessionTranscriptCorpusEntry[]> {
    const entries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    const archivedSessions = new Map(
      loadArchivedSessions({
        agentId: this.agentId,
        storePath: resolveStorePath(this.cfg.session?.store, { agentId: this.agentId }),
        sessionIds: entries
          .filter((entry) => entry.artifactKind === "archive-artifact")
          .map((entry) => entry.sessionId),
      }).map((archive) => [archive.archiveName, archive]),
    );
    const forgottenSessions = new Set(
      listMemorySessionTombstones({
        agentId: this.agentId,
        sessionIds: entries.map((entry) => entry.sessionId),
      }).map((entry) => entry.sessionId),
    );
    return entries.filter((entry) => {
      const archive = archivedSessions.get(path.basename(entry.sessionFile));
      const archivedSessionKey =
        archive?.sessionId === entry.sessionId ? archive.sessionKey : undefined;
      return (
        !forgottenSessions.has(entry.sessionId) &&
        isMemorySessionIndexable(entry, archivedSessionKey)
      );
    });
  }

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
      ...(entry.sessionKind ? { sessionKind: entry.sessionKind } : {}),
      ...(entry.transcriptSource === "sqlite" && entry.storePath
        ? {
            agentId: entry.agentId,
            sessionId: entry.sessionId,
            storePath: entry.storePath,
          }
        : {}),
      ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
    };
  }

  protected ensureSessionListener() {
    if (!this.sources.has("sessions") || this.sessionUnsubscribe) {
      return;
    }
    this.sessionUnsubscribe = this.subscribeSessionTranscriptUpdates((update) =>
      runInMemoryBackgroundContext(() => {
        if (this.closed) {
          return;
        }
        const target = this.resolveSessionTranscriptUpdateSyncTarget(update);
        if (target) {
          this.scheduleSessionDirty(target);
          return;
        }
        if (update.sessionFile) {
          void this.scheduleCorpusSessionFileDirty(update.sessionFile).catch((err: unknown) => {
            log.warn(`memory session corpus update failed: ${String(err)}`);
          });
        }
      }),
    );
  }

  protected subscribeSessionTranscriptUpdates(
    listener: (update: MemorySessionTranscriptUpdate) => void,
  ): () => void {
    return onInternalSessionTranscriptUpdate(listener);
  }

  private async scheduleCorpusSessionFileDirty(sessionFile: string): Promise<void> {
    const resolvedSessionFile = path.resolve(sessionFile);
    const corpusEntries = await this.listSessionCorpusEntries();
    if (
      corpusEntries.some(
        (entry) =>
          entry.transcriptSource !== "sqlite" &&
          path.resolve(entry.sessionFile) === resolvedSessionFile,
      )
    ) {
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

  protected async markSessionStartupCatchupDirtyFiles(inspectSources = false): Promise<string[]> {
    if (!this.sources.has("sessions") || this.closed) {
      return [];
    }
    const corpusEntries = await this.listSessionCorpusEntries();
    if (this.closed) {
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
    const { dirtyFiles, hasStaleIndexedPaths } = resolveMemorySessionStartupState({
      files: fileStates,
      existingRows,
    });
    if (inspectSources) {
      this.sourceInspections.set("sessions", {
        eligible: fileStates.length,
        issues: fileStates.length === 0 ? ["no eligible session transcripts found"] : [],
      });
    }
    if (this.closed) {
      return dirtyFiles;
    }
    if (hasStaleIndexedPaths) {
      this.sessionsDirty = true;
      this.sessionsReconcileDirty = true;
    }
    for (const file of dirtyFiles) {
      this.sessionsDirtyFiles.add(file);
    }
    if (dirtyFiles.length > 0) {
      this.sessionsDirty = true;
    }
    return dirtyFiles;
  }

  protected async runSessionStartupCatchup(): Promise<string[]> {
    const dirtyFiles = await this.markSessionStartupCatchupDirtyFiles();
    if (!this.sessionsDirty || this.closed) {
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
      void this.processSessionUpdateBatch().catch((err: unknown) => {
        log.warn(`memory session update failed: ${String(err)}`);
      });
    }, SESSION_DIRTY_DEBOUNCE_MS);
  }

  private async processSessionUpdateBatch(): Promise<void> {
    if (this.sessionPendingFiles.size === 0 && this.sessionPendingTargets.size === 0) {
      return;
    }
    const pending = Array.from(this.sessionPendingFiles);
    const pendingTargets = Array.from(this.sessionPendingTargets.values());
    this.sessionPendingFiles.clear();
    this.sessionPendingTargets.clear();
    pending.push(...Array.from(await this.resolveArchiveFilesForSyncTargets(pendingTargets)));
    for (const sessionFile of pending) {
      this.sessionsDirtyFiles.add(sessionFile);
    }
    if (pending.length > 0) {
      this.sessionsDirty = true;
      // Keep both identity and file keys so every transcript backend enters the
      // targeted queue instead of letting an active sync clear this newer event.
      void this.sync({
        reason: "session-delta",
        sessions: pendingTargets,
        archiveFiles: pending,
      }).catch((err: unknown) => {
        log.warn(`memory sync failed (session update): ${String(err)}`);
      });
    }
  }

  private resolveSessionTranscriptUpdateSyncTarget(
    update: MemorySessionTranscriptUpdate,
  ): MemorySessionSyncTarget | null {
    if (!update.target) {
      return null;
    }
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

  protected normalizeTargetArchiveFiles(
    archiveFiles?: string[],
    corpusEntries: readonly SessionTranscriptCorpusEntry[] = [],
    includeSqlite = false,
  ): Set<string> | null {
    if (!archiveFiles || archiveFiles.length === 0) {
      return null;
    }
    const normalized = new Set<string>();
    const corpusPaths = new Map(
      corpusEntries
        .filter((entry) => includeSqlite || entry.transcriptSource !== "sqlite")
        .map((entry) => [
          entry.transcriptSource === "sqlite" ? entry.sessionFile : path.resolve(entry.sessionFile),
          entry.sessionFile,
        ]),
    );
    for (const sessionFile of archiveFiles) {
      const trimmed = sessionFile.trim();
      if (!trimmed) {
        continue;
      }
      const corpusPath = corpusPaths.get(trimmed) ?? corpusPaths.get(path.resolve(trimmed));
      if (corpusPath) {
        normalized.add(corpusPath);
      }
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
    const corpusEntries = knownCorpusEntries ?? (await this.listSessionCorpusEntries());
    for (const rawSession of targets) {
      const sessionId = rawSession.sessionId.trim();
      const agentId = rawSession.agentId?.trim() || this.agentId;
      if (!sessionId || normalizeAgentId(agentId) !== normalizeAgentId(this.agentId)) {
        continue;
      }
      const sessionKey = rawSession.sessionKey?.trim();
      const matchingEntries = corpusEntries.filter(
        (entry) =>
          normalizeAgentId(entry.agentId) === normalizeAgentId(this.agentId) &&
          entry.sessionId === sessionId &&
          (!sessionKey || entry.sessionKey === sessionKey),
      );
      for (const entry of matchingEntries) {
        files.add(
          entry.transcriptSource === "sqlite" ? entry.sessionFile : path.resolve(entry.sessionFile),
        );
      }
    }
    return files;
  }

  protected async resolveTargetSessionSyncPlan(params: {
    sessions?: MemorySessionSyncTarget[];
    archiveFiles?: string[];
  }) {
    const files = new Set<string>();
    const corpusEntries = await this.listSessionCorpusEntries();
    for (const file of this.normalizeTargetArchiveFiles(params.archiveFiles, corpusEntries) ?? []) {
      files.add(file);
    }
    for (const file of await this.resolveArchiveFilesForSyncTargets(
      params.sessions,
      corpusEntries,
    )) {
      files.add(file);
    }
    return files.size > 0 ? { corpusEntries, targetArchiveFiles: files } : null;
  }

  private memorySessionSyncTargetKey(target: MemorySessionSyncTarget): string {
    return [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0");
  }

  protected shouldSyncSessions(params?: MemorySyncParams, needsFullReindex = false) {
    return shouldSyncSessionsForReindex({
      hasSessionSource: this.sources.has("sessions"),
      sessionsDirty: this.sessionsDirty,
      sessionsFullRetryDirty: this.sessionsFullRetryDirty,
      sync: params,
      needsFullReindex,
    });
  }
}
