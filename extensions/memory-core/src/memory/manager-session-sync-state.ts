import { type MemorySourceFileStateRow } from "./manager-source-state.js";

export type MemorySessionStartupFileState = {
  absPath: string;
  path: string;
  mtimeMs: number;
  size: number;
};

export function resolveMemorySessionStartupDirtyFiles(params: {
  files: MemorySessionStartupFileState[];
  existingRows?: MemorySourceFileStateRow[] | null;
}): string[] {
  const indexedRows = new Map((params.existingRows ?? []).map((row) => [row.path, row]));
  const dirtyFiles: string[] = [];
  for (const file of params.files) {
    const existing = indexedRows.get(file.path);
    if (!existing) {
      dirtyFiles.push(file.absPath);
      continue;
    }
    const indexedMtimeMs = Number(existing.mtime);
    const indexedSize = Number(existing.size);
    if (!Number.isFinite(indexedMtimeMs) || !Number.isFinite(indexedSize)) {
      dirtyFiles.push(file.absPath);
      continue;
    }
    if (file.size !== indexedSize || file.mtimeMs > indexedMtimeMs) {
      dirtyFiles.push(file.absPath);
    }
  }
  return dirtyFiles;
}

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
