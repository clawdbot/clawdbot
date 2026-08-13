import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import {
  getPublishFileExclusiveFailureDetails,
  publishFileNoClobber,
  syncDirectory,
} from "../../infra/directory-durability.js";
import { sameFileIdentity, type FileIdentityStat } from "../../infra/fs-safe-advanced.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import {
  createSessionArchiveCompressionStream,
  createSessionArchiveDecompressionStream,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "./archive-compression.js";
import { formatSessionArchiveTimestamp, type SessionArchiveReason } from "./artifacts.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";

export type SessionStateDeleteSnapshot = {
  acpParentStreamEventCount: number;
  generation: string | null;
  lastSeq: number | null;
  sessionUpdatedAt: number | null;
  trajectoryLastSeq: number | null;
  transcriptUpdatedAt: number | null;
};

export type SessionStateDeletePlan = {
  agentId: string;
  archiveDirectory: string;
  archiveTranscript: boolean;
  databasePath: string;
  reason: "deleted" | "reset";
  sessionId: string;
  snapshot: SessionStateDeleteSnapshot;
};

export type MaterializedSessionStateDeletePlan = SessionStateDeletePlan & {
  archivedTranscript: SessionLifecycleArchivedTranscript | null;
};

export type TranscriptArchiveWorkerPlan = Pick<
  SessionStateDeletePlan,
  "agentId" | "archiveDirectory" | "databasePath" | "reason" | "sessionId" | "snapshot"
>;

export type TranscriptArchiveWorkerResult = {
  archivedPath: string | null;
  sessionId: string;
};

export type TranscriptArchiveWorkerMessage = {
  type: "done";
  results: TranscriptArchiveWorkerResult[];
};

export function sqliteSessionStateDeleteSnapshotsEqual(
  left: SessionStateDeleteSnapshot,
  right: SessionStateDeleteSnapshot,
): boolean {
  return (
    left.acpParentStreamEventCount === right.acpParentStreamEventCount &&
    left.generation === right.generation &&
    left.lastSeq === right.lastSeq &&
    left.sessionUpdatedAt === right.sessionUpdatedAt &&
    left.trajectoryLastSeq === right.trajectoryLastSeq &&
    left.transcriptUpdatedAt === right.transcriptUpdatedAt
  );
}

function resolveSqliteTranscriptArchivePath(params: {
  archiveDirectory: string;
  reason: SessionArchiveReason;
  sessionId: string;
  nowMs?: number;
}): string {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(
    archiveDirectory,
    `${params.sessionId}.jsonl.${params.reason}.${formatSessionArchiveTimestamp(params.nowMs)}`,
  );
  if (path.dirname(archivePath) !== archiveDirectory) {
    throw new Error(`Cannot archive SQLite transcript outside ${archiveDirectory}`);
  }
  return archivePath;
}

type TranscriptArchiveDigest = {
  byteLength: number;
  sha256: string;
};

type SqliteTranscriptArchiveContent =
  | { content: string; contentChunks?: never }
  | { content?: never; contentChunks: Iterable<Buffer> };

function transcriptArchiveDigestsEqual(
  left: TranscriptArchiveDigest | null,
  right: TranscriptArchiveDigest,
): boolean {
  return left?.byteLength === right.byteLength && left.sha256 === right.sha256;
}

async function readTranscriptArchiveDigest(params: {
  archivePath: string;
  compressed?: boolean;
}): Promise<TranscriptArchiveDigest | null> {
  const hash = createHash("sha256");
  let byteLength = 0;
  let decoder: ReturnType<typeof createSessionArchiveDecompressionStream> | null = null;
  let fileHandle: fs.promises.FileHandle | undefined;
  let file: fs.ReadStream | undefined;
  try {
    decoder =
      (params.compressed ?? params.archivePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX))
        ? createSessionArchiveDecompressionStream()
        : null;
    fileHandle = await fs.promises.open(params.archivePath, "r");
    file = fileHandle.createReadStream({ autoClose: false });
    const decoded = decoder ?? file;
    if (decoder) {
      file.once("error", (error) => decoder?.destroy(error));
      file.pipe(decoder);
    }
    for await (const value of decoded) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      byteLength += chunk.length;
      hash.update(chunk);
    }
    return { byteLength, sha256: hash.digest("hex") };
  } catch {
    return null;
  } finally {
    file?.destroy();
    decoder?.destroy();
    await fileHandle?.close().catch(() => undefined);
  }
}

