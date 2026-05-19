import fs from "node:fs/promises";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];

type FileStatLike = {
  isFile?: unknown;
  nlink?: unknown;
};

function isRegularFileStat(value: unknown): value is FileStatLike & { nlink: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stat = value as FileStatLike;
  const isFile =
    typeof stat.isFile === "function"
      ? (stat.isFile as () => boolean).call(stat)
      : stat.isFile === true;
  return isFile && typeof stat.nlink === "number";
}

export async function writeImportedSourcePage(params: {
  vaultRoot: string;
  syncKey: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  pagePath: string;
  group: MemoryWikiImportedSourceGroup;
  state: ImportedSourceState;
  buildRendered: (raw: string, updatedAt: string) => string;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const vault = await fsRoot(params.vaultRoot);
  const pageStat = await vault.stat(params.pagePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
  const created = !pageStat;
  const updatedAt = new Date(params.sourceUpdatedAtMs).toISOString();
  const shouldSkip = await shouldSkipImportedSourceWrite({
    vaultRoot: params.vaultRoot,
    syncKey: params.syncKey,
    expectedPagePath: params.pagePath,
    expectedSourcePath: params.sourcePath,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    sourceSize: params.sourceSize,
    renderFingerprint: params.renderFingerprint,
    state: params.state,
  });
  if (shouldSkip) {
    return { pagePath: params.pagePath, changed: false, created };
  }

  const raw = await fs.readFile(params.sourcePath, "utf8");
  const rendered = params.buildRendered(raw, updatedAt);
  const existing = pageStat ? await vault.readText(params.pagePath).catch(() => "") : "";
  if (existing !== rendered) {
    try {
      if (isRegularFileStat(pageStat) && pageStat.nlink > 1) {
        await vault.remove(params.pagePath);
      }
      await vault.write(params.pagePath, rendered);
    } catch (error) {
      if (error instanceof FsSafeError) {
        if (error.code !== "symlink" && error.code !== "path-alias") {
          throw new Error(
            `Refusing to write imported source page (${error.code}): ${params.pagePath}: ${error.message}`,
            { cause: error },
          );
        }
        throw new Error(
          `Refusing to write imported source page through symlink: ${params.pagePath}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  setImportedSourceEntry({
    syncKey: params.syncKey,
    state: params.state,
    entry: {
      group: params.group,
      pagePath: params.pagePath,
      sourcePath: params.sourcePath,
      sourceUpdatedAtMs: params.sourceUpdatedAtMs,
      sourceSize: params.sourceSize,
      renderFingerprint: params.renderFingerprint,
    },
  });
  return { pagePath: params.pagePath, changed: existing !== rendered, created };
}
