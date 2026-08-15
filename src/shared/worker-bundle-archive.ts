import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { hashWorkerBundleManifest, type WorkerBundleHashEntry } from "./worker-bundle-hash.js";

export { DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } from "./worker-bundle-limits.js";

const MAX_ENTRY_PATH_LENGTH = 1024;
const MAX_ARCHIVE_DEPTH = 64;
const MAX_DECOMPRESSION_RATIO = 64;

type WorkerBundleArchiveLimits = {
  maxEntries: number;
  maxExpandedBytes: number;
};

function requireArchivePath(value: string): string {
  if (
    !value ||
    value.length > MAX_ENTRY_PATH_LENGTH ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    path.posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`Invalid worker bundle archive path: ${value}`);
  }
  return value;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function readWorkerBundleArchiveManifest(
  tarballPath: string,
  limits: WorkerBundleArchiveLimits,
): Promise<WorkerBundleHashEntry[]> {
  const pending: Array<{
    path: string;
    mode: number | undefined;
    headerSize: number;
    actualSize: number;
    type: string;
    sha256?: string;
    error?: Error;
  }> = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  await tar.list({
    file: tarballPath,
    strict: true,
    maxDepth: MAX_ARCHIVE_DEPTH,
    maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
    onReadEntry(entry) {
      const entryPath = requireArchivePath(entry.path);
      if (paths.has(entryPath)) {
        throw new Error(`Duplicate worker bundle archive path: ${entryPath}`);
      }
      paths.add(entryPath);
      if (paths.size > limits.maxEntries) {
        throw new Error("Worker bundle archive exceeds its entry limit");
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error(`Invalid worker bundle archive size: ${entryPath}`);
      }
      expandedBytes += entry.size;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
        throw new Error("Worker bundle archive exceeds its expanded byte limit");
      }
      const hash = createHash("sha256");
      const item = {
        path: entryPath,
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
  return pending
    .map((entry): WorkerBundleHashEntry => {
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
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function readWorkerBundleDirectoryManifest(params: {
  root: string;
  limits: WorkerBundleArchiveLimits;
  ignoreTopLevel?: ReadonlySet<string>;
}): Promise<WorkerBundleHashEntry[]> {
  const root = await fs.realpath(params.root);
  const entries: WorkerBundleHashEntry[] = [];
  let totalBytes = 0;
  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (!relativeRoot && params.ignoreTopLevel?.has(child.name)) {
        continue;
      }
      const relative = requireArchivePath(
        relativeRoot ? `${relativeRoot}/${child.name}` : child.name,
      );
      const absolute = path.join(directory, child.name);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw new Error(`Worker bundle contains a symbolic link: ${relative}`);
      }
      if (stats.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Worker bundle contains an unsupported entry: ${relative}`);
      }
      totalBytes += stats.size;
      if (
        entries.length >= params.limits.maxEntries ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > params.limits.maxExpandedBytes
      ) {
        throw new Error("Worker bundle directory exceeds its limits");
      }
      entries.push({
        path: relative,
        mode: stats.mode & 0o777,
        size: stats.size,
        sha256: await hashFile(absolute),
      });
    }
  };
  await visit(root, "");
  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function extractWorkerBundleArchive(params: {
  tarballPath: string;
  destination: string;
  expectedBundleHash: string;
  limits: WorkerBundleArchiveLimits;
}): Promise<void> {
  const manifest = await readWorkerBundleArchiveManifest(params.tarballPath, params.limits);
  if (hashWorkerBundleManifest(manifest) !== params.expectedBundleHash) {
    throw new Error("Worker bundle archive manifest does not match its expected hash");
  }
  const allowed = new Set(manifest.map((entry) => entry.path));
  await fs.mkdir(params.destination, { recursive: true, mode: 0o700 });
  await tar.extract({
    cwd: params.destination,
    file: params.tarballPath,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    chmod: true,
    processUmask: 0o077,
    maxDepth: MAX_ARCHIVE_DEPTH,
    maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
    filter: (entryPath) => allowed.has(entryPath),
  });
  const extracted = await readWorkerBundleDirectoryManifest({
    root: params.destination,
    limits: params.limits,
  });
  if (hashWorkerBundleManifest(extracted) !== params.expectedBundleHash) {
    throw new Error("Extracted worker bundle does not match its expected hash");
  }
}
