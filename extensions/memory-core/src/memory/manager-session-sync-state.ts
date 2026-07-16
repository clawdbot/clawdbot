import { type MemorySourceFileStateRow } from "./manager-source-state.js";

export function resolveMemorySessionSyncPlan(params: {
  needsFullReindex: boolean;
  files: string[];
  targetSessionFiles: Set<string> | null;
  sessionsDirtyFiles: Set<string>;
  existingRows?: MemorySourceFileStateRow[] | null;
  sessionPathForFile: (file: string) => string;
}): {
  activePaths: Set<string> | null;
  existingRows: MemorySourceFileStateRow[] | null;
  existingHashes: Map<string, string> | null;
  indexAll: boolean;
} {
  const activePaths = params.targetSessionFiles
    ? null
    : new Set(params.files.map((file) => params.sessionPathForFile(file)));
  const existingRows = activePaths === null ? null : (params.existingRows ?? []);
  return {
    activePaths,
    existingRows,
    existingHashes: existingRows ? new Map(existingRows.map((row) => [row.path, row.hash])) : null,
    indexAll:
      params.needsFullReindex ||
      Boolean(params.targetSessionFiles) ||
      params.sessionsDirtyFiles.size === 0,
  };
}
