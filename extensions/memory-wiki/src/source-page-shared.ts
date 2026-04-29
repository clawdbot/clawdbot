import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];
type FileStats = Awaited<ReturnType<typeof fs.lstat>>;

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveWritableVaultPagePath(params: {
  vaultRoot: string;
  pagePath: string;
}): Promise<{
  pageAbsPath: string;
  pageDir: string;
  pageDirRealPath: string;
  vaultRealPath: string;
  existing: FileStats | null;
}> {
  const vaultAbsPath = path.resolve(params.vaultRoot);
  const pageAbsPath = path.resolve(vaultAbsPath, params.pagePath);
  if (!isPathInside(vaultAbsPath, pageAbsPath)) {
    throw new Error(`Refusing to write imported source page outside vault: ${params.pagePath}`);
  }

  const vaultRealPath = await fs.realpath(vaultAbsPath);
  const pageDir = path.dirname(pageAbsPath);
  await fs.mkdir(pageDir, { recursive: true });
  const pageDirRealPath = await fs.realpath(pageDir);
  if (!isPathInside(vaultRealPath, pageDirRealPath)) {
    throw new Error(`Refusing to write imported source page outside vault: ${params.pagePath}`);
  }

  const existing = await fs.lstat(pageAbsPath).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to write imported source page through symlink: ${params.pagePath}`);
  }
  if (existing && !existing.isFile()) {
    throw new Error(`Refusing to write imported source page over non-file: ${params.pagePath}`);
  }
  return { pageAbsPath, pageDir, pageDirRealPath, vaultRealPath, existing };
}

async function assertWritablePageDir(params: {
  pageDir: string;
  pageDirRealPath: string;
  vaultRealPath: string;
  pagePath: string;
}): Promise<void> {
  const currentPageDirRealPath = await fs.realpath(params.pageDir);
  if (
    currentPageDirRealPath !== params.pageDirRealPath ||
    !isPathInside(params.vaultRealPath, currentPageDirRealPath)
  ) {
    throw new Error(`Refusing to write imported source page outside vault: ${params.pagePath}`);
  }
}

async function validateDestinationForReplace(filePath: string, pagePath: string): Promise<void> {
  const existing = await fs.lstat(filePath).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to write imported source page through symlink: ${pagePath}`);
  }
  if (existing && !existing.isFile()) {
    throw new Error(`Refusing to write imported source page over non-file: ${pagePath}`);
  }
}

async function writeFileAtomicInVault(params: {
  filePath: string;
  pageDir: string;
  pageDirRealPath: string;
  vaultRealPath: string;
  pagePath: string;
  content: string;
}): Promise<void> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  await assertWritablePageDir(params);

  const tempPath = path.join(params.pageDir, `.openclaw-wiki-${process.pid}-${randomUUID()}.tmp`);
  let shouldRemoveTemp = true;
  try {
    const handle = await fs.open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    try {
      const tempStat = await handle.stat();
      if (!tempStat.isFile() || tempStat.nlink !== 1) {
        throw new Error(
          `Refusing to write imported source page through unsafe temp file: ${params.pagePath}`,
        );
      }
      await handle.writeFile(params.content, "utf8");
    } finally {
      await handle.close();
    }
    await assertWritablePageDir(params);
    await validateDestinationForReplace(params.filePath, params.pagePath);
    await fs.rename(tempPath, params.filePath);
    shouldRemoveTemp = false;
    await assertWritablePageDir(params);
  } finally {
    if (shouldRemoveTemp) {
      await fs.rm(tempPath, { force: true });
    }
  }
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
  const {
    pageAbsPath,
    pageDir,
    pageDirRealPath,
    vaultRealPath,
    existing: pageStat,
  } = await resolveWritableVaultPagePath({
    vaultRoot: params.vaultRoot,
    pagePath: params.pagePath,
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
  const existing = pageStat ? await fs.readFile(pageAbsPath, "utf8").catch(() => "") : "";
  if (existing !== rendered) {
    await writeFileAtomicInVault({
      filePath: pageAbsPath,
      pageDir,
      pageDirRealPath,
      vaultRealPath,
      pagePath: params.pagePath,
      content: rendered,
    });
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
