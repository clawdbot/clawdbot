// Retains bounded, manifest-verified Control UI generations for already-open documents.
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isErrno } from "../infra/errors.js";
import { isWithinDir } from "../infra/path-safety.js";
import { parseControlUiAssetManifest } from "./control-ui-asset-manifest-parse.js";
import {
  CONTROL_UI_ASSET_MANIFEST_FILENAME,
  type ControlUiAssetManifest,
  type ControlUiAssetManifestEntry,
} from "./control-ui-asset-manifest.js";

const CONTROL_UI_RETAINED_GENERATION_LIMIT = 3;
const CONTROL_UI_RETAINED_ASSET_MAX_BYTES = 96 * 1024 * 1024;

const CONTROL_UI_GENERATION_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_UI_STAGING_PATTERN = /^\.staging-[0-9]+-[a-f0-9-]+$/u;
const CONTROL_UI_STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const CONTROL_UI_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

type RetainedGeneration = {
  assetPaths: ReadonlySet<string>;
  bytes: number;
  directory: string;
  generation: string;
  stats: Stats;
  realPath: string;
};

type ResolvedRetainedControlUiAsset = {
  filePath: string;
  rootPath: string;
  rootRealPath: string;
};

export type ControlUiAssetRetention = {
  prepare: (options?: { isCancelled?: () => boolean; signal?: AbortSignal }) => Promise<void>;
  resolveAsset: (assetPath: string) => ResolvedRetainedControlUiAsset | null;
};

function resolveControlUiAssetCacheDir(): string {
  return path.join(resolveStateDir(), "cache", "control-ui-assets");
}

type RetentionOperation = {
  isCancelled?: () => boolean;
  signal?: AbortSignal;
};

function throwIfCancelled(operation?: RetentionOperation): void {
  operation?.signal?.throwIfAborted();
  if (operation?.isCancelled?.()) {
    throw new DOMException("Control UI asset retention cancelled", "AbortError");
  }
}

async function readCachedGeneration(
  directory: string,
  operation?: RetentionOperation,
): Promise<RetainedGeneration | null> {
  try {
    throwIfCancelled(operation);
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return null;
    }
    const realPath = await fs.realpath(directory);
    if (!isWithinDir(path.dirname(directory), realPath)) {
      return null;
    }
    const manifest = await readAssetManifest(realPath, operation);
    if (manifest.generation !== path.basename(directory)) {
      return null;
    }
    for (const asset of manifest.assets) {
      throwIfCancelled(operation);
      const assetPath = path.join(realPath, asset.path);
      const assetStats = await fs.lstat(assetPath);
      throwIfCancelled(operation);
      if (
        assetStats.isSymbolicLink() ||
        !assetStats.isFile() ||
        assetStats.size !== asset.size ||
        createHash("sha256")
          .update(await fs.readFile(assetPath, { signal: operation?.signal }))
          .digest("hex") !== asset.sha256
      ) {
        return null;
      }
    }
    const currentStats = await fs.lstat(directory);
    throwIfCancelled(operation);
    if (!sameDirectory(stats, currentStats)) {
      return null;
    }
    return {
      assetPaths: new Set(manifest.assets.map((asset) => asset.path)),
      bytes: manifest.assets.reduce((total, asset) => total + asset.size, 0),
      directory,
      generation: manifest.generation,
      stats: currentStats,
      realPath,
    };
  } catch {
    throwIfCancelled(operation);
    return null;
  }
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return (
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function compareGenerations(left: RetainedGeneration, right: RetainedGeneration): number {
  return (
    right.stats.mtimeMs - left.stats.mtimeMs || left.generation.localeCompare(right.generation)
  );
}

async function readCacheInventory(
  cacheDir: string,
  operation?: RetentionOperation,
  verified: RetainedGeneration[] = [],
) {
  const generations: RetainedGeneration[] = [];
  const directories = new Map<string, Stats>();
  let cacheRealPath: string;
  let entries: Dirent[];
  try {
    throwIfCancelled(operation);
    cacheRealPath = await fs.realpath(cacheDir);
    entries = await fs.readdir(cacheRealPath, { withFileTypes: true });
  } catch {
    throwIfCancelled(operation);
    return { generations, directories };
  }
  const known = new Map(verified.map((generation) => [generation.generation, generation]));
  for (const entry of entries) {
    throwIfCancelled(operation);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const directory = path.join(cacheRealPath, entry.name);
    const stats = await fs.lstat(directory).catch(() => null);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      continue;
    }
    directories.set(directory, stats);
    if (!CONTROL_UI_GENERATION_PATTERN.test(entry.name)) {
      continue;
    }
    const previous = known.get(entry.name);
    // Published directories are immutable. Refresh membership/mtime, but only
    // verify bytes for a new directory identity during this preparation.
    const generation =
      previous && sameDirectory(previous.stats, stats)
        ? { ...previous, stats }
        : await readCachedGeneration(directory, operation);
    if (generation) {
      generations.push(generation);
    }
  }
  throwIfCancelled(operation);
  return { generations: generations.toSorted(compareGenerations), directories };
}

