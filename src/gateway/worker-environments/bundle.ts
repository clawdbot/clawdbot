import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { resolveStateDir } from "../../config/paths.js";
import { isExactSemverVersion } from "../../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { collectPackageDistInventory } from "../../infra/package-dist-inventory.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { VERSION } from "../../version.js";

export const WORKER_BUNDLE_MANIFEST_VERSION = "openclaw-worker-bundle-v1";
const OPENCLAW_NPM_REGISTRY = "https://registry.npmjs.org/";
const NPM_RELEASE_PROOF_TIMEOUT_MS = 60_000;
const NPM_SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;
// Host node_modules can contain platform-native code and is not portable to a leased box.
// The milestone-2 worker entry must therefore be self-contained inside the built dist.
const WORKER_BUNDLE_RUNTIME_FILES = ["openclaw.mjs", "package.json"] as const;

type WorkerInstallationArtifactBase = {
  bundleHash: string;
  openclawVersion: string;
  protocolFeatures: readonly string[];
};

export type WorkerBundleArtifact = WorkerInstallationArtifactBase & {
  install: "bundle";
  tarballSha256: string;
  tarballPath: string;
};

export type WorkerNpmArtifact = WorkerInstallationArtifactBase & {
  install: "npm";
  packageIntegrity: string;
  packageSpec: string;
};

export type WorkerInstallationArtifact = WorkerBundleArtifact | WorkerNpmArtifact;

export type WorkerBundleProducer = {
  prepare: () => Promise<WorkerBundleArtifact>;
};

export type WorkerBundleProducerOptions = {
  packageRoot?: string;
  cacheDir?: string;
  openclawVersion?: string;
  protocolFeatures?: readonly string[];
};

export type WorkerNpmPackageInstallCheck = (packageRoot: string) => Promise<boolean>;
export type WorkerNpmReleaseVerifier = (params: {
  bundleHash: string;
  version: string;
}) => Promise<string>;
export type WorkerNpmProofCommandRunner = typeof runCommandWithTimeout;

type WorkerBundleManifestEntry = {
  path: string;
  mode: number;
  size: number;
  sha256: string;
};

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeProtocolFeatures(features: readonly string[]): string[] {
  const normalized = features.map((feature) => feature.trim());
  if (normalized.some((feature) => feature.length === 0)) {
    throw new Error("Worker protocol features must be non-empty strings");
  }
  return [...new Set(normalized)].toSorted(comparePaths);
}

function resolvePackageRoot(packageRoot: string | undefined): string {
  if (packageRoot) {
    return path.resolve(packageRoot);
  }
  const resolved = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!resolved) {
    throw new Error("Unable to locate the running OpenClaw package root for worker bundling");
  }
  return resolved;
}

async function isReleasedPackageInstall(packageRoot: string): Promise<boolean> {
  const entries = new Set(await fs.readdir(packageRoot));
  return (
    entries.has("npm-shrinkwrap.json") &&
    !entries.has(".git") &&
    !entries.has("pnpm-lock.yaml") &&
    !entries.has("bun.lock") &&
    !entries.has("bun.lockb")
  );
}

type NpmPackageIdentity = {
  filename?: string;
  name: string;
  version: string;
  integrity: string;
};

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseNpmPackageIdentity(value: unknown): NpmPackageIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const name = readNonEmptyString(record, "name");
  const version = readNonEmptyString(record, "version");
  const integrity =
    readNonEmptyString(record, "integrity") ?? readNonEmptyString(record, "dist.integrity");
  const filename = readNonEmptyString(record, "filename");
  return name && version && integrity ? { name, version, integrity, filename } : undefined;
}

