import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";

export type MemoryWikiImportedSourceGroup = "bridge" | "unsafe-local";

type MemoryWikiImportedSourceStateEntry = {
  group: MemoryWikiImportedSourceGroup;
  pagePath: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
};

type MemoryWikiImportedSourceState = {
  version: 1;
  entries: Record<string, MemoryWikiImportedSourceStateEntry>;
};

const EMPTY_STATE: MemoryWikiImportedSourceState = {
  version: 1,
  entries: {},
};

function resolveMemoryWikiSourceSyncStatePath(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
}

export async function readMemoryWikiSourceSyncState(
  vaultRoot: string,
): Promise<MemoryWikiImportedSourceState> {
  const statePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
  const { value: parsed } = await readJsonFileWithFallback<Partial<MemoryWikiImportedSourceState>>(
    statePath,
    EMPTY_STATE,
  );
  return {
    version: 1,
    entries: { ...parsed.entries },
  };
}

export async function writeMemoryWikiSourceSyncState(
  vaultRoot: string,
  state: MemoryWikiImportedSourceState,
): Promise<void> {
  const statePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
  await writeJsonFileAtomically(statePath, state);
}

export async function shouldSkipImportedSourceWrite(params: {
  vaultRoot: string;
  syncKey: string;
  expectedPagePath: string;
  expectedSourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  state: MemoryWikiImportedSourceState;
}): Promise<boolean> {
  const entry = params.state.entries[params.syncKey];
  if (!entry) {
    return false;
  }
  if (
    entry.pagePath !== params.expectedPagePath ||
    entry.sourcePath !== params.expectedSourcePath ||
    entry.sourceUpdatedAtMs !== params.sourceUpdatedAtMs ||
    entry.sourceSize !== params.sourceSize ||
    entry.renderFingerprint !== params.renderFingerprint
  ) {
    return false;
  }
  const pagePath = path.join(params.vaultRoot, params.expectedPagePath);
  return await fs
    .access(pagePath)
    .then(() => true)
    .catch(() => false);
}

export async function pruneImportedSourceEntries(params: {
  vaultRoot: string;
  group: MemoryWikiImportedSourceGroup;
  activeKeys: Set<string>;
  state: MemoryWikiImportedSourceState;
}): Promise<number> {
  let removedCount = 0;
  for (const [syncKey, entry] of Object.entries(params.state.entries)) {
    if (entry.group !== params.group || params.activeKeys.has(syncKey)) {
      continue;
    }
    const pageAbsPath = path.join(params.vaultRoot, entry.pagePath);
    await fs.rm(pageAbsPath, { force: true }).catch(() => undefined);
    delete params.state.entries[syncKey];
    removedCount += 1;
  }
  return removedCount;
}

export function setImportedSourceEntry(params: {
  syncKey: string;
  entry: MemoryWikiImportedSourceStateEntry;
  state: MemoryWikiImportedSourceState;
}): void {
  params.state.entries[params.syncKey] = params.entry;
}
