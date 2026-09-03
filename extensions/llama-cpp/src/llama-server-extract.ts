import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  extractArchive,
  type ArchiveExtractLimits,
} from "openclaw/plugin-sdk/archive";
import type { LlamaServerAsset } from "./llama-server-assets.js";

const MEBIBYTE = 1024 * 1024;
const LLAMA_ARCHIVE_LIMITS = {
  maxArchiveBytes: 256 * MEBIBYTE,
  maxEntries: 1_000,
  maxExtractedBytes: 512 * MEBIBYTE,
  maxEntryBytes: 256 * MEBIBYTE,
  maxMetaEntryBytes: MEBIBYTE,
} satisfies ArchiveExtractLimits;
const MAX_ALIAS_BYTES = 512 * MEBIBYTE;

function assertManifestBasename(filename: string): string {
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    /[\\/]/u.test(filename) ||
    path.basename(filename) !== filename
  ) {
    throw new Error(`invalid llama-server archive manifest filename: ${filename}`);
  }
  return filename;
}

function resolveArchiveRoot(destDir: string, archiveRoot: string): string {
  if (archiveRoot === ".") {
    return destDir;
  }
  if (path.isAbsolute(archiveRoot) || /\\/u.test(archiveRoot)) {
    throw new Error(`invalid llama-server archive root: ${archiveRoot}`);
  }
  const parts = archiveRoot.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid llama-server archive root: ${archiveRoot}`);
  }
  return path.join(destDir, ...parts);
}

async function assertRegularFile(filePath: string, label: string): Promise<Stats> {
  const stat = await fs.lstat(filePath).catch(() => undefined);
  if (!stat?.isFile() || stat.nlink > 1) {
    throw new Error(`llama-server archive does not contain regular ${label}`);
  }
  return stat;
}

async function materializeAssetAliases(params: {
  rootDir: string;
  asset: LlamaServerAsset;
}): Promise<void> {
  const claimedNames = new Set([assertManifestBasename(params.asset.executable)]);
  await assertRegularFile(
    path.join(params.rootDir, params.asset.executable),
    `executable ${params.asset.executable}`,
  );
  let copiedBytes = 0;
  for (const [rawSource, rawAliases] of params.asset.regularFileAliases) {
    const source = assertManifestBasename(rawSource);
    if (claimedNames.has(source)) {
      throw new Error(`duplicate llama-server archive manifest filename: ${source}`);
    }
    claimedNames.add(source);
    const sourcePath = path.join(params.rootDir, source);
    const sourceStat = await assertRegularFile(sourcePath, `alias source ${source}`);
    for (const rawAlias of rawAliases) {
      const alias = assertManifestBasename(rawAlias);
      if (claimedNames.has(alias)) {
        throw new Error(`duplicate llama-server archive manifest filename: ${alias}`);
      }
      claimedNames.add(alias);
      copiedBytes += sourceStat.size;
      if (copiedBytes > MAX_ALIAS_BYTES) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
      }
      const aliasPath = path.join(params.rootDir, alias);
      await fs.copyFile(sourcePath, aliasPath, fsConstants.COPYFILE_EXCL);
      await fs.chmod(aliasPath, sourceStat.mode & 0o777);
      const aliasStat = await assertRegularFile(aliasPath, `alias ${alias}`);
      if (aliasStat.size !== sourceStat.size) {
        throw new Error(`llama-server archive alias copy is incomplete: ${alias}`);
      }
    }
  }
}

/** Extracts one verified asset and returns its unpublished executable path. */
export async function extractLlamaServerArchive(params: {
  archivePath: string;
  destDir: string;
  asset: LlamaServerAsset;
}): Promise<string> {
  const isTar = params.asset.archive === "tar.gz";
  const aliasCount = params.asset.regularFileAliases.reduce(
    (count, [, aliases]) => count + aliases.length,
    0,
  );
  if (aliasCount > LLAMA_ARCHIVE_LIMITS.maxEntries) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
  }
  await extractArchive({
    archivePath: params.archivePath,
    destDir: params.destDir,
    kind: isTar ? "tar" : "zip",
    // The installer owns destination cleanup, so keep extraction joined instead of racing
    // fs-safe's internal transaction against a caller-side timeout.
    timeoutMs: 0,
    limits: {
      ...LLAMA_ARCHIVE_LIMITS,
      maxEntries: LLAMA_ARCHIVE_LIMITS.maxEntries - aliasCount,
    },
    tarGzip: isTar,
    entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
    onFiltered: "skip-entry",
  });
  const rootDir = resolveArchiveRoot(params.destDir, params.asset.archiveRoot);
  await materializeAssetAliases({ rootDir, asset: params.asset });
  return path.join(rootDir, params.asset.executable);
}
