// Memory Core plugin module implements manager sync control behavior.
import type {
  MemorySessionSyncTarget,
  MemorySyncParams,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function enqueueMemoryTargetedSessionSync(
  state: {
    isClosed: () => boolean;
    getSyncing: () => Promise<void> | null;
    getQueuedArchiveFiles: () => Set<string>;
    getQueuedSessions: () => Map<string, MemorySessionSyncTarget>;
    getQueuedForce: () => boolean;
    setQueuedForce: (value: boolean) => void;
    getQueuedProgressCallbacks: () => Set<NonNullable<MemorySyncParams["progress"]>>;
    getQueuedSessionSync: () => Promise<void> | null;
    setQueuedSessionSync: (value: Promise<void> | null) => void;
    sync: (params?: MemorySyncParams) => Promise<void>;
  },
  targets?: Pick<MemorySyncParams, "sessions" | "archiveFiles" | "force" | "progress">,
): Promise<void> {
  const queuedArchiveFiles = state.getQueuedArchiveFiles();
  for (const sessionFile of targets?.archiveFiles ?? []) {
    const trimmed = sessionFile.trim();
    if (trimmed) {
      queuedArchiveFiles.add(trimmed);
    }
  }
  const queuedSessions = state.getQueuedSessions();
  for (const session of targets?.sessions ?? []) {
    const normalized = normalizeQueuedMemorySessionSyncTarget(session);
    if (normalized) {
      queuedSessions.set(memorySessionSyncTargetKey(normalized), normalized);
    }
  }
  if (queuedArchiveFiles.size === 0 && queuedSessions.size === 0) {
    return state.getSyncing() ?? Promise.resolve();
  }
  if (targets?.force) {
    state.setQueuedForce(true);
  }
  if (targets?.progress) {
    state.getQueuedProgressCallbacks().add(targets.progress);
  }
  if (!state.getQueuedSessionSync()) {
    state.setQueuedSessionSync(
      (async () => {
        try {
          await state.getSyncing()?.catch(() => undefined);
          while (
            !state.isClosed() &&
            (state.getQueuedArchiveFiles().size > 0 || state.getQueuedSessions().size > 0)
          ) {
            const pendingArchiveFiles = Array.from(state.getQueuedArchiveFiles());
            const pendingSessions = Array.from(state.getQueuedSessions().values());
            const pendingForce = state.getQueuedForce();
            const pendingProgressCallbacks = Array.from(state.getQueuedProgressCallbacks());
            state.getQueuedArchiveFiles().clear();
            state.getQueuedSessions().clear();
            state.setQueuedForce(false);
            state.getQueuedProgressCallbacks().clear();
            const progress =
              pendingProgressCallbacks.length > 0
                ? (update: MemorySyncProgressUpdate) => {
                    for (const callback of pendingProgressCallbacks) {
                      callback(update);
                    }
                  }
                : undefined;
            try {
              await state.sync({
                reason: "queued-sessions",
                ...(pendingForce ? { force: true } : {}),
                sessions: pendingSessions,
                archiveFiles: pendingArchiveFiles,
                ...(progress ? { progress } : {}),
              });
            } catch (err) {
              // Merge the failed batch with arrivals queued during sync so the
              // next trigger can retry every target instead of dropping work.
              for (const archiveFile of pendingArchiveFiles) {
                state.getQueuedArchiveFiles().add(archiveFile);
              }
              for (const session of pendingSessions) {
                state.getQueuedSessions().set(memorySessionSyncTargetKey(session), session);
              }
              if (pendingForce) {
                state.setQueuedForce(true);
              }
              // Every caller awaiting this queue owner receives the rejection.
              // Do not retain callbacks that could otherwise fire after their
              // originating promise has already failed.
              state.getQueuedProgressCallbacks().clear();
              throw err;
            }
          }
        } finally {
          if (state.isClosed()) {
            // A closed manager cannot drain retained work. Release every
            // manager-owned target and caller closure with the queue owner.
            state.getQueuedArchiveFiles().clear();
            state.getQueuedSessions().clear();
            state.setQueuedForce(false);
            state.getQueuedProgressCallbacks().clear();
          }
          state.setQueuedSessionSync(null);
        }
      })(),
    );
  }
  return state.getQueuedSessionSync() ?? Promise.resolve();
}

function normalizeQueuedMemorySessionSyncTarget(
  target: MemorySessionSyncTarget,
): MemorySessionSyncTarget | null {
  const sessionId = target.sessionId.trim();
  if (!sessionId) {
    return null;
  }
  const agentId = target.agentId?.trim();
  const sessionKey = target.sessionKey?.trim();
  return {
    ...(agentId ? { agentId } : {}),
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function memorySessionSyncTargetKey(target: MemorySessionSyncTarget): string {
  return [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0");
}
