// Shared content signatures and complete output inventories for build artifacts.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { acquireFileLockSync } from "@openclaw/fs-safe/file-lock";

export const ARTIFACT_CACHE_VERSION = 6;
export type BuildCachePath = {
  path: string;
  excludeDirectories?: string[];
  extensions?: string[];
  recursive?: boolean;
};
export type BuildCacheEntry = string | BuildCachePath;
export type ArtifactRecord = {
  version: number;
  signature: string;
  outputs: Record<string, string>;
  inputs?: string[];
};
function cacheEntryIncludesFile(entry: BuildCachePath, filePath: string) {
  if (!entry.extensions?.length) {
    return true;
  }
  return entry.extensions.some((extension) => filePath.endsWith(extension));
}

function collectCacheFiles(
  rootPath: string,
  fsImpl: typeof fs,
  cacheEntry: BuildCachePath,
  out: string[],
) {
  let stat;
  try {
    stat = fsImpl.statSync(rootPath);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (cacheEntryIncludesFile(cacheEntry, rootPath)) {
      out.push(rootPath);
    }
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  const entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  const recursive = cacheEntry.recursive !== false;
  for (const dirent of entries) {
    if (dirent.name === ".DS_Store") {
      continue;
    }
    const entryPath = path.join(rootPath, dirent.name);
    if (dirent.isDirectory() && cacheEntry.excludeDirectories?.includes(dirent.name)) {
      continue;
    }
    if (dirent.isDirectory() && recursive) {
      collectCacheFiles(entryPath, fsImpl, cacheEntry, out);
    } else if (dirent.isFile() && cacheEntryIncludesFile(cacheEntry, entryPath)) {
      out.push(entryPath);
    }
  }
}

export function listCacheFiles(rootDir: string, entries: BuildCacheEntry[], fsImpl: typeof fs) {
  // One inventory avoids copying each subtree and spreading unbounded argument lists.
  const files: string[] = [];
  for (const entry of entries) {
    const cacheEntry = typeof entry === "string" ? { path: entry } : entry;
    collectCacheFiles(path.resolve(rootDir, cacheEntry.path), fsImpl, cacheEntry, files);
  }
  return files.toSorted();
}

export function portableRelativePath(rootDir: string, filePath: string) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function hashInputFiles(
  rootDir: string,
  files: string[],
  fsImpl: typeof fs,
  envEntries: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  compilerIdentity = "",
) {
  const hash = createHash("sha256");
  hash.update(`v${ARTIFACT_CACHE_VERSION}\0node:${process.versions.node}\0${compilerIdentity}\0`);
  for (const name of envEntries.toSorted((left, right) => left.localeCompare(right))) {
    hash.update(`env:${name}`);
    hash.update("\0");
    hash.update(env[name] ?? "");
    hash.update("\0");
  }
  for (const file of files) {
    hash.update(portableRelativePath(rootDir, file));
    hash.update("\0");
    hash.update(fsImpl.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Records every successful output byte; a surviving barrel is not a complete generation. */
function collectArtifactRecord(
  rootDir: string,
  signature: string,
  entries: BuildCacheEntry[],
): ArtifactRecord {
  const outputs = Object.fromEntries(
    listCacheFiles(rootDir, entries, fs).map((file) => [
      portableRelativePath(rootDir, file),
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    ]),
  );
  return { version: ARTIFACT_CACHE_VERSION, signature, outputs };
}

export function readArtifactRecord(file: string): ArtifactRecord | undefined {
  try {
    const record: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !record ||
      typeof record !== "object" ||
      !("version" in record) ||
      record.version !== ARTIFACT_CACHE_VERSION ||
      !("signature" in record) ||
      typeof record.signature !== "string" ||
      !("outputs" in record) ||
      !record.outputs ||
      typeof record.outputs !== "object" ||
      Array.isArray(record.outputs)
    ) {
      return undefined;
    }
    const outputs = Object.entries(record.outputs);
    if (
      !outputs.length ||
      outputs.some(
        ([name, digest]) =>
          path.isAbsolute(name) ||
          name.split(/[\\/]/u).includes("..") ||
          typeof digest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(digest),
      )
    ) {
      return undefined;
    }
    return {
      version: ARTIFACT_CACHE_VERSION,
      signature: record.signature,
      outputs: Object.fromEntries(outputs),
      ...("inputs" in record &&
      Array.isArray(record.inputs) &&
      record.inputs.every((input) => typeof input === "string")
        ? { inputs: record.inputs }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function artifactRecordMatches(
  rootDir: string,
  record: ArtifactRecord | undefined,
  signature: string,
  required: string[] = [],
) {
  if (
    !record ||
    record.signature !== signature ||
    required.some((name) => !Object.hasOwn(record.outputs, name))
  ) {
    return false;
  }
  try {
    return Object.entries(record.outputs).every(
      ([name, digest]) =>
        createHash("sha256")
          .update(fs.readFileSync(path.resolve(rootDir, name)))
          .digest("hex") === digest,
    );
  } catch {
    return false;
  }
}

export function writeArtifactRecord(file: string, record: ArtifactRecord) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Copy only changed bytes, and prune only the caller's previous owned inventory. */
export function publishArtifactFiles(
  sourceRoot: string,
  targetRoot: string,
  files: string[],
  previous: string[] = [],
) {
  const selected = new Set(files);
  for (const file of files) {
    const source = path.resolve(sourceRoot, file);
    const target = path.resolve(targetRoot, file);
    const bytes = fs.readFileSync(source);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(bytes)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx" });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  for (const file of previous) {
    if (!selected.has(file)) {
      fs.rmSync(path.resolve(targetRoot, file), { force: true });
    }
  }
}

/** Identify the emitter selected from tsdown, not a separately hoisted dependency. */
function resolveTsdownCompilerIdentity() {
  const require = createRequire(import.meta.url);
  const tsdown = fs.realpathSync(require.resolve("tsdown"));
  const tsdownRequire = createRequire(tsdown);
  const dts = fs.realpathSync(tsdownRequire.resolve("rolldown-plugin-dts"));
  const compilerRequire = createRequire(dts);
  const hash = createHash("sha256");
  for (const file of [
    tsdown,
    require.resolve("tsdown/package.json"),
    dts,
    tsdownRequire.resolve("rolldown-plugin-dts/package.json"),
    compilerRequire.resolve("typescript"),
    compilerRequire.resolve("typescript/package.json"),
  ]) {
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function ownerIsDead(payload: unknown) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("pid" in payload) ||
    typeof payload.pid !== "number" ||
    !Number.isSafeInteger(payload.pid) ||
    payload.pid <= 0
  ) {
    return false;
  }
  try {
    process.kill(payload.pid, 0);
    return false;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH";
  }
}

/** Own only synchronous cache snapshots; process lifetimes need checkout ownership. */
export function acquireBuildArtifactLock(target: string, timeoutMs = 600_000) {
  return acquireFileLockSync(target, {
    timeoutMs,
    retry: { minTimeout: 500, maxTimeout: 500, factor: 1, randomize: false },
    payload: () => ({ pid: process.pid }),
    shouldReclaim: ({ payload }) => ownerIsDead(payload),
    staleRecovery: "remove-if-unchanged",
    shouldRemoveStaleLock: ({ payload }) => ownerIsDead(payload),
  });
}

export type BuildCache = {
  env?: string[];
  inputs: BuildCacheEntry[];
  outputs: BuildCacheEntry[];
  requiredOutputs?: string[] | ((env: NodeJS.ProcessEnv) => string[]);
  requiredCacheHitOutputs?: string[];
  restore?: "always";
  runOnHit?: { env?: NodeJS.ProcessEnv; finalize?: "refresh" };
};

export type BuildCacheStep = { label: string; env?: NodeJS.ProcessEnv; cache?: BuildCache };

type BuildCacheFs = typeof fs;
export type BuildCacheParams = {
  rootDir?: string;
  // A producer may publish from a private stage while its inputs remain checkout-relative.
  artifactRoot?: string;
  fs?: BuildCacheFs;
  env?: NodeJS.ProcessEnv;
};

function normalizePortablePath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

function resolveCacheRequiredOutputs(cache: BuildCache, env: NodeJS.ProcessEnv) {
  const outputs =
    typeof cache.requiredOutputs === "function"
      ? cache.requiredOutputs(env)
      : (cache.requiredOutputs ?? []);
  return outputs.map((output) => normalizePortablePath(output));
}

function resolveBuildCacheRoot(rootDir: string, env: NodeJS.ProcessEnv) {
  // Dev update preflight and final builds run in separate worktrees. A shared
  // root lets content signatures decide reuse without relocating built trees.
  const configuredRoot = env?.BUILD_ALL_CACHE_ROOT?.trim();
  if (!configuredRoot) {
    return path.resolve(rootDir, ".artifacts/build-all-cache");
  }
  return path.isAbsolute(configuredRoot)
    ? path.normalize(configuredRoot)
    : path.resolve(rootDir, configuredRoot);
}

function resolveCachePaths(rootDir: string, step: BuildCacheStep, env: NodeJS.ProcessEnv) {
  const safeLabel = step.label.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const cacheDir = path.join(resolveBuildCacheRoot(rootDir, env), safeLabel);
  return {
    cacheDir,
    outputRoot: path.join(cacheDir, "outputs"),
    stampPath: path.join(cacheDir, "stamp.json"),
  };
}

function hasAllFiles(rootDir: string, relativeFiles: string[], fsImpl: BuildCacheFs) {
  return relativeFiles.every((relativeFile) => {
    try {
      return fsImpl.statSync(path.resolve(rootDir, relativeFile)).isFile();
    } catch {
      return false;
    }
  });
}

export function resolveBuildStepCacheState(step: BuildCacheStep, params: BuildCacheParams = {}) {
  if (!step.cache) {
    return { cacheable: false, fresh: false, reason: "no-cache" };
  }
  const rootDir = params.rootDir ?? process.cwd();
  const artifactRoot = params.artifactRoot ?? rootDir;
  const fsImpl = params.fs ?? fs;
  const inputFiles = listCacheFiles(rootDir, step.cache.inputs, fsImpl);
  if (inputFiles.length === 0) {
    return { cacheable: true, fresh: false, reason: "missing-inputs" };
  }
  const signature = hashInputFiles(
    rootDir,
    inputFiles,
    fsImpl,
    step.cache.env ?? [],
    params.env ?? process.env,
    step.label.startsWith("tsdown") ? resolveTsdownCompilerIdentity() : "",
  );
  const { outputRoot, stampPath } = resolveCachePaths(rootDir, step, params.env ?? process.env);
  const lock = acquireBuildArtifactLock(stampPath);
  try {
    const stamp = readArtifactRecord(stampPath);
    const outputFiles = listCacheFiles(artifactRoot, step.cache.outputs, fsImpl);
    const relativeOutputFiles = outputFiles.map((file) => portableRelativePath(artifactRoot, file));
    const stampedOutputs = Object.keys(stamp?.outputs ?? {});
    const requiredOutputs = resolveCacheRequiredOutputs(step.cache, params.env ?? process.env);
    const actualOutputsPresent = artifactRecordMatches(
      artifactRoot,
      stamp,
      signature,
      requiredOutputs,
    );
    const cachedOutputsPresent = artifactRecordMatches(
      outputRoot,
      stamp,
      signature,
      requiredOutputs,
    );
    const stampMatches = stamp?.signature === signature;
    const cacheHitContractMatches =
      stampMatches && hasAllFiles(artifactRoot, step.cache.requiredCacheHitOutputs ?? [], fsImpl);
    const alwaysRestore = step.cache.restore === "always";
    const actualOutputsAcceptable = actualOutputsPresent && !alwaysRestore;
    const restorable =
      cacheHitContractMatches && cachedOutputsPresent && (alwaysRestore || !actualOutputsPresent);
    const fresh = cacheHitContractMatches && (actualOutputsAcceptable || cachedOutputsPresent);
    return {
      cacheable: true,
      fresh,
      restorable,
      reason: fresh ? (restorable ? "fresh-cache" : "fresh") : "stale",
      signature,
      outputRoot,
      stampPath,
      inputFiles: inputFiles.length,
      outputFiles: outputFiles.length,
      relativeOutputFiles,
      stampedOutputs,
      record: stamp,
    };
  } finally {
    lock.release();
  }
}

export type BuildCacheState = ReturnType<typeof resolveBuildStepCacheState>;

export function writeBuildStepCacheStamp(
  step: BuildCacheStep,
  cacheState: BuildCacheState,
  params: Pick<BuildCacheParams, "rootDir" | "artifactRoot" | "fs" | "env"> = {},
) {
  if (
    !step.cache ||
    !cacheState.cacheable ||
    !cacheState.signature ||
    !cacheState.stampPath ||
    !cacheState.outputRoot ||
    !cacheState.relativeOutputFiles?.length
  ) {
    return;
  }
  const fsImpl = params.fs ?? fs;
  const rootDir = params.artifactRoot ?? params.rootDir ?? process.cwd();
  const requiredOutputs = resolveCacheRequiredOutputs(step.cache, params.env ?? process.env);
  const relativeOutputSet = new Set(
    cacheState.relativeOutputFiles.map((output) => normalizePortablePath(output)),
  );
  // Validate before copying so an incomplete run cannot mutate the cached tree
  // while leaving its previous stamp in place.
  if (
    !requiredOutputs.every((output) => relativeOutputSet.has(output)) ||
    !hasAllFiles(rootDir, requiredOutputs, fsImpl)
  ) {
    return;
  }
  const lock = acquireBuildArtifactLock(cacheState.stampPath);
  try {
    const record = collectArtifactRecord(
      rootDir,
      cacheState.signature,
      cacheState.relativeOutputFiles,
    );
    // Invalidate before the first copied byte; readers and publishers use this
    // same lock, so neither crashes nor overlap can expose a partial snapshot.
    fsImpl.rmSync(cacheState.stampPath, { force: true });
    // This cache tree belongs entirely to the step. Replace it even when an old
    // or missing record cannot enumerate obsolete bytes for pruning.
    fsImpl.rmSync(cacheState.outputRoot, { force: true, recursive: true });
    publishArtifactFiles(rootDir, cacheState.outputRoot, Object.keys(record.outputs));
    if (
      !artifactRecordMatches(cacheState.outputRoot, record, cacheState.signature, requiredOutputs)
    ) {
      throw new Error(`Incomplete build cache snapshot: ${step.label}`);
    }
    writeArtifactRecord(cacheState.stampPath, record);
  } finally {
    lock.release();
  }
}

export function resolveBuildStepCacheStampState(
  step: BuildCacheStep,
  cacheState: BuildCacheState,
  params: Pick<BuildCacheParams, "rootDir" | "artifactRoot" | "fs"> = {},
) {
  if (!cacheState.cacheable || !cacheState.signature || !step.cache) {
    return cacheState;
  }
  const rootDir = params.artifactRoot ?? params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const outputFiles = listCacheFiles(rootDir, step.cache.outputs, fsImpl);
  return {
    ...cacheState,
    outputFiles: outputFiles.length,
    relativeOutputFiles: outputFiles.map((file) => portableRelativePath(rootDir, file)),
  };
}

export function restoreBuildStepCacheOutputs(
  cacheState: BuildCacheState,
  params: Pick<BuildCacheParams, "rootDir" | "artifactRoot" | "fs"> = {},
) {
  if (!cacheState.restorable || !cacheState.outputRoot || !cacheState.stampedOutputs?.length) {
    return false;
  }
  if (!cacheState.stampPath || !cacheState.signature || !cacheState.record) {
    return false;
  }
  const lock = acquireBuildArtifactLock(cacheState.stampPath);
  try {
    const record = readArtifactRecord(cacheState.stampPath);
    if (
      JSON.stringify(record) !== JSON.stringify(cacheState.record) ||
      !artifactRecordMatches(cacheState.outputRoot, record, cacheState.signature)
    ) {
      return false;
    }
    publishArtifactFiles(
      cacheState.outputRoot,
      params.artifactRoot ?? params.rootDir ?? process.cwd(),
      cacheState.stampedOutputs,
      cacheState.relativeOutputFiles,
    );
    return true;
  } finally {
    lock.release();
  }
}

export function finalizeBuildStepCache(
  step: BuildCacheStep,
  cacheState: BuildCacheState,
  params: BuildCacheParams & { reusedCache?: boolean } = {},
) {
  if (params.reusedCache && step.cache?.runOnHit?.finalize !== "refresh") {
    return restoreBuildStepCacheOutputs(cacheState, params);
  }
  // Validator-style cache hits may update a restored seed. Capture that result;
  // restoring the old seed here would silently discard the validated refresh.
  writeBuildStepCacheStamp(step, resolveBuildStepCacheStampState(step, cacheState, params), params);
  return true;
}