async function runNpmProofCommand(params: {
  argv: string[];
  cwd: string;
  failureMessage: string;
  runCommand: WorkerNpmProofCommandRunner;
}): Promise<unknown> {
  let result;
  try {
    result = await params.runCommand(params.argv, {
      cwd: params.cwd,
      timeoutMs: NPM_RELEASE_PROOF_TIMEOUT_MS,
      env: {
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
    });
  } catch {
    throw new Error(params.failureMessage);
  }
  if (result.code !== 0 || result.stdoutTruncatedBytes) {
    throw new Error(params.failureMessage);
  }
  try {
    return JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw new Error(params.failureMessage);
  }
}

async function updateHashFromFile(
  hash: ReturnType<typeof createHash>,
  filePath: string,
): Promise<void> {
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
}

async function hashNpmTarballIntegrity(tarballPath: string): Promise<string> {
  const hash = createHash("sha512");
  await updateHashFromFile(hash, tarballPath);
  return `sha512-${hash.digest("base64")}`;
}

async function hashWorkerBundleTarball(tarballPath: string): Promise<string> {
  const hash = createHash("sha256");
  await updateHashFromFile(hash, tarballPath);
  return hash.digest("hex");
}

export async function verifyPublishedNpmRelease(params: {
  bundleHash: string;
  version: string;
  runCommand?: WorkerNpmProofCommandRunner;
}): Promise<string> {
  const runCommand = params.runCommand ?? runCommandWithTimeout;
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-npm-proof-"));
  try {
    const published = parseNpmPackageIdentity(
      await runNpmProofCommand({
        argv: [
          "npm",
          "view",
          `openclaw@${params.version}`,
          "name",
          "version",
          "dist.integrity",
          "--json",
          `--registry=${OPENCLAW_NPM_REGISTRY}`,
        ],
        cwd: temporaryRoot,
        failureMessage: `OpenClaw ${params.version} is not published; use the worker bundle install`,
        runCommand,
      }),
    );
    if (
      published?.name !== "openclaw" ||
      published.version !== params.version ||
      !NPM_SHA512_INTEGRITY_PATTERN.test(published.integrity)
    ) {
      throw new Error(
        `Cannot verify exact public npm release openclaw@${params.version}; use the worker bundle install`,
      );
    }
    const packedValue = await runNpmProofCommand({
      argv: [
        "npm",
        "pack",
        `openclaw@${params.version}`,
        "--pack-destination",
        temporaryRoot,
        "--ignore-scripts",
        "--json",
        `--registry=${OPENCLAW_NPM_REGISTRY}`,
      ],
      cwd: temporaryRoot,
      failureMessage:
        "Unable to verify the installed OpenClaw package; use the worker bundle install",
      runCommand,
    });
    const packed = Array.isArray(packedValue) ? parseNpmPackageIdentity(packedValue[0]) : undefined;
    if (!packed?.filename || path.basename(packed.filename) !== packed.filename) {
      throw new Error("npm pack returned incomplete worker package metadata");
    }
    const packedTarballPath = path.join(temporaryRoot, packed.filename);
    let packedTarballIntegrity: string;
    try {
      packedTarballIntegrity = await hashNpmTarballIntegrity(packedTarballPath);
    } catch {
      throw new Error(
        "Unable to verify the installed OpenClaw package; use the worker bundle install",
      );
    }
    if (
      packed.name !== published.name ||
      packed.version !== published.version ||
      packed.integrity !== published.integrity ||
      packedTarballIntegrity !== published.integrity
    ) {
      throw new Error(
        `Installed OpenClaw ${params.version} does not match the published package; use the worker bundle install`,
      );
    }
    const extractedRoot = path.join(temporaryRoot, "package");
    await fs.mkdir(extractedRoot);
    await tar.extract({
      cwd: extractedRoot,
      file: packedTarballPath,
      preservePaths: false,
      strict: true,
      strip: 1,
    });
    const packedBundle = await prepareWorkerBundle({
      packageRoot: extractedRoot,
      cacheDir: path.join(temporaryRoot, "bundle-cache"),
      openclawVersion: params.version,
    });
    if (packedBundle.bundleHash !== params.bundleHash) {
      throw new Error(
        `Published OpenClaw ${params.version} does not match the prepared worker bundle; use the worker bundle install`,
      );
    }
    return published.integrity;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function normalizePortableMode(mode: number, relativePath: string): number {
  return relativePath === "openclaw.mjs" || (mode & 0o111) !== 0 ? 0o700 : 0o600;
}

async function stageManifestEntry(
  sourceRoot: string,
  sourceRootRealPath: string,
  stagingRoot: string,
  relativePath: string,
): Promise<WorkerBundleManifestEntry> {
  const sourcePath = path.join(sourceRoot, relativePath);
  const expectedRealPath = path.resolve(sourceRootRealPath, ...relativePath.split("/"));
  const sourceRealPath = await fs.realpath(sourcePath);
  if (sourceRealPath !== expectedRealPath) {
    throw new Error(`Unsafe worker bundle path: ${relativePath}`);
  }
  const stats = await fs.lstat(sourcePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Unsafe worker bundle path: ${relativePath}`);
  }
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let contents: Buffer;
  let mode: number;
  try {
    const openedStats = await handle.stat();
    const currentStats = await fs.lstat(sourcePath);
    const currentRealPath = await fs.realpath(sourcePath);
    if (
      !openedStats.isFile() ||
      currentStats.isSymbolicLink() ||
      !currentStats.isFile() ||
      currentRealPath !== expectedRealPath ||
      currentStats.dev !== openedStats.dev ||
      currentStats.ino !== openedStats.ino
    ) {
      throw new Error(`Worker bundle path changed while packaging: ${relativePath}`);
    }
    contents = await handle.readFile();
    mode = normalizePortableMode(openedStats.mode, relativePath);
  } finally {
    await handle.close();
  }
  const stagedPath = path.join(stagingRoot, relativePath);
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await fs.writeFile(stagedPath, contents, { mode });
  await fs.chmod(stagedPath, mode);
  return {
    path: relativePath,
    mode,
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function collectWorkerBundleManifest(
  sourceRoot: string,
  stagingRoot: string,
): Promise<WorkerBundleManifestEntry[]> {
  const sourceRootRealPath = await fs.realpath(sourceRoot);
  const distFiles = await collectPackageDistInventory(sourceRoot);
  if (distFiles.length === 0) {
    throw new Error(
      `OpenClaw worker bundle has no packaged dist files; build the running package at ${sourceRoot}`,
    );
  }
  const paths = [...WORKER_BUNDLE_RUNTIME_FILES, ...distFiles].toSorted(comparePaths);
  const entries: WorkerBundleManifestEntry[] = [];
  for (const relativePath of paths) {
    entries.push(
      await stageManifestEntry(sourceRoot, sourceRootRealPath, stagingRoot, relativePath),
    );
  }
  return entries;
}

function hashWorkerBundleManifest(entries: readonly WorkerBundleManifestEntry[]): string {
  const hash = createHash("sha256");
  hash.update(`${WORKER_BUNDLE_MANIFEST_VERSION}\0`);
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.sha256}\0`);
  }
  return hash.digest("hex");
}

function manifestsMatch(
  left: readonly WorkerBundleManifestEntry[],
  right: readonly WorkerBundleManifestEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.path === other.path &&
        entry.mode === other.mode &&
        entry.size === other.size &&
        entry.sha256 === other.sha256
      );
    })
  );
}

