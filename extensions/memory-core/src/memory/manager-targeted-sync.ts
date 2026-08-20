// Memory Core plugin module implements manager targeted sync behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySyncProgressUpdate } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type TargetedSyncProgress = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

type TargetedSessionSyncResult = { deferredSessionFiles?: Iterable<string> } | void;

function clearMemorySyncedArchiveFiles(params: {
  sessionsDirtyFiles: Set<string>;
  targetArchiveFiles?: Iterable<string> | null;
}): boolean {
  if (!params.targetArchiveFiles) {
    params.sessionsDirtyFiles.clear();
  } else {
    for (const targetArchiveFile of params.targetArchiveFiles) {
      params.sessionsDirtyFiles.delete(targetArchiveFile);
    }
  }
  return params.sessionsDirtyFiles.size > 0;
}

export function markMemoryTargetArchiveFilesDirty(params: {
  sessionsDirtyFiles: Set<string>;
  targetArchiveFiles?: Iterable<string> | null;
}): boolean {
  if (params.targetArchiveFiles) {
    for (const targetArchiveFile of params.targetArchiveFiles) {
      params.sessionsDirtyFiles.add(targetArchiveFile);
    }
  }
  return params.sessionsDirtyFiles.size > 0;
}

export async function runMemoryTargetedSessionSync(params: {
  hasSessionSource: boolean;
  targetArchiveFiles: Set<string> | null;
  reason?: string;
  progress?: TargetedSyncProgress;
  sessionsFullRetryDirty?: boolean;
  sessionsReconcileDirty?: boolean;
  sessionsDirtyFiles: Set<string>;
  syncArchiveFiles: (params: {
    needsFullReindex: boolean;
    targetArchiveFiles?: string[];
    progress?: TargetedSyncProgress;
  }) => Promise<TargetedSessionSyncResult>;
  shouldFallbackOnError: (err: unknown) => boolean;
  activateFallbackProvider: (reason: string) => Promise<boolean>;
}): Promise<{ handled: boolean; sessionsDirty: boolean }> {
  const hasPendingSessionWork = (hasDirtyFiles = params.sessionsDirtyFiles.size > 0) =>
    params.sessionsFullRetryDirty || params.sessionsReconcileDirty || hasDirtyFiles;
  if (!params.hasSessionSource || !params.targetArchiveFiles) {
    return {
      handled: false,
      sessionsDirty: hasPendingSessionWork(),
    };
  }

  try {
    const syncResult = await params.syncArchiveFiles({
      needsFullReindex: false,
      targetArchiveFiles: Array.from(params.targetArchiveFiles),
      progress: params.progress,
    });
    const remainingSessionsDirty = clearMemorySyncedArchiveFiles({
      sessionsDirtyFiles: params.sessionsDirtyFiles,
      targetArchiveFiles: params.targetArchiveFiles,
    });
    for (const sessionFile of syncResult?.deferredSessionFiles ?? []) {
      params.sessionsDirtyFiles.add(sessionFile);
    }
    return {
      handled: true,
      sessionsDirty: hasPendingSessionWork(
        remainingSessionsDirty || params.sessionsDirtyFiles.size > 0,
      ),
    };
  } catch (err) {
    const reason = formatErrorMessage(err);
    const activated =
      params.shouldFallbackOnError(err) && (await params.activateFallbackProvider(reason));
    if (!activated) {
      throw err;
    }
    const remainingSessionsDirty = markMemoryTargetArchiveFilesDirty({
      sessionsDirtyFiles: params.sessionsDirtyFiles,
      targetArchiveFiles: params.targetArchiveFiles,
    });
    return {
      handled: true,
      sessionsDirty: hasPendingSessionWork(remainingSessionsDirty),
    };
  }
}
