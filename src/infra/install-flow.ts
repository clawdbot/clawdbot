import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { type ArchiveLogger, extractArchive, fileExists, resolvePackedRootDir } from "./archive.js";
import { withTempDir } from "./install-source-utils.js";

type ExistingInstallPathResult =
  | {
      ok: true;
      resolvedPath: string;
      stat: Stats;
    }
  | {
      ok: false;
      error: string;
    };

export async function resolveExistingInstallPath(
  inputPath: string,
): Promise<ExistingInstallPathResult> {
  const resolvedPath = resolveUserPath(inputPath);
  if (!(await fileExists(resolvedPath))) {
    return { ok: false, error: `path not found: ${resolvedPath}` };
  }
  const stat = await fs.stat(resolvedPath);
  return { ok: true, resolvedPath, stat };
}

export async function withExtractedArchiveRoot<TResult extends { ok: boolean }>(params: {
  archivePath: string;
  tempDirPrefix: string;
  timeoutMs: number;
  logger?: ArchiveLogger;
  rootMarkers?: string[];
  onExtracted: (rootDir: string) => Promise<TResult>;
}): Promise<TResult | { ok: false; error: string }> {
  return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
    const extractDir = path.join(tmpDir, "extract");
    await fs.mkdir(extractDir, { recursive: true });

    params.logger?.info?.(`Extracting ${params.archivePath}…`);
    try {
      await extractArchive({
        archivePath: params.archivePath,
        destDir: extractDir,
        timeoutMs: params.timeoutMs,
        logger: params.logger,
      });
    } catch (err) {
      return { ok: false, error: `failed to extract archive: ${String(err)}` };
    }

    let rootDir = "";
    try {
      rootDir = await resolvePackedRootDir(extractDir, {
        rootMarkers: params.rootMarkers,
      });
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    return await params.onExtracted(rootDir);
  });
}
