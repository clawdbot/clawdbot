import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  ArchiveSecurityError,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  extractArchive,
  prepareArchiveDestinationDir,
  type ExtractArchiveOptions,
} from "@openclaw/fs-safe/archive";

type ArchiveRegularFileAliases = ReadonlyArray<
  readonly [source: string, destinations: readonly string[]]
>;

type ExtractArchiveInPrivateDestinationWithRegularFileAliasesOptions = ExtractArchiveOptions & {
  regularFileAliasRoot?: string;
  regularFileAliases?: ArchiveRegularFileAliases;
  requiredRegularFiles?: readonly string[];
};

type OperationDeadline = {
  signal: AbortSignal;
  check: () => void;
  remainingMs: () => number;
  wait: <T>(operation: () => Promise<T>) => Promise<T>;
  dispose: () => void;
};

type PlannedAlias = {
  sourcePath: string;
  destinationPath: string;
  mode: number;
  size: number;
};

type ResolvedAliasLimits = {
  maxEntries: number;
  maxExtractedBytes: number;
  maxEntryBytes: number;
};

function resolveLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : fallback;
}

function resolveAliasLimits(limits: ExtractArchiveOptions["limits"]): ResolvedAliasLimits {
  return {
    maxEntries: resolveLimit(limits?.maxEntries, DEFAULT_MAX_ENTRIES),
    maxExtractedBytes: resolveLimit(limits?.maxExtractedBytes, DEFAULT_MAX_EXTRACTED_BYTES),
    maxEntryBytes: resolveLimit(limits?.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES),
  };
}

function countAliasEntries(aliases: ArchiveRegularFileAliases): number {
  return aliases.reduce((count, [, destinations]) => count + destinations.length, 0);
}

function createOperationDeadline(timeoutMs: number): OperationDeadline {
  const controller = new AbortController();
  const enabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const expiresAt = enabled ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const timeoutError = new Error(
    `extract archive with regular-file aliases timed out after ${timeoutMs}ms`,
  );
  const timeout = enabled
    ? setTimeout(() => {
        controller.abort(timeoutError);
      }, timeoutMs)
    : undefined;
  const check = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error ? controller.signal.reason : timeoutError;
    }
  };
  return {
    signal: controller.signal,
    check,
    remainingMs: () => {
      check();
      return enabled ? Math.max(1, expiresAt - Date.now()) : timeoutMs;
    },
    wait: async <T>(startOperation: () => Promise<T>): Promise<T> => {
      check();
      const operation = startOperation();
      if (!enabled) {
        return await operation;
      }
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          const abort = () =>
            reject(
              controller.signal.reason instanceof Error ? controller.signal.reason : timeoutError,
            );
          controller.signal.addEventListener("abort", abort, { once: true });
          const cleanup = () => controller.signal.removeEventListener("abort", abort);
          operation.then(cleanup, cleanup);
        }),
      ]);
    },
    dispose: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}

function assertManifestBasename(filename: string): string {
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    /[\\/]/u.test(filename) ||
    path.basename(filename) !== filename
  ) {
    throw new Error(`invalid archive regular-file manifest filename: ${filename}`);
  }
  return filename;
}