async function readAssetManifest(
  root: string,
  operation?: RetentionOperation,
): Promise<ControlUiAssetManifest> {
  const manifestPath = path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME);
  throwIfCancelled(operation);
  const stats = await fs.lstat(manifestPath);
  throwIfCancelled(operation);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > CONTROL_UI_MANIFEST_MAX_BYTES) {
    throw new Error(`Invalid Control UI asset manifest: ${manifestPath}`);
  }
  const manifest = parseControlUiAssetManifest(
    JSON.parse(await fs.readFile(manifestPath, { encoding: "utf8", signal: operation?.signal })),
  );
  throwIfCancelled(operation);
  if (!manifest) {
    throw new Error(`Invalid Control UI asset manifest: ${manifestPath}`);
  }
  return manifest;
}

async function readVerifiedAsset(params: {
  entry: ControlUiAssetManifestEntry;
  operation?: RetentionOperation;
  root: string;
  rootRealPath: string;
}): Promise<Buffer> {
  throwIfCancelled(params.operation);
  const sourcePath = path.resolve(params.root, params.entry.path);
  if (!isWithinDir(params.root, sourcePath)) {
    throw new Error(`Unsafe Control UI asset path: ${params.entry.path}`);
  }
  const expectedRealPath = await fs.realpath(sourcePath);
  if (!isWithinDir(params.rootRealPath, expectedRealPath)) {
    throw new Error(`Unsafe Control UI asset path: ${params.entry.path}`);
  }
  const initialStats = await fs.lstat(sourcePath);
  if (initialStats.isSymbolicLink() || !initialStats.isFile()) {
    throw new Error(`Unsafe Control UI asset: ${params.entry.path}`);
  }
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = await handle.stat();
    const contents = await handle.readFile({ signal: params.operation?.signal });
    const currentStats = await fs.lstat(sourcePath);
    const currentRealPath = await fs.realpath(sourcePath);
    if (
      !openedStats.isFile() ||
      currentStats.isSymbolicLink() ||
      !currentStats.isFile() ||
      currentRealPath !== expectedRealPath ||
      currentStats.dev !== openedStats.dev ||
      currentStats.ino !== openedStats.ino ||
      contents.byteLength !== params.entry.size ||
      createHash("sha256").update(contents).digest("hex") !== params.entry.sha256
    ) {
      throw new Error(`Control UI asset changed while being retained: ${params.entry.path}`);
    }
    throwIfCancelled(params.operation);
    return contents;
  } finally {
    await handle.close();
  }
}

