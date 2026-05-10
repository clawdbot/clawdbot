import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBackupArchiveBasename,
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  type BackupAsset,
  resolveBackupPlanFromDisk,
} from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { isVolatileBackupPath } from "./backup-volatile-filter.js";
import { writeJson } from "./json-files.js";

type TarRuntime = typeof import("tar");

let tarRuntimePromise: Promise<TarRuntime> | undefined;

function loadTarRuntime(): Promise<TarRuntime> {
  tarRuntimePromise ??= import("tar");
  return tarRuntimePromise;
}

export type BackupCreateOptions = {
  output?: string;
  dryRun?: boolean;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  verify?: boolean;
  json?: boolean;
  nowMs?: number;
  /**
   * Optional info logger invoked for non-fatal backup events such as tar
   * retry notices or volatile-file skip counts. When omitted, events are
   * silent aside from the final result.
   */
  log?: (message: string) => void;
};

type BackupManifestAsset = {
  kind: BackupAsset["kind"];
  sourcePath: string;
  archivePath: string;
};

type BackupManifest = {
  schemaVersion: 1;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  options: {
    includeWorkspace: boolean;
    onlyConfig?: boolean;
  };
  paths: {
    stateDir: string;
    configPath: string;
    oauthDir: string;
    workspaceDirs: string[];
  };
  assets: BackupManifestAsset[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    reason: string;
    coveredBy?: string;
  }>;
};

export type BackupCreateResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  verified: boolean;
  assets: BackupAsset[];
  skipped: Array<{
    kind: string;
    sourcePath: string;
    displayPath: string;
    reason: string;
    coveredBy?: string;
  }>;
  /**
   * Count of files the archiver actively skipped because they matched the
   * known-volatile filter (live sessions, cron logs, queues, sockets, pid/tmp).
   * Populated on real writes only; dry runs report 0.
   */
  skippedVolatileCount: number;
};

const BACKUP_TAR_MAX_ATTEMPTS = 3;
// Backoff between attempts: wait 10s before attempt 2, 20s before attempt 3.
const BACKUP_TAR_BACKOFF_MS = [10_000, 20_000];

function isTarEofRaceError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EOF") {
    return true;
  }
  // Keep this regex narrow: match only the two tar-specific EOF-class error
  // strings thrown by node-tar's WriteEntry#onread (grow and shrink races,
  // see node_modules/tar/dist/commonjs/write-entry.js around the
  // "did not encounter expected EOF" and "encountered unexpected EOF"
  // Object.assign sites), plus the TAR_BAD_ARCHIVE code surfaced by the
  // parser on truncated input. A bare /EOF/i alternative also matched
  // unrelated SSL/OpenSSL strings like "EOF occurred in violation of
  // protocol" and "unexpected eof while reading", causing pointless retries.
  const message = (err as Error).message ?? "";
  return /(did not encounter expected|encountered unexpected) EOF|TAR_BAD_ARCHIVE/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type BackupTarRetryLogger = (message: string) => void;

async function writeTarArchiveWithRetry(params: {
  tempArchivePath: string;
  runTar: () => Promise<void>;
  log?: BackupTarRetryLogger;
  sleepMs?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleepFn = params.sleepMs ?? sleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= BACKUP_TAR_MAX_ATTEMPTS; attempt += 1) {
    try {
      await params.runTar();
      return;
    } catch (err) {
      lastErr = err;
      if (!isTarEofRaceError(err) || attempt === BACKUP_TAR_MAX_ATTEMPTS) {
        break;
      }
      try {
        await fs.rm(params.tempArchivePath, { force: true });
      } catch (cleanupErr) {
        const code = (cleanupErr as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          params.log?.(
            `Backup archiver could not remove temp archive ${params.tempArchivePath} between retries: ${code}. Continuing.`,
          );
        }
      }
      const backoff = BACKUP_TAR_BACKOFF_MS[attempt - 1] ?? 0;
      const offendingPath = (err as NodeJS.ErrnoException).path;
      params.log?.(
        `Backup archiver hit a live-write race${
          offendingPath ? ` on ${offendingPath}` : ""
        } (attempt ${attempt}/${BACKUP_TAR_MAX_ATTEMPTS}); retrying in ${Math.round(backoff / 1000)}s.`,
      );
      await sleepFn(backoff);
    }
  }
  const final = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  const offendingPath = (lastErr as NodeJS.ErrnoException | undefined)?.path;
  const suffix = offendingPath
    ? ` (last offending path: ${offendingPath}, after ${BACKUP_TAR_MAX_ATTEMPTS} attempts)`
    : ` (after ${BACKUP_TAR_MAX_ATTEMPTS} attempts)`;
  throw new Error(`Backup archive write failed: ${final.message}${suffix}`, { cause: final });
}