async function readTarballManifest(tarballPath: string): Promise<WorkerBundleManifestEntry[]> {
  const pending: Array<{
    path: string;
    mode: number | undefined;
    headerSize: number;
    actualSize: number;
    type: string;
    sha256?: string;
    error?: Error;
  }> = [];
  await tar.list({
    file: tarballPath,
    strict: true,
    onReadEntry(entry) {
      const hash = createHash("sha256");
      const item = {
        path: entry.path,
        mode: entry.mode,
        headerSize: entry.size,
        actualSize: 0,
        type: entry.type,
      } as (typeof pending)[number];
      pending.push(item);
      entry.on("data", (chunk: Buffer) => {
        item.actualSize += chunk.byteLength;
        hash.update(chunk);
      });
      entry.on("end", () => {
        item.sha256 = hash.digest("hex");
      });
      entry.on("error", (error) => {
        item.error = error instanceof Error ? error : new Error(String(error));
      });
    },
  });
  const entries = pending.map((entry): WorkerBundleManifestEntry => {
    if (entry.error) {
      throw entry.error;
    }
    if (
      entry.type !== "File" ||
      entry.mode === undefined ||
      entry.actualSize !== entry.headerSize ||
      entry.sha256 === undefined
    ) {
      throw new Error(`Invalid worker bundle tar entry: ${entry.path}`);
    }
    return {
      path: entry.path,
      mode: entry.mode,
      size: entry.actualSize,
      sha256: entry.sha256,
    };
  });
  return entries.toSorted((left, right) => comparePaths(left.path, right.path));
}