async function publishGeneration(params: {
  cacheDir: string;
  manifest: ControlUiAssetManifest;
  verified?: RetainedGeneration;
  operation?: RetentionOperation;
  root: string;
}): Promise<RetainedGeneration> {
  const target = path.join(await fs.realpath(params.cacheDir), params.manifest.generation);
  // Another preparer may prune or replace the target after the initial inventory.
  const stats = await fs.lstat(target).catch((error: unknown) => {
    if (!isErrno(error) || error.code !== "ENOENT") {
      throw error;
    }
    return null;
  });
  const verified =
    stats &&
    (params.verified && sameDirectory(params.verified.stats, stats)
      ? params.verified
      : await readCachedGeneration(target, params.operation));
  if (verified) {
    throwIfCancelled(params.operation);
    await fs.utimes(target, new Date(), new Date());
    return verified;
  }

  const staging = path.join(params.cacheDir, `.staging-${process.pid}-${randomUUID()}`);
  throwIfCancelled(params.operation);
  await fs.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const rootRealPath = await fs.realpath(params.root);
    let preparedDirectory: string | undefined;
    for (const entry of params.manifest.assets) {
      throwIfCancelled(params.operation);
      const contents = await readVerifiedAsset({
        entry,
        operation: params.operation,
        root: params.root,
        rootRealPath,
      });
      const destination = path.join(staging, entry.path);
      throwIfCancelled(params.operation);
      const directory = path.dirname(destination);
      // This preparer owns staging; adjacent assets can reuse its last created directory.
      if (directory !== preparedDirectory) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        preparedDirectory = directory;
      }
      throwIfCancelled(params.operation);
      await fs.writeFile(destination, contents, {
        mode: 0o600,
        signal: params.operation?.signal,
      });
    }
    throwIfCancelled(params.operation);
    await fs.writeFile(
      path.join(staging, CONTROL_UI_ASSET_MANIFEST_FILENAME),
      `${JSON.stringify(params.manifest)}\n`,
      { mode: 0o600, signal: params.operation?.signal },
    );
    throwIfCancelled(params.operation);
    let collision: NodeJS.ErrnoException | undefined;
    try {
      await fs.rename(staging, target);
    } catch (error) {
      // Node forwards native rename errno; nonempty directory collisions are
      // ENOTEMPTY on macOS and may be EEXIST on other filesystems.
      if (!isErrno(error) || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) {
        throw error;
      }
      collision = error;
    }
    const published = await readCachedGeneration(target, params.operation);
    if (!published) {
      throw collision ?? new Error(`Invalid retained Control UI generation: ${target}`);
    }
    throwIfCancelled(params.operation);
    await fs.utimes(target, new Date(), new Date());
    return published;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function pruneRetainedGenerations(params: {
  cacheDir: string;
  currentGeneration?: string;
  verified: RetainedGeneration[];
  now: number;
  operation?: RetentionOperation;
}): Promise<RetainedGeneration[]> {
  const inventory = await readCacheInventory(params.cacheDir, params.operation, params.verified);
  const generations = inventory.generations.toSorted((left, right) => {
    if (left.generation === params.currentGeneration) {
      return -1;
    }
    if (right.generation === params.currentGeneration) {
      return 1;
    }
    return compareGenerations(left, right);
  });
  const retained = new Set<string>();
  let retainedBytes = 0;
  for (const generation of generations) {
    if (
      retained.size < CONTROL_UI_RETAINED_GENERATION_LIMIT &&
      retainedBytes + generation.bytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES
    ) {
      retained.add(generation.generation);
      retainedBytes += generation.bytes;
    }
  }

  for (const [target, stats] of inventory.directories) {
    throwIfCancelled(params.operation);
    const name = path.basename(target);
    const generation = CONTROL_UI_GENERATION_PATTERN.test(name);
    const staleStaging =
      CONTROL_UI_STAGING_PATTERN.test(name) &&
      params.now - stats.mtimeMs >= CONTROL_UI_STAGING_MAX_AGE_MS;
    if ((!generation || retained.has(name)) && !staleStaging) {
      continue;
    }
    const currentStats = await fs.lstat(target).catch(() => null);
    throwIfCancelled(params.operation);
    // Never remove a replacement or a generation refreshed by another preparer.
    // Publications after this inventory belong to a later pruning pass.
    if (
      !currentStats ||
      !sameDirectory(stats, currentStats) ||
      stats.mtimeMs !== currentStats.mtimeMs
    ) {
      continue;
    }
    await fs.rm(target, { recursive: true, force: true });
  }
  const survivors: RetainedGeneration[] = [];
  for (const generation of inventory.generations) {
    if (!retained.has(generation.generation)) {
      continue;
    }
    const stats = await fs.lstat(generation.directory).catch(() => null);
    throwIfCancelled(params.operation);
    if (stats && sameDirectory(generation.stats, stats)) {
      survivors.push({ ...generation, stats });
    }
  }
  return survivors.toSorted(compareGenerations);
}

export function createControlUiAssetRetention(root: string): ControlUiAssetRetention {
  const cacheDir = resolveControlUiAssetCacheDir();
  let generations: RetainedGeneration[] = [];
  let preparing: Promise<void> | undefined;

  return {
    prepare(operation) {
      preparing ??= (async () => {
        throwIfCancelled(operation);
        await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await fs.chmod(cacheDir, 0o700);
        const inventory = await readCacheInventory(cacheDir, operation);
        throwIfCancelled(operation);
        generations = inventory.generations;
        const verified = [...generations];
        const manifest = await readAssetManifest(root, operation);
        const manifestBytes = manifest.assets.reduce((total, asset) => total + asset.size, 0);
        if (manifestBytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES) {
          const published = await publishGeneration({
            cacheDir,
            manifest,
            operation,
            root,
            verified: verified.find((entry) => entry.generation === manifest.generation),
          });
          verified.push(published);
        }
        const survivors = await pruneRetainedGenerations({
          cacheDir,
          verified,
          currentGeneration:
            manifestBytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES ? manifest.generation : undefined,
          now: Date.now(),
          operation,
        });
        throwIfCancelled(operation);
        generations = survivors;
      })().catch((error: unknown) => {
        preparing = undefined;
        throw error;
      });
      return preparing;
    },
    resolveAsset(assetPath) {
      for (const generation of generations) {
        if (!generation.assetPaths.has(assetPath)) {
          continue;
        }
        return {
          filePath: path.join(generation.directory, assetPath),
          rootPath: generation.directory,
          rootRealPath: generation.realPath,
        };
      }
      return null;
    },
  };
}