export const __test = { writeTarArchiveWithRetry, isTarEofRaceError };

async function resolveOutputPath(params: {
  output?: string;
  nowMs: number;
  includedAssets: BackupAsset[];
  stateDir: string;
}): Promise<string> {
  const basename = buildBackupArchiveBasename(params.nowMs);
  const rawOutput = params.output?.trim();
  if (!rawOutput) {
    const cwd = path.resolve(process.cwd());
    const canonicalCwd = await fs.realpath(cwd).catch(() => cwd);
    const cwdInsideSource = params.includedAssets.some((asset) =>
      isPathWithin(canonicalCwd, asset.sourcePath),
    );
    const defaultDir = cwdInsideSource ? (resolveHomeDir() ?? path.dirname(params.stateDir)) : cwd;
    return path.resolve(defaultDir, basename);
  }

  const resolved = resolveUserPath(rawOutput);
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return path.join(resolved, basename);
    }
  } catch {
    // Treat as a file path when the target does not exist yet.
  }

  return resolved;
}

async function assertOutputPathReady(outputPath: string): Promise<void> {
  try {
    await fs.access(outputPath);
    throw new Error(`Refusing to overwrite existing backup archive: ${outputPath}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function buildTempArchivePath(outputPath: string): string {
  return `${outputPath}.${randomUUID()}.tmp`;
}

// The temp manifest is passed to `tar.c` alongside the asset source paths. If
// the temp file lives inside any asset, recursive traversal pulls it in a
// second time and both copies remap to `<archiveRoot>/manifest.json`, which
// makes verify reject the archive. A `tar` filter cannot fix this in place: it
// fires for both the explicit-arg and the traversed entry, so excluding by
// path drops the manifest entirely. We instead place the temp dir somewhere
// guaranteed to be outside every asset.
async function chooseBackupTempRoot(params: {
  assets: readonly BackupAsset[];
  outputPath: string;
}): Promise<string> {
  const systemTmp = os.tmpdir();
  const canonicalSystemTmp = await canonicalizePathForContainment(systemTmp);
  const systemTmpInsideAsset = params.assets.some((asset) =>
    isPathWithin(canonicalSystemTmp, asset.sourcePath),
  );
  if (!systemTmpInsideAsset) {
    return systemTmp;
  }

  // Fallback: the directory holding the output archive. The earlier
  // output-containment check guarantees `outputPath` is outside every asset,
  // so its parent is too. The caller must already have write access there to
  // write the archive itself, so this stays within the existing sandbox.
  const fallback = path.dirname(params.outputPath);
  const canonicalFallback = await canonicalizePathForContainment(fallback);
  const fallbackInsideAsset = params.assets.find((asset) =>
    isPathWithin(canonicalFallback, asset.sourcePath),
  );
  if (fallbackInsideAsset) {
    throw new Error(
      `Backup temp root cannot be placed outside every source path: ${systemTmp} and ${fallback} both overlap ${fallbackInsideAsset.sourcePath}.`,
    );
  }
  return fallback;
}

function isLinkUnsupportedError(code: string | undefined): boolean {
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM";
}

async function publishTempArchive(params: {
  tempArchivePath: string;
  outputPath: string;
}): Promise<void> {
  try {
    await fs.link(params.tempArchivePath, params.outputPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, {
        cause: err,
      });
    }
    if (!isLinkUnsupportedError(code)) {
      throw err;
    }

    try {
      // Some backup targets support ordinary files but not hard links.
      await fs.copyFile(params.tempArchivePath, params.outputPath, fsConstants.COPYFILE_EXCL);
    } catch (copyErr) {
      const copyCode = (copyErr as NodeJS.ErrnoException | undefined)?.code;
      if (copyCode !== "EEXIST") {
        await fs.rm(params.outputPath, { force: true }).catch(() => undefined);
      }
      if (copyCode === "EEXIST") {
        throw new Error(`Refusing to overwrite existing backup archive: ${params.outputPath}`, {
          cause: copyErr,
        });
      }
      throw copyErr;
    }
  }
  await fs.rm(params.tempArchivePath, { force: true });
}

async function canonicalizePathForContainment(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      return suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

function buildManifest(params: {
  createdAt: string;
  archiveRoot: string;
  includeWorkspace: boolean;
  onlyConfig: boolean;
  assets: BackupAsset[];
  skipped: BackupCreateResult["skipped"];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
}): BackupManifest {
  return {
    schemaVersion: 1,
    createdAt: params.createdAt,
    archiveRoot: params.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    options: {
      includeWorkspace: params.includeWorkspace,
      onlyConfig: params.onlyConfig,
    },
    paths: {
      stateDir: params.stateDir,
      configPath: params.configPath,
      oauthDir: params.oauthDir,
      workspaceDirs: params.workspaceDirs,
    },
    assets: params.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    })),
    skipped: params.skipped.map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      reason: entry.reason,
      coveredBy: entry.coveredBy,
    })),
  };
}

export function formatBackupCreateSummary(result: BackupCreateResult): string[] {
  const lines = [`Backup archive: ${result.archivePath}`];
  lines.push(`Included ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
  for (const asset of result.assets) {
    lines.push(`- ${asset.kind}: ${asset.displayPath}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
    for (const entry of result.skipped) {
      if (entry.reason === "covered" && entry.coveredBy) {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason} by ${entry.coveredBy})`);
      } else {
        lines.push(`- ${entry.kind}: ${entry.displayPath} (${entry.reason})`);
      }
    }
  }
  if (result.dryRun) {
    lines.push("Dry run only; archive was not written.");
  } else {
    lines.push(`Created ${result.archivePath}`);
    if (result.skippedVolatileCount > 0) {
      lines.push(
        `Skipped ${result.skippedVolatileCount} volatile file${
          result.skippedVolatileCount === 1 ? "" : "s"
        } (live sessions, cron logs, queues, sockets, pid/tmp).`,
      );
    }
    if (result.verified) {
      lines.push("Archive verification: passed");
    }
  }
  return lines;
}