async function findMatchingSqliteTranscriptArchiveStream(params: {
  archiveDirectory: string;
  expected: TranscriptArchiveDigest;
  reason: SessionArchiveReason;
  sessionId: string;
}): Promise<string | null> {
  let entries: string[];
  try {
    entries = fs.readdirSync(params.archiveDirectory);
  } catch {
    return null;
  }
  const prefix = `${params.sessionId}.jsonl.${params.reason}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.endsWith(".tmp")) {
      continue;
    }
    const archivePath = path.join(params.archiveDirectory, entry);
    try {
      if (!fs.statSync(archivePath).isFile()) {
        continue;
      }
      if (
        transcriptArchiveDigestsEqual(
          await readTranscriptArchiveDigest({ archivePath }),
          params.expected,
        )
      ) {
        return archivePath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function writeDurableArchiveStreamExclusive(params: {
  compressor: NodeJS.ReadWriteStream | null;
  contentChunks: Iterable<Buffer>;
  filePath: string;
}): Promise<TranscriptArchiveDigest> {
  const fd = fs.openSync(params.filePath, "wx", 0o600);
  const output = fs.createWriteStream(params.filePath, {
    autoClose: false,
    emitClose: false,
    fd,
  });
  const hash = createHash("sha256");
  let byteLength = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.length;
      hash.update(bytes);
      callback(null, bytes);
    },
  });
  let result: TranscriptArchiveDigest | undefined;
  let operationError: Error | undefined;
  try {
    const input = Readable.from(params.contentChunks, {
      highWaterMark: 1,
      objectMode: false,
    });
    if (params.compressor) {
      await pipeline(input, measure, params.compressor, output);
    } else {
      await pipeline(input, measure, output);
    }
    fs.fsyncSync(fd);
    result = { byteLength, sha256: hash.digest("hex") };
  } catch (error) {
    operationError =
      error instanceof Error
        ? error
        : new Error("SQLite transcript archive write failed", { cause: error });
  }
  let closeError: Error | undefined;
  try {
    fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") {
      closeError =
        error instanceof Error
          ? error
          : new Error("SQLite transcript archive close failed", { cause: error });
    }
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  if (!result) {
    throw new Error(`SQLite transcript archive write produced no result for ${params.filePath}`);
  }
  return result;
}

function removeArchiveTempBestEffort(tempPath: string): void {
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {
    // Preserve the archive or snapshot failure; abandoned temps are never retained archives.
  }
}

function removePublishedArchiveIfOwnedBestEffort(
  archivePath: string,
  expectedIdentity: FileIdentityStat,
): boolean {
  let currentIdentity: fs.Stats;
  try {
    currentIdentity = fs.lstatSync(archivePath);
  } catch {
    return false;
  }
  if (
    currentIdentity.isSymbolicLink() ||
    !currentIdentity.isFile() ||
    !sameFileIdentity(currentIdentity, expectedIdentity)
  ) {
    return false;
  }
  // Node has no cross-platform unlink-by-identity primitive. Keep the owner
  // check and unlink synchronous so no in-process task can replace the path.
  try {
    fs.unlinkSync(archivePath);
    return true;
  } catch {
    // Preserve the verification failure; a later retention sweep can retry cleanup.
    return false;
  }
}

function isArchivePublicationCollision(error: unknown): boolean {
  return (
    (error instanceof FsSafeError && error.code === "already-exists") ||
    (error as NodeJS.ErrnoException)?.code === "EEXIST"
  );
}

/** Writes or reuses a transcript archive through one bounded-memory publication path. */
export async function writeTranscriptArchive(
  params: {
    archiveDirectory: string;
    reason: SessionArchiveReason;
    sessionId: string;
    validateSource?: () => Promise<void> | void;
  } & SqliteTranscriptArchiveContent,
): Promise<string> {
  if ((params.content === undefined) === (params.contentChunks === undefined)) {
    throw new Error("SQLite transcript archive requires exactly one content source");
  }
  fs.mkdirSync(params.archiveDirectory, { recursive: true });
  const encoding = createSessionArchiveCompressionStream();
  const nowMs = Date.now();
  const tempPath = `${resolveSqliteTranscriptArchivePath({
    archiveDirectory: params.archiveDirectory,
    reason: params.reason,
    sessionId: params.sessionId,
    nowMs,
  })}${encoding.suffix}.${randomUUID()}.tmp`;
  try {
    const expected = await writeDurableArchiveStreamExclusive({
      compressor: encoding.stream,
      contentChunks: params.contentChunks ?? [Buffer.from(params.content ?? "", "utf8")],
      filePath: tempPath,
    });
    await params.validateSource?.();
    const existing = await findMatchingSqliteTranscriptArchiveStream({
      archiveDirectory: params.archiveDirectory,
      expected,
      reason: params.reason,
      sessionId: params.sessionId,
    });
    if (existing) {
      removeArchiveTempBestEffort(tempPath);
      return existing;
    }
    if (
      !transcriptArchiveDigestsEqual(
        await readTranscriptArchiveDigest({
          archivePath: tempPath,
          compressed: encoding.suffix === SESSION_ARCHIVE_ZSTD_SUFFIX,
        }),
        expected,
      )
    ) {
      throw new Error(`SQLite transcript archive verification failed for ${params.sessionId}`);
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const archivePath = `${resolveSqliteTranscriptArchivePath({
        archiveDirectory: params.archiveDirectory,
        reason: params.reason,
        sessionId: params.sessionId,
        nowMs: nowMs + attempt,
      })}${encoding.suffix}`;
      let publishedIdentity: FileIdentityStat | undefined;
      try {
        const publication = await publishFileNoClobber(tempPath, archivePath, {
          durability: "degrade",
          moveSource: true,
          strategy: "link-or-copy",
        });
        publishedIdentity = publication.identity;
        // Publication fences the bytes, but archive pruning can still unlink the
        // pathname after the helper's identity check. Preserve the lifecycle's
        // post-publication existence and content fence before rows may be deleted.
        if (
          !transcriptArchiveDigestsEqual(
            await readTranscriptArchiveDigest({ archivePath }),
            expected,
          )
        ) {
          throw new Error(`SQLite transcript archive verification failed for ${params.sessionId}`);
        }
        return archivePath;
      } catch (error) {
        const publicationFailure = getPublishFileExclusiveFailureDetails(error);
        const cleanupIdentity =
          publishedIdentity ??
          (publicationFailure?.targetCreated && publicationFailure.cleanup !== "removed"
            ? publicationFailure.targetIdentity
            : undefined);
        if (cleanupIdentity) {
          const removed = removePublishedArchiveIfOwnedBestEffort(archivePath, cleanupIdentity);
          if (removed) {
            await syncDirectory(path.dirname(archivePath)).catch(() => undefined);
          }
        }
        if (isArchivePublicationCollision(error)) {
          if (
            transcriptArchiveDigestsEqual(
              await readTranscriptArchiveDigest({ archivePath }),
              expected,
            )
          ) {
            removeArchiveTempBestEffort(tempPath);
            return archivePath;
          }
          continue;
        }
        throw error;
      }
    }
    throw new Error(`Could not create SQLite transcript archive for ${params.sessionId}`);
  } catch (error) {
    removeArchiveTempBestEffort(tempPath);
    throw error;
  }
}

function resolveSqliteTranscriptArchiveWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(
      path.join(distRoot, "config", "sessions", "session-accessor.sqlite-archive.worker.js"),
    );
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./session-accessor.sqlite-archive.worker${extension}`, currentModuleUrl);
}

