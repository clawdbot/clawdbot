export function shouldSyncSessionsForReindex(params: {
  hasSessionSource: boolean;
  sessionsDirty: boolean;
  dirtySessionFileCount: number;
  sync?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
  };
  needsFullReindex?: boolean;
}): boolean {
  if (!params.hasSessionSource) {
    return false;
  }
  if (params.sync?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) {
    return true;
  }
  if (params.sync?.force) {
    return true;
  }
  if (params.needsFullReindex) {
    return true;
  }
  const reason = params.sync?.reason;
  if (reason === "session-start" || reason === "watch") {
    return false;
  }
  return params.sessionsDirty && params.dirtySessionFileCount > 0;
}
