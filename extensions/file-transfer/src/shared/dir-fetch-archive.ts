import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  inspectTarArchive,
  type ExtractArchiveOptions,
} from "openclaw/plugin-sdk/archive";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { DIR_FETCH_ARCHIVE_LIMITS } from "./dir-fetch-limits.js";

export const DIR_FETCH_ARCHIVE_POLICY = {
  limits: DIR_FETCH_ARCHIVE_LIMITS,
  entryFilter: ({ kind }) => (kind === "file" || kind === "directory" ? "extract" : "skip"),
  onFiltered: "reject-archive",
} satisfies Pick<ExtractArchiveOptions, "limits" | "entryFilter" | "onFiltered">;

export async function inspectDirFetchArchive(bytes: Buffer, timeoutMs: number): Promise<string[]> {
  if (bytes.byteLength > DIR_FETCH_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  // Authorize the admitted identities that extraction uses, never tar's display
  // spelling. The private input copy also keeps policy tied to these exact bytes.
  return await withTempWorkspace(
    { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-dir-fetch-" },
    async (workspace) => {
      const archivePath = await workspace.write("archive.tar.gz", bytes);
      const entries = await inspectTarArchive({
        archivePath,
        timeoutMs,
        ...DIR_FETCH_ARCHIVE_POLICY,
      });
      return entries
        .map((entry) => entry.path)
        .toSorted((left, right) => left.localeCompare(right));
    },
  );
}