function resolveSourceWorkerExecArgv(): string[] {
  // Node 22 can strip the .ts entrypoint itself, but `--import tsx` does not
  // register tsx's ESM resolver inside a Worker. Explicitly register the
  // supported programmatic API so source-tree .js specifiers map back to .ts.
  // Built .js workers do not use this development/test-only preload.
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const registerTsx = `import { register } from ${JSON.stringify(tsxApiUrl)}; register();`;
  return ["--import", `data:text/javascript,${encodeURIComponent(registerTsx)}`];
}

function spawnSqliteTranscriptArchiveWorker(
  plans: readonly TranscriptArchiveWorkerPlan[],
): Promise<TranscriptArchiveWorkerResult[]> {
  const workerUrl = resolveSqliteTranscriptArchiveWorkerUrl();
  let worker: Worker;
  try {
    const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts")
      ? resolveSourceWorkerExecArgv()
      : undefined;
    worker = new Worker(workerUrl, {
      workerData: { type: "sqlite-transcript-archive-v1", plans },
      execArgv: sourceWorkerExecArgv,
    });
  } catch (error) {
    return Promise.reject(toStringifiedError(error));
  }

  return new Promise((resolve, reject) => {
    let results: TranscriptArchiveWorkerResult[] | undefined;
    let workerError: Error | undefined;
    worker.once("message", (message: TranscriptArchiveWorkerMessage) => {
      results = message.results;
    });
    worker.once("error", (error) => {
      // An uncaught Worker error is followed by exit. Wait for that event so
      // callers never race the Worker's SQLite/file handles on Windows.
      workerError = toStringifiedError(error);
    });
    worker.once("exit", (code) => {
      worker.removeAllListeners();
      if (workerError) {
        reject(workerError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`SQLite transcript archive worker exited with code ${code}`));
        return;
      }
      if (!results) {
        reject(new Error("SQLite transcript archive worker exited without results"));
        return;
      }
      resolve(results);
    });
  });
}

