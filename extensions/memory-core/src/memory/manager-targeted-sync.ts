import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySyncProgressUpdate } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type TargetedSyncProgress = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

export function clearMemorySyncedSessionFiles(params: {
  sessionsDirtyFiles: Set<string>;
  targetSessionFiles?: Iterable<string> | null;
}): boolean {
  if (!params.targetSessionFiles) {
    params.sessionsDirtyFiles.clear();
  } else {
    for (const targetSessionFile of params.targetSessionFiles) {
      params.sessionsDirtyFiles.delete(targetSessionFile);
    }
  }
  return params.sessionsDirtyFiles.size > 0;
}

export async function runMemoryTargetedSessionSync(params: {
  hasSessionSource: boolean;
  targetSessionFiles: Set<string> | null;
  reason?: string;
  progress?: TargetedSyncProgress;
  useUnsafeReindex: boolean;
  sessionsDirtyFiles: Set<string>;
  syncSessionFiles: (params: {
    needsFullReindex: boolean;
    targetSessionFiles?: string[];
    progress?: TargetedSyncProgress;
  }) => Promise<void>;
  shouldFallbackOnError: (message: string) => boolean;
  activateFallbackProvider: (reason: string) => Promise<boolean>;
  runSafeReindex: (params: {
    reason?: string;
    force?: boolean;
    progress?: TargetedSyncProgress;
  }) => Promise<void>;
  runUnsafeReindex: (params: {
    reason?: string;
    force?: boolean;
    progress?: TargetedSyncProgress;
  }) => Promise<void>;
}): Promise<{ handled: boolean; sessionsDirty: boolean }> {
  if (!params.hasSessionSource || !params.targetSessionFiles) {
    return {
      handled: false,
      sessionsDirty: params.sessionsDirtyFiles.size > 0,
    };
  }

  try {
    await params.syncSessionFiles({
      needsFullReindex: false,
      targetSessionFiles: Array.from(params.targetSessionFiles),
      progress: params.progress,
    });
    return {
      handled: true,
      sessionsDirty: clearMemorySyncedSessionFiles({
        sessionsDirtyFiles: params.sessionsDirtyFiles,
        targetSessionFiles: params.targetSessionFiles,
      }),
    };
  } catch (err) {
    const reason = formatErrorMessage(err);
    const activated =
      params.shouldFallbackOnError(reason) && (await params.activateFallbackProvider(reason));
    if (!activated) {
      throw err;
    }
    const reindexParams = {
      reason: params.reason,
      force: true,
      progress: params.progress,
    };
    if (params.useUnsafeReindex) {
      await params.runUnsafeReindex(reindexParams);
    } else {
      await params.runSafeReindex(reindexParams);
    }
    return {
      handled: true,
      sessionsDirty: params.sessionsDirtyFiles.size > 0,
    };
  }
}
