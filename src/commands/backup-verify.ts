// Verifies backup archives, including payload paths and hardlink/symbolic-link targets.
import path from "node:path";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import * as tar from "tar";
import {
  assertArchiveSymbolicLinkTarget,
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
} from "../infra/backup-archive-path-policy.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord, resolveUserPath } from "../utils.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO } from "./backup-shared.js";
import {
  assertSqliteExtractionBudget,
  type BackupManifest,
  type BackupManifestAsset,
  resolvePortableArchivePathKey,
  verifySqliteSnapshots,
} from "./backup-verify-sqlite.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;

type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
};

type BackupVerifyResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
  symlinkCount: number;
};

type ArchiveEntry = {
  path: string;
  linkpath?: string;
  size?: number;
  type?: string;
};

function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Backup manifest is not valid JSON.", { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets: BackupManifestAsset[] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    });
  }

  return {
    schemaVersion: 1,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    options: isRecord(parsed.options)
      ? { includeWorkspace: parsed.options.includeWorkspace as boolean | undefined }
      : undefined,
    paths: isRecord(parsed.paths)
      ? {
          stateDir: readStringValue(parsed.paths.stateDir),
          configPath: readStringValue(parsed.paths.configPath),
          oauthDir: readStringValue(parsed.paths.oauthDir),
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? parsed.paths.workspaceDirs.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : undefined,
        }
      : undefined,
    assets,
    skipped: Array.isArray(parsed.skipped) ? parsed.skipped : undefined,
  };
}

async function listArchiveEntries(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    onReadEntry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
    },
  });
  return entries;
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  const limitError = new Error(`Backup manifest exceeds ${MAX_MANIFEST_BYTES} byte limit.`);
  let manifestContentPromise: Promise<Buffer | Error> | undefined;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    filter: (entryPath) => entryPath === params.manifestEntryPath,
    onReadEntry: (entry) => {
      manifestContentPromise =
        entry.size > MAX_MANIFEST_BYTES
          ? Promise.resolve(limitError)
          : entry.concat().catch((error: unknown) => toStringifiedError(error));
    },
  });

  if (!manifestContentPromise) {
    throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
  }
  const content = await manifestContentPromise;
  if (content instanceof Error) {
    throw content;
  }
  return content.toString("utf8");
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

function verifyManifestAgainstEntries(manifest: BackupManifest, entries: Set<string>): void {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
  const normalizedEntries = [...entries];
  const normalizedEntrySet = new Set(normalizedEntries);

  if (!normalizedEntrySet.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of normalizedEntries) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    const exact = normalizedEntrySet.has(assetArchivePath);
    const nested = normalizedEntries.some(
      (entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath),
    );
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
}

function verifyHardlinkTargetsAgainstArchiveRoot(
  hardlinkTargets: Array<{ entryPath: string; normalized: string }>,
  archiveRoot: string,
  entries: Set<string>,
): void {
  const normalizedRoot = normalizeArchiveRoot(archiveRoot);
  for (const target of hardlinkTargets) {
    // Older backup archives may store hardlink linkpath values relative to the
    // archive root instead of including the root segment. Accept that form only
    // when it resolves to a real entry inside this archive.
    const normalizedTarget = isArchivePathWithin(target.normalized, normalizedRoot)
      ? target.normalized
      : path.posix.join(normalizedRoot, target.normalized);
    if (!isArchivePathWithin(normalizedTarget, normalizedRoot)) {
      throw new Error(
        `Archive hardlink target is outside the declared archive root: ${target.entryPath} -> ${normalizedTarget}`,
      );
    }
    if (!entries.has(normalizedTarget)) {
      throw new Error(
        `Archive hardlink target is missing from archive entries: ${target.entryPath} -> ${normalizedTarget}`,
      );
    }
  }
}

function formatResult(result: BackupVerifyResult): string {
  return [
    `Backup archive OK: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Archive entries scanned: ${result.entryCount}`,
    `Symbolic links checked: ${result.symlinkCount}`,
  ].join("\n");
}

function findDuplicateNormalizedEntryPath(
  entries: Array<{ normalized: string }>,
): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.normalized)) {
      return entry.normalized;
    }
    seen.add(entry.normalized);
  }
  return undefined;
}

function findPortableArchiveEntryPathCollision(
  entries: Array<{ normalized: string }>,
): { first: string; second: string } | undefined {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = resolvePortableArchivePathKey(entry.normalized);
    const first = seen.get(key);
    if (first && first !== entry.normalized) {
      return { first, second: entry.normalized };
    }
    seen.set(key, entry.normalized);
  }
  return undefined;
}

/** Verify a backup archive and return its normalized, integrity-checked inventory. */
export async function verifyBackupArchive(archive: string): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(archive);
  const rawEntries = await listArchiveEntries(archivePath);
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = rawEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
    ...(entry.type ? { type: entry.type } : {}),
  }));
  const hardlinkTargets = rawEntries
    .filter((entry) => entry.type === "Link" && entry.linkpath)
    .map((entry) => ({
      entryPath: entry.path,
      normalized: normalizeArchivePath(
        entry.linkpath ?? "",
        `Archive hardlink target for ${entry.path}`,
      ),
    }));
  const symbolicLinks = rawEntries
    .filter((entry) => entry.type === "SymbolicLink")
    .map((entry) => ({ entryPath: entry.path, linkpath: entry.linkpath }));
  const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
  }
  const portablePathCollision = findPortableArchiveEntryPathCollision(entries);
  if (portablePathCollision) {
    throw new Error(
      `Archive contains a portable path collision: ${portablePathCollision.first} and ${portablePathCollision.second}`,
    );
  }
  const manifestEntryPath = manifestMatches[0]?.raw;
  if (!manifestEntryPath) {
    throw new Error("Backup archive manifest entry could not be resolved.");
  }

  const manifestRaw = await extractManifest({ archivePath, manifestEntryPath });
  const manifest = parseManifest(manifestRaw);
  verifyManifestAgainstEntries(manifest, normalizedEntrySet);
  verifyHardlinkTargetsAgainstArchiveRoot(
    hardlinkTargets,
    manifest.archiveRoot,
    normalizedEntrySet,
  );
  for (const link of symbolicLinks) {
    assertArchiveSymbolicLinkTarget({ ...link, archiveRoot: manifest.archiveRoot });
  }
  await verifySqliteSnapshots({ archivePath, entries, manifest });

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: rawEntries.length,
    symlinkCount: symbolicLinks.length,
  };

  return result;
}

/** Verify a backup archive, including snapshot shape and canonical SQLite integrity checks. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const result = await verifyBackupArchive(opts.archive);

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}

export const testApi = {
  assertSqliteExtractionBudget,
};
