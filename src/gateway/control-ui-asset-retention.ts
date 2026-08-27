// Retains bounded, manifest-verified Control UI generations for already-open documents.
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
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
  manifest: ControlUiAssetManifest;
  modifiedAtMs: number;
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

async function readManifestFile(
  manifestPath: string,
  operation?: RetentionOperation,
): Promise<ControlUiAssetManifest | null> {
  try {
    throwIfCancelled(operation);
    const stats = await fs.lstat(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > CONTROL_UI_MANIFEST_MAX_BYTES) {
      return null;
    }
    const contents = await fs.readFile(manifestPath, {
      encoding: "utf8",
      signal: operation?.signal,
    });
    throwIfCancelled(operation);
    return parseControlUiAssetManifest(JSON.parse(contents));
  } catch {
    throwIfCancelled(operation);
    return null;
  }
}

async function readCachedGeneration(
  cacheRealPath: string,
  entry: Dirent,
  operation?: RetentionOperation,
): Promise<RetainedGeneration | null> {
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    !CONTROL_UI_GENERATION_PATTERN.test(entry.name)
  ) {
    return null;
  }
  const directory = path.join(cacheRealPath, entry.name);
  try {
    throwIfCancelled(operation);
    const realPath = await fs.realpath(directory);
    if (!isWithinDir(cacheRealPath, realPath)) {
      return null;
    }
    const manifest = await readManifestFile(
      path.join(realPath, CONTROL_UI_ASSET_MANIFEST_FILENAME),
      operation,
    );
    if (!manifest || manifest.generation !== entry.name) {
      return null;
    }
    for (const asset of manifest.assets) {
      throwIfCancelled(operation);
      const assetPath = path.join(realPath, asset.path);
      const stats = await fs.lstat(assetPath);
      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        stats.size !== asset.size ||
        createHash("sha256")
          .update(await fs.readFile(assetPath, { signal: operation?.signal }))
          .digest("hex") !== asset.sha256
      ) {
        return null;
      }
    }
    return {
      assetPaths: new Set(manifest.assets.map((asset) => asset.path)),
      bytes: manifest.assets.reduce((total, asset) => total + asset.size, 0),
      directory,
      generation: manifest.generation,
      manifest,
      modifiedAtMs: (await fs.stat(realPath)).mtimeMs,
      realPath,
    };
  } catch {
    throwIfCancelled(operation);
    return null;
  }
}

async function loadCachedGenerations(
  cacheDir: string,
  operation?: RetentionOperation,
): Promise<RetainedGeneration[]> {
  let cacheRealPath: string;
  let entries: Dirent[];
  try {
    throwIfCancelled(operation);
    cacheRealPath = await fs.realpath(cacheDir);
    entries = await fs.readdir(cacheRealPath, { withFileTypes: true });
  } catch {
    throwIfCancelled(operation);
    return [];
  }
  const generations: RetainedGeneration[] = [];
  for (const entry of entries) {
    throwIfCancelled(operation);
    const generation = await readCachedGeneration(cacheRealPath, entry, operation);
    if (generation) {
      generations.push(generation);
    }
  }
  return generations.toSorted(
    (left, right) =>
      right.modifiedAtMs - left.modifiedAtMs || left.generation.localeCompare(right.generation),
  );
}

async function readCurrentManifest(
  root: string,
  operation?: RetentionOperation,
): Promise<ControlUiAssetManifest> {
  const manifestPath = path.join(root, CONTROL_UI_ASSET_MANIFEST_FILENAME);
  throwIfCancelled(operation);
  const stats = await fs.lstat(manifestPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > CONTROL_UI_MANIFEST_MAX_BYTES) {
    throw new Error(`Invalid Control UI asset manifest: ${manifestPath}`);
  }
  const manifest = parseControlUiAssetManifest(
    JSON.parse(await fs.readFile(manifestPath, { encoding: "utf8", signal: operation?.signal })),
  );
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
  operation?: RetentionOperation;
  root: string;
}): Promise<void> {
  const target = path.join(params.cacheDir, params.manifest.generation);
  if (
    (await loadCachedGenerations(params.cacheDir, params.operation)).some(
      (entry) => entry.generation === params.manifest.generation,
    )
  ) {
    await fs.utimes(target, new Date(), new Date());
    return;
  }

  const staging = path.join(params.cacheDir, `.staging-${process.pid}-${randomUUID()}`);
  throwIfCancelled(params.operation);
  await fs.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const rootRealPath = await fs.realpath(params.root);
    for (const entry of params.manifest.assets) {
      throwIfCancelled(params.operation);
      const contents = await readVerifiedAsset({
        entry,
        operation: params.operation,
        root: params.root,
        rootRealPath,
      });
      const destination = path.join(staging, entry.path);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
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
    try {
      await fs.rename(staging, target);
    } catch (error) {
      if (!isErrno(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (
        !(await loadCachedGenerations(params.cacheDir, params.operation)).some(
          (entry) => entry.generation === params.manifest.generation,
        )
      ) {
        throw error;
      }
    }
    await fs.utimes(target, new Date(), new Date());
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function pruneRetainedGenerations(params: {
  cacheDir: string;
  currentGeneration?: string;
  maxBytes: number;
  maxGenerations: number;
  now: number;
  operation?: RetentionOperation;
}): Promise<void> {
  const generations = (await loadCachedGenerations(params.cacheDir, params.operation)).toSorted(
    (left, right) => {
      if (left.generation === params.currentGeneration) {
        return -1;
      }
      if (right.generation === params.currentGeneration) {
        return 1;
      }
      return (
        right.modifiedAtMs - left.modifiedAtMs || left.generation.localeCompare(right.generation)
      );
    },
  );
  const retained = new Set<string>();
  let retainedBytes = 0;
  for (const generation of generations) {
    if (
      retained.size < params.maxGenerations &&
      retainedBytes + generation.bytes <= params.maxBytes
    ) {
      retained.add(generation.generation);
      retainedBytes += generation.bytes;
    }
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(params.cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    throwIfCancelled(params.operation);
    const generation = CONTROL_UI_GENERATION_PATTERN.test(entry.name);
    const staleStaging =
      CONTROL_UI_STAGING_PATTERN.test(entry.name) &&
      params.now - (await fs.lstat(path.join(params.cacheDir, entry.name))).mtimeMs >=
        CONTROL_UI_STAGING_MAX_AGE_MS;
    if ((!generation || retained.has(entry.name)) && !staleStaging) {
      continue;
    }
    const target = path.join(params.cacheDir, entry.name);
    const stats = await fs.lstat(target).catch(() => null);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      continue;
    }
    await fs.rm(target, { recursive: true, force: true });
  }
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
        generations = await loadCachedGenerations(cacheDir, operation);
        const manifest = await readCurrentManifest(root, operation);
        const manifestBytes = manifest.assets.reduce((total, asset) => total + asset.size, 0);
        if (manifestBytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES) {
          await publishGeneration({ cacheDir, manifest, operation, root });
        }
        await pruneRetainedGenerations({
          cacheDir,
          currentGeneration:
            manifestBytes <= CONTROL_UI_RETAINED_ASSET_MAX_BYTES ? manifest.generation : undefined,
          maxBytes: CONTROL_UI_RETAINED_ASSET_MAX_BYTES,
          maxGenerations: CONTROL_UI_RETAINED_GENERATION_LIMIT,
          now: Date.now(),
          operation,
        });
        generations = await loadCachedGenerations(cacheDir, operation);
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