async function isCachedTarball(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Unsafe worker bundle cache path: ${filePath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function cachedTarballMatches(
  tarballPath: string,
  manifest: readonly WorkerBundleManifestEntry[],
): Promise<boolean> {
  if (!(await isCachedTarball(tarballPath))) {
    return false;
  }
  try {
    return manifestsMatch(await readTarballManifest(tarballPath), manifest);
  } catch {
    return false;
  }
}

async function writeTarball(params: {
  stagingRoot: string;
  entries: readonly WorkerBundleManifestEntry[];
  tarballPath: string;
}): Promise<void> {
  const temporaryPath = `${params.tarballPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await tar.create(
      {
        cwd: params.stagingRoot,
        file: temporaryPath,
        gzip: true,
        noDirRecurse: true,
        noMtime: true,
        portable: true,
        strict: true,
      },
      params.entries.map((entry) => entry.path),
    );
    try {
      await fs.rename(temporaryPath, params.tarballPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Another gateway process may have published the same content-addressed artifact.
      if (!(await cachedTarballMatches(params.tarballPath, params.entries))) {
        // Windows cannot replace an existing file with rename. The complete temp artifact
        // remains the publication source after the corrupt cache entry is removed.
        await fs.rm(params.tarballPath, { force: true });
        try {
          await fs.rename(temporaryPath, params.tarballPath);
        } catch (publishError) {
          if (
            (publishError as NodeJS.ErrnoException).code !== "EEXIST" ||
            !(await cachedTarballMatches(params.tarballPath, params.entries))
          ) {
            throw publishError;
          }
        }
      }
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function prepareWorkerBundle(
  options: WorkerBundleProducerOptions,
): Promise<WorkerBundleArtifact> {
  const packageRoot = resolvePackageRoot(options.packageRoot);
  const cacheDir = options.cacheDir
    ? path.resolve(options.cacheDir)
    : path.join(resolveStateDir(), "cache", "worker-bundles");
  const openclawVersion = (options.openclawVersion ?? VERSION).trim();
  if (!openclawVersion) {
    throw new Error("Worker bundle requires a non-empty OpenClaw version");
  }
  const protocolFeatures = normalizeProtocolFeatures(options.protocolFeatures ?? []);
  await fs.mkdir(cacheDir, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(cacheDir, ".staging-"));
  try {
    // Stage the exact bytes and modes first so a concurrent dev rebuild cannot make the
    // archived payload diverge from its content hash.
    const manifest = await collectWorkerBundleManifest(packageRoot, stagingRoot);
    const bundleHash = hashWorkerBundleManifest(manifest);
    const tarballPath = path.join(cacheDir, `${bundleHash}.tgz`);
    if (!(await cachedTarballMatches(tarballPath, manifest))) {
      await writeTarball({ stagingRoot, entries: manifest, tarballPath });
    }
    return {
      install: "bundle",
      bundleHash,
      openclawVersion,
      protocolFeatures,
      tarballSha256: await hashWorkerBundleTarball(tarballPath),
      tarballPath,
    };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

/** Creates a process-lifecycle bundle producer that scans the running build at most once. */
export function createWorkerBundleProducer(
  options: WorkerBundleProducerOptions = {},
): WorkerBundleProducer {
  let prepared: Promise<WorkerBundleArtifact> | undefined;
  return {
    prepare() {
      if (!prepared) {
        const pending = prepareWorkerBundle(options).catch((error: unknown) => {
          if (prepared === pending) {
            prepared = undefined;
          }
          throw error;
        });
        prepared = pending;
      }
      return prepared;
    },
  };
}

/**
 * Selects the exact npm package only after the public tarball's canonical worker manifest proves
 * parity with the running gateway bundle.
 */
export async function resolveWorkerNpmInstallationArtifact(params: {
  bundle: WorkerBundleArtifact;
  packageRoot?: string;
  isPackageInstall?: WorkerNpmPackageInstallCheck;
  verifyRelease?: WorkerNpmReleaseVerifier;
}): Promise<WorkerNpmArtifact> {
  const version = params.bundle.openclawVersion.trim();
  if (!isExactSemverVersion(version)) {
    throw new Error(
      `Worker npm install requires the exact published gateway version; expected ${version}`,
    );
  }
  const packageRoot = resolvePackageRoot(params.packageRoot);
  const packageInstall = params.isPackageInstall
    ? await params.isPackageInstall(packageRoot)
    : await isReleasedPackageInstall(packageRoot);
  if (!packageInstall) {
    throw new Error(
      "Worker npm install requires the gateway to run from a packaged release install",
    );
  }
  const packageIntegrity = await (params.verifyRelease ?? verifyPublishedNpmRelease)({
    bundleHash: params.bundle.bundleHash,
    version,
  });
  return {
    install: "npm",
    bundleHash: params.bundle.bundleHash,
    openclawVersion: version,
    packageIntegrity,
    protocolFeatures: params.bundle.protocolFeatures,
    packageSpec: `openclaw@${version}`,
  };
}