// Serialize lifecycle archive Workers so this path cannot multiply
// whole-buffer usage across several Worker heaps at once.
const sqliteTranscriptArchiveWorkerQueue = new KeyedAsyncQueue();
const SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY = "lifecycle-archive";

function runSqliteTranscriptArchiveWorker(
  plans: readonly TranscriptArchiveWorkerPlan[],
): Promise<TranscriptArchiveWorkerResult[]> {
  return sqliteTranscriptArchiveWorkerQueue.enqueue(
    SQLITE_TRANSCRIPT_ARCHIVE_WORKER_QUEUE_KEY,
    () => spawnSqliteTranscriptArchiveWorker(plans),
  );
}

// Runs duplicate probing, archive write, rename, fsync, and readback outside
// SQLite write transactions and off the gateway event loop. The lifecycle
// Worker queue and per-call dedupe prevent concurrent whole-buffer spikes
// within this path.
export async function materializeSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): Promise<MaterializedSessionStateDeletePlan[]> {
  const deduped = dedupeSqliteSessionStateDeletePlans(plans);
  const archivePlans = deduped.filter((plan) => plan.archiveTranscript);
  const workerResults =
    archivePlans.length > 0 ? await runSqliteTranscriptArchiveWorker(archivePlans) : [];
  const resultBySessionId = new Map(workerResults.map((result) => [result.sessionId, result]));

  return deduped.map((plan) => {
    if (!plan.archiveTranscript) {
      return Object.assign({}, plan, { archivedTranscript: null });
    }
    const result = resultBySessionId.get(plan.sessionId);
    if (!result) {
      throw new Error(`SQLite transcript archive worker omitted ${plan.sessionId}`);
    }
    const archivedTranscript = result.archivedPath
      ? {
          archivedPath: result.archivedPath,
          sourcePath: path.join(plan.archiveDirectory, `${plan.sessionId}.jsonl`),
        }
      : null;
    return Object.assign({}, plan, { archivedTranscript });
  });
}

// Multiple removed entries can point at one transcript session. If any owner
// asked to keep an archive, the shared row gets exported once.
function dedupeSqliteSessionStateDeletePlans(
  plans: readonly SessionStateDeletePlan[],
): SessionStateDeletePlan[] {
  const deduped = new Map<string, SessionStateDeletePlan>();
  for (const plan of plans) {
    const existing = deduped.get(plan.sessionId);
    if (!existing) {
      deduped.set(plan.sessionId, plan);
      continue;
    }
    if (
      existing.agentId !== plan.agentId ||
      existing.archiveDirectory !== plan.archiveDirectory ||
      existing.databasePath !== plan.databasePath ||
      existing.reason !== plan.reason ||
      !sqliteSessionStateDeleteSnapshotsEqual(existing.snapshot, plan.snapshot)
    ) {
      throw new Error(`Conflicting SQLite transcript archive plans for ${plan.sessionId}`);
    }
    if (!existing.archiveTranscript && plan.archiveTranscript) {
      deduped.set(plan.sessionId, { ...existing, archiveTranscript: true });
    }
  }
  return [...deduped.values()];
}
