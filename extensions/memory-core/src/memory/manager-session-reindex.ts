// Memory Core plugin module implements manager session reindex behavior.
import type { MemorySyncParams } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function shouldSyncSessionsForReindex(params: {
  hasSessionSource: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty?: boolean;
  dirtySessionFileCount: number;
  sync?: MemorySyncParams;
  needsFullReindex?: boolean;
}): boolean {
  if (!params.hasSessionSource) {
    return false;
  }
  if (params.sync?.sessions?.some((session) => session.sessionId.trim().length > 0)) {
    return true;
  }
  if (params.sync?.archiveFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
    return true;
  }
  if (params.sync?.force) {
    return true;
  }
  if (params.needsFullReindex) {
    return true;
  }
  if (params.sessionsFullRetryDirty) {
    return true;
  }
  const reason = params.sync?.reason;
  if (reason === "session-start" || reason === "watch") {
    return false;
  }
  return params.sessionsDirty && params.dirtySessionFileCount > 0;
}
