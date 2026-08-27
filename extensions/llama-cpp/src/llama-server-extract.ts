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
    regularFileAliasRoot: params.asset.archiveRoot,
    regularFileAliases: params.asset.regularFileAliases,
    requiredRegularFiles: [params.asset.executable],
    ...(isTar
      ? {
          tarGzip: true,
          entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
          onFiltered: "skip-entry" as const,
        }
      : {}),
  });
  return path.join(params.destDir, params.asset.archiveRoot, params.asset.executable);
}
