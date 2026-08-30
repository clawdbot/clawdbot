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

function listFilesRecursively(
  rootPath: string,
  fsImpl: typeof fs,
  cacheEntry: BuildCachePath = { path: rootPath },
) {
  let stat;
  try {
    stat = fsImpl.statSync(rootPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return cacheEntryIncludesFile(cacheEntry, rootPath) ? [rootPath] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const out: string[] = [];
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
      out.push(...listFilesRecursively(entryPath, fsImpl, cacheEntry));
    } else if (dirent.isFile() && cacheEntryIncludesFile(cacheEntry, entryPath)) {
      out.push(entryPath);
    }
  }
  return out;
}

export function listCacheFiles(rootDir: string, entries: BuildCacheEntry[], fsImpl: typeof fs) {
  return entries
    .map((entry) => (typeof entry === "string" ? { path: entry } : entry))
    .flatMap((entry) => listFilesRecursively(path.resolve(rootDir, entry.path), fsImpl, entry))
    .toSorted();
}

export function portableRelativePath(rootDir: string, filePath: string) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

export function hashInputFiles(
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
export function collectArtifactRecord(
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

export function artifactRecordMatches(
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
export function resolveTsdownCompilerIdentity() {
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