function remapArchiveEntryPath(params: {
  entryPath: string;
  manifestPath: string;
  archiveRoot: string;
}): string {
  const normalizedEntry = path.resolve(params.entryPath);
  if (normalizedEntry === params.manifestPath) {
    return path.posix.join(params.archiveRoot, "manifest.json");
  }
  return buildBackupArchivePath(params.archiveRoot, normalizedEntry);
}

function normalizeBackupFilterPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function buildExtensionsNodeModulesFilter(stateDir: string): (filePath: string) => boolean {
  const normalizedStateDir = normalizeBackupFilterPath(stateDir);
  const extensionsPrefix = `${normalizedStateDir}/extensions/`;

  return (filePath: string): boolean => {
    const normalizedFilePath = normalizeBackupFilterPath(filePath);
    if (!normalizedFilePath.startsWith(extensionsPrefix)) {
      return true;
    }

    return !normalizedFilePath.slice(extensionsPrefix.length).split("/").includes("node_modules");
  };
}

export async function createBackupArchive(
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const archiveRoot = buildBackupArchiveRoot(nowMs);
  const onlyConfig = Boolean(opts.onlyConfig);
  const includeWorkspace = onlyConfig ? false : (opts.includeWorkspace ?? true);
  const plan = await resolveBackupPlanFromDisk({ includeWorkspace, onlyConfig, nowMs });
  const outputPath = await resolveOutputPath({
    output: opts.output,
    nowMs,
    includedAssets: plan.included,
    stateDir: plan.stateDir,
  });

  if (plan.included.length === 0) {
    throw new Error(
      onlyConfig
        ? "No OpenClaw config file was found to back up."
        : "No local OpenClaw state was found to back up.",
    );
  }

  const canonicalOutputPath = await canonicalizePathForContainment(outputPath);
  const overlappingAsset = plan.included.find((asset) =>
    isPathWithin(canonicalOutputPath, asset.sourcePath),
  );
  if (overlappingAsset) {
    throw new Error(
      `Backup output must not be written inside a source path: ${outputPath} is inside ${overlappingAsset.sourcePath}`,
    );
  }

  if (!opts.dryRun) {
    await assertOutputPathReady(outputPath);
  }

  const createdAt = new Date(nowMs).toISOString();
  const result: BackupCreateResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    includeWorkspace,
    onlyConfig,
    verified: false,
    assets: plan.included,
    skipped: plan.skipped,
    skippedVolatileCount: 0,
  };

  if (opts.dryRun) {
    return result;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempRoot = await chooseBackupTempRoot({ assets: result.assets, outputPath });
  await fs.mkdir(tempRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-backup-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const tempArchivePath = buildTempArchivePath(outputPath);
  try {
    const manifest = buildManifest({
      createdAt,
      archiveRoot,
      includeWorkspace,
      onlyConfig,
      assets: result.assets,
      skipped: result.skipped,
      stateDir: plan.stateDir,
      configPath: plan.configPath,
      oauthDir: plan.oauthDir,
      workspaceDirs: plan.workspaceDirs,
    });
    await writeJson(manifestPath, manifest, { trailingNewline: true });

    const tar = await loadTarRuntime();
    const stateAsset = result.assets.find((asset) => asset.kind === "state");
    const extensionsFilter = stateAsset
      ? buildExtensionsNodeModulesFilter(stateAsset.sourcePath)
      : undefined;
    const volatilePlan = { stateDirs: [stateAsset?.sourcePath ?? plan.stateDir] };
    let skippedVolatileCount = 0;
    const tarFilter = (entryPath: string): boolean => {
      // The manifest is staged in a tmp dir outside any state directory and
      // is always safe to include.
      if (path.resolve(entryPath) === manifestPath) {
        return true;
      }
      if (extensionsFilter && !extensionsFilter(entryPath)) {
        return false;
      }
      if (isVolatileBackupPath(entryPath, volatilePlan)) {
        skippedVolatileCount += 1;
        return false;
      }
      return true;
    };
    await writeTarArchiveWithRetry({
      tempArchivePath,
      log: opts.log,
      runTar: () => {
        // tar.c re-walks the tree (and thus re-invokes tarFilter) on every
        // attempt, so reset the closure counter here or retries would report
        // cumulative skip counts across attempts instead of the final one.
        skippedVolatileCount = 0;
        return tar.c(
          {
            file: tempArchivePath,
            gzip: true,
            portable: true,
            preservePaths: true,
            filter: tarFilter,
            onWriteEntry: (entry) => {
              entry.path = remapArchiveEntryPath({
                entryPath: entry.path,
                manifestPath,
                archiveRoot,
              });
            },
          },
          [manifestPath, ...result.assets.map((asset) => asset.sourcePath)],
        );
      },
    });
    result.skippedVolatileCount = skippedVolatileCount;
    if (skippedVolatileCount > 0) {
      opts.log?.(
        `Backup skipped ${skippedVolatileCount} volatile file${
          skippedVolatileCount === 1 ? "" : "s"
        } (live sessions, cron logs, queues, sockets, pid/tmp).`,
      );
    }
    await publishTempArchive({ tempArchivePath, outputPath });
  } finally {
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