function resolveManifestRoot(destinationRealDir: string, manifestRoot: string): string {
  if (!manifestRoot || manifestRoot === ".") {
    return destinationRealDir;
  }
  if (path.isAbsolute(manifestRoot) || /\\/u.test(manifestRoot)) {
    throw new Error(`invalid archive regular-file manifest root: ${manifestRoot}`);
  }
  const parts = manifestRoot.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid archive regular-file manifest root: ${manifestRoot}`);
  }
  const resolved = path.resolve(destinationRealDir, ...parts);
  const relative = path.relative(destinationRealDir, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`invalid archive regular-file manifest root: ${manifestRoot}`);
  }
  return resolved;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    // SAFETY: the preceding structural checks prove `error` has an inspectable `code` property.
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function inspectExtractedTree(params: {
  rootDir: string;
  deadline: OperationDeadline;
}): Promise<{ entries: number; bytes: number }> {
  let entries = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const children = await params.deadline.wait(() =>
      fs.readdir(directory, { withFileTypes: true }),
    );
    for (const child of children) {
      params.deadline.check();
      entries += 1;
      const candidate = path.join(directory, child.name);
      const stat = await params.deadline.wait(() => fs.lstat(candidate));
      if (stat.isSymbolicLink()) {
        throw new ArchiveSecurityError(
          "entry-link",
          `archive output contains a link: ${child.name}`,
        );
      }
      if (stat.isDirectory()) {
        await walk(candidate);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) {
        throw new ArchiveSecurityError(
          "entry-link",
          `archive output contains an unsupported file alias: ${child.name}`,
        );
      }
      bytes += stat.size;
    }
  };
  await walk(params.rootDir);
  return { entries, bytes };
}

async function planAliases(params: {
  rootDir: string;
  aliases: ArchiveRegularFileAliases;
  requiredRegularFiles: readonly string[];
  deadline: OperationDeadline;
}): Promise<PlannedAlias[]> {
  const planned: PlannedAlias[] = [];
  const claimedNames = new Set<string>();
  for (const required of params.requiredRegularFiles) {
    const filename = assertManifestBasename(required);
    const stat = await params.deadline
      .wait(() => fs.lstat(path.join(params.rootDir, filename)))
      .catch((error: unknown) => {
        if (isNotFoundError(error)) {
          return undefined;
        }
        throw error;
      });
    if (!stat?.isFile() || stat.nlink > 1) {
      throw new Error(`archive does not contain required regular file ${filename}`);
    }
  }
  for (const [source, destinations] of params.aliases) {
    const sourceName = assertManifestBasename(source);
    const sourcePath = path.join(params.rootDir, sourceName);
    const sourceStat = await params.deadline
      .wait(() => fs.lstat(sourcePath))
      .catch((error: unknown) => {
        if (isNotFoundError(error)) {
          return undefined;
        }
        throw error;
      });
    if (!sourceStat?.isFile() || sourceStat.nlink > 1) {
      throw new Error(`archive does not contain regular alias source ${sourceName}`);
    }
    for (const rawDestination of destinations) {
      const destination = assertManifestBasename(rawDestination);
      if (claimedNames.has(destination)) {
        throw new Error(`duplicate archive regular-file alias destination: ${destination}`);
      }
      claimedNames.add(destination);
      const destinationPath = path.join(params.rootDir, destination);
      try {
        await params.deadline.wait(() => fs.lstat(destinationPath));
        throw new Error(`archive regular-file alias destination already exists: ${destination}`);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
      planned.push({
        sourcePath,
        destinationPath,
        mode: sourceStat.mode & 0o777,
        size: sourceStat.size,
      });
    }
  }
  return planned;
}

function assertCombinedLimits(params: {
  existingEntries: number;
  existingBytes: number;
  aliases: readonly PlannedAlias[];
  limits: ResolvedAliasLimits;
}): void {
  if (params.existingEntries + params.aliases.length > params.limits.maxEntries) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
  }
  if (params.aliases.some((alias) => alias.size > params.limits.maxEntryBytes)) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
  }
  const aliasBytes = params.aliases.reduce((total, alias) => total + alias.size, 0);
  if (params.existingBytes + aliasBytes > params.limits.maxExtractedBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
  }
}

async function copyPlannedAlias(alias: PlannedAlias, deadline: OperationDeadline): Promise<void> {
  const readable = fsSync.createReadStream(alias.sourcePath);
  const writable = fsSync.createWriteStream(alias.destinationPath, {
    flags: "wx",
    mode: alias.mode,
  });
  // The pipeline promise joins stream destruction after cancellation. Keep this promise in scope
  // through error cleanup so the private destination cannot be discarded while a copy is alive.
  const copyOperation = pipeline(readable, writable, { signal: deadline.signal });
  try {
    await copyOperation;
    deadline.check();
    const destinationStat = await deadline.wait(() => fs.lstat(alias.destinationPath));
    if (
      !destinationStat.isFile() ||
      destinationStat.nlink > 1 ||
      destinationStat.size !== alias.size
    ) {
      throw new Error(
        `archive regular-file alias copy failed: ${path.basename(alias.destinationPath)}`,
      );
    }
  } catch (error) {
    await copyOperation.catch(() => undefined);
    await fs.rm(alias.destinationPath, { force: true }).catch(() => undefined);
    deadline.check();
    throw error;
  }
}

/**
 * Extracts into a caller-owned empty private destination and materializes only closed-manifest
 * regular-file aliases under the same absolute deadline and output limits. The caller must keep
 * the directory unpublished until success and discard the whole directory after any error.
 */
export async function extractArchiveInPrivateDestinationWithRegularFileAliases(
  params: ExtractArchiveInPrivateDestinationWithRegularFileAliasesOptions,
): Promise<void> {
  const {
    regularFileAliasRoot = ".",
    regularFileAliases,
    requiredRegularFiles = [],
    ...extractOptions
  } = params;
  const aliasesManifest = regularFileAliases ?? [];
  const limits = resolveAliasLimits(params.limits);
  const aliasEntryCount = countAliasEntries(aliasesManifest);
  if (aliasEntryCount > limits.maxEntries) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
  }
  const deadline = createOperationDeadline(params.timeoutMs);
  try {
    const destinationRealDir = await deadline.wait(() =>
      prepareArchiveDestinationDir(params.destDir),
    );
    const initialEntries = await deadline.wait(() => fs.readdir(destinationRealDir));
    if (initialEntries.length > 0) {
      throw new Error(`private archive destination must be empty: ${params.destDir}`);
    }
    deadline.check();
    await extractArchive({
      ...extractOptions,
      timeoutMs: deadline.remainingMs(),
      limits: {
        ...extractOptions.limits,
        maxEntries: limits.maxEntries - aliasEntryCount,
      },
    });
    deadline.check();
    const manifestRoot = resolveManifestRoot(destinationRealDir, regularFileAliasRoot);
    const manifestRootReal = await deadline.wait(() => fs.realpath(manifestRoot));
    const relativeRoot = path.relative(destinationRealDir, manifestRootReal);
    if (
      relativeRoot === ".." ||
      relativeRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeRoot)
    ) {
      throw new ArchiveSecurityError("entry-link", "archive regular-file manifest root escapes");
    }
    const existing = await inspectExtractedTree({ rootDir: destinationRealDir, deadline });
    const aliases = await planAliases({
      rootDir: manifestRootReal,
      aliases: aliasesManifest,
      requiredRegularFiles,
      deadline,
    });
    assertCombinedLimits({
      existingEntries: existing.entries,
      existingBytes: existing.bytes,
      aliases,
      limits,
    });
    for (const alias of aliases) {
      await copyPlannedAlias(alias, deadline);
    }
    deadline.check();
  } finally {
    deadline.dispose();
  }
}
