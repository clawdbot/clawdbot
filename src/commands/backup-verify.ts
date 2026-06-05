// Verifies backup archives by validating their manifest, payload entries, and hardlink targets.
import path from "node:path";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import * as tar from "tar";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { isRecord, resolveUserPath } from "../utils.js";

const WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

type BackupManifestAsset = {
  kind: string;
  sourcePath: string;
  archivePath: string;
};

type BackupManifest = {
  schemaVersion: number;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
  };
  assets: BackupManifestAsset[];
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
};

export type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
};

export type BackupVerifyResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
};

type ArchiveEntry = {
  path: string;
  linkpath?: string;
  type?: string;
};

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE_ARCHIVE_PATH_RE.test(trimmed)) {
    throw new Error(`${label} must be relative: ${entryPath}`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${entryPath}`);
  }
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }

  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

function normalizeArchiveRoot(rootName: string): string {
  const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
  if (normalized.includes("/")) {
    throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
  }
  return normalized;
}

function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

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
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
      entry.resume();
    },
  });
  return entries;
}

async function extractManifest(params: {
  archivePath: string;
  manifestEntryPath: string;
}): Promise<string> {
  let manifestContentPromise: Promise<{ content?: string; error?: Error }> | undefined;
  await tar.t({
    file: params.archivePath,
    gzip: true,
    onentry: (entry) => {
      if (entry.path !== params.manifestEntryPath) {
        entry.resume();
        return;
      }

      manifestContentPromise = new Promise<{ content?: string; error?: Error }>((resolve) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let exceededLimit = false;
        let settled = false;
        const settle = (result: { content?: string; error?: Error }) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(result);
        };
        entry.on("data", (chunk: Buffer | string) => {
          if (exceededLimit) {
            return;
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;
          if (totalBytes > MAX_MANIFEST_BYTES) {
            exceededLimit = true;
            chunks.length = 0;
            return;
          }
          chunks.push(buffer);
        });
        entry.on("error", (error) => {
          settle({
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
        entry.on("end", () => {
          if (exceededLimit) {
            settle({
              error: new Error(`Backup manifest exceeds ${MAX_MANIFEST_BYTES} byte limit.`),
            });
            return;
          }
          settle({ content: Buffer.concat(chunks, totalBytes).toString("utf8") });
        });
      });
    },
  });

  if (!manifestContentPromise) {
    throw new Error(`Archive is missing manifest entry: ${params.manifestEntryPath}`);
  }
  const result = await manifestContentPromise;
  if (result.error) {
    throw result.error;
  }
  return result.content ?? "";
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

/** Verify a backup archive without extracting payload files to disk. */
export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(opts.archive);
  const rawEntries = await listArchiveEntries(archivePath);
  if (rawEntries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const entries = rawEntries.map((entry) => ({
    raw: entry.path,
    normalized: normalizeArchivePath(entry.path, "Archive entry"),
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
  const normalizedEntrySet = new Set(entries.map((entry) => entry.normalized));

  const manifestMatches = entries.filter((entry) => isRootManifestEntry(entry.normalized));
  if (manifestMatches.length !== 1) {
    throw new Error(`Expected exactly one backup manifest entry, found ${manifestMatches.length}.`);
  }
  const duplicateEntryPath = findDuplicateNormalizedEntryPath(entries);
  if (duplicateEntryPath) {
    throw new Error(`Archive contains duplicate entry path: ${duplicateEntryPath}`);
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

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: manifest.archiveRoot,
    createdAt: manifest.createdAt,
    runtimeVersion: manifest.runtimeVersion,
    assetCount: manifest.assets.length,
    entryCount: rawEntries.length,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatResult(result));
  }
  return result;
}
