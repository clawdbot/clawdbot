import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { extractArchive, type ArchiveExtractLimits } from "openclaw/plugin-sdk/archive";
import type { LlamaServerAsset } from "./llama-server-assets.js";

const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const MEBIBYTE = 1024 * 1024;
const LLAMA_ARCHIVE_LIMITS = {
  maxArchiveBytes: 256 * MEBIBYTE,
  maxEntries: 1_000,
  maxExtractedBytes: 512 * MEBIBYTE,
  maxEntryBytes: 256 * MEBIBYTE,
  maxMetaEntryBytes: MEBIBYTE,
} satisfies ArchiveExtractLimits;

function resolveManifestFile(rootDir: string, filename: string): string {
  if (!filename || filename === "." || filename === ".." || path.basename(filename) !== filename) {
    throw new Error(`invalid llama-server archive manifest filename: ${filename}`);
  }
  return path.join(rootDir, filename);
}

async function findExecutable(rootDir: string, executable: string): Promise<string> {
  for (const entry of await fsp.readdir(rootDir, { withFileTypes: true })) {
    const candidate = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === executable) {
      return candidate;
    }
    if (entry.isDirectory()) {
      const nested = await findExecutable(candidate, executable).catch(() => undefined);
      if (nested) {
        return nested;
      }
    }
  }
  throw new Error(`llama-server archive does not contain ${executable}`);
}

async function materializeRegularFileAliases(
  rootDir: string,
  aliases: LlamaServerAsset["regularFileAliases"],
): Promise<void> {
  for (const [source, destinations] of aliases) {
    const sourcePath = resolveManifestFile(rootDir, source);
    const sourceStat = await fsp.lstat(sourcePath).catch(() => undefined);
    if (!sourceStat?.isFile()) {
      throw new Error(`llama-server archive does not contain regular alias source ${source}`);
    }
    for (const destination of destinations) {
      await fsp.copyFile(
        sourcePath,
        resolveManifestFile(rootDir, destination),
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
      );
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
  await extractArchive({
    archivePath: params.archivePath,
    destDir: params.destDir,
    kind: isTar ? "tar" : "zip",
    timeoutMs: EXTRACT_TIMEOUT_MS,
    limits: LLAMA_ARCHIVE_LIMITS,
    ...(isTar
      ? {
          tarGzip: true,
          entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
          onFiltered: "skip-entry" as const,
        }
      : {}),
  });

  const executable = await findExecutable(params.destDir, params.asset.executable);
  await materializeRegularFileAliases(path.dirname(executable), params.asset.regularFileAliases);
  return executable;
}
