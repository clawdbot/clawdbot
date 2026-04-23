import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type QueuedFileWriter = {
  filePath: string;
  write: (line: string) => void;
  flush: () => Promise<void>;
};

export type QueuedFileWriterOptions = {
  maxFileBytes?: number;
};

type QueuedFileAppendFlagConstants = Pick<
  typeof nodeFs.constants,
  "O_APPEND" | "O_CREAT" | "O_WRONLY"
> &
  Partial<Pick<typeof nodeFs.constants, "O_NOFOLLOW">>;

export function resolveQueuedFileAppendFlags(
  constants: QueuedFileAppendFlagConstants = nodeFs.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_APPEND |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
}

async function assertNoSymlinkParents(filePath: string): Promise<void> {
  const resolvedDir = path.resolve(path.dirname(filePath));
  const parsed = path.parse(resolvedDir);
  const relativeParts = path.relative(parsed.root, resolvedDir).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      if (path.dirname(current) === parsed.root) {
        continue;
      }
      throw new Error(`Refusing to write queued log under symlinked directory: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to write queued log under non-directory: ${current}`);
    }
  }
}

function verifyStableOpenedFile(params: {
  preOpenStat?: nodeFs.Stats;
  postOpenStat: nodeFs.Stats;
  filePath: string;
}): void {
  if (!params.postOpenStat.isFile()) {
    throw new Error(`Refusing to write queued log to non-file: ${params.filePath}`);
  }
  if (params.postOpenStat.nlink > 1) {
    throw new Error(`Refusing to write queued log to hardlinked file: ${params.filePath}`);
  }
  const pre = params.preOpenStat;
  if (pre && (pre.dev !== params.postOpenStat.dev || pre.ino !== params.postOpenStat.ino)) {
    throw new Error(`Refusing to write queued log after file changed: ${params.filePath}`);
  }
}

async function safeAppendFile(
  filePath: string,
  line: string,
  options: QueuedFileWriterOptions,
): Promise<void> {
  await assertNoSymlinkParents(filePath);

  let preOpenStat: nodeFs.Stats | undefined;
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write queued log through symlink: ${filePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Refusing to write queued log to non-file: ${filePath}`);
    }
    preOpenStat = stat;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (
    options.maxFileBytes !== undefined &&
    (preOpenStat?.size ?? 0) + lineBytes > options.maxFileBytes
  ) {
    return;
  }

  const handle = await fs.open(filePath, resolveQueuedFileAppendFlags(), 0o600);
  try {
    const stat = await handle.stat();
    verifyStableOpenedFile({ preOpenStat, postOpenStat: stat, filePath });
    if (options.maxFileBytes !== undefined && stat.size + lineBytes > options.maxFileBytes) {
      return;
    }
    await handle.chmod(0o600);
    await handle.appendFile(line, "utf8");
  } finally {
    await handle.close();
  }
}

export function getQueuedFileWriter(
  writers: Map<string, QueuedFileWriter>,
  filePath: string,
  options: QueuedFileWriterOptions = {},
): QueuedFileWriter {
  const existing = writers.get(filePath);
  if (existing) {
    return existing;
  }

  const dir = path.dirname(filePath);
  const ready = fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  let queue = Promise.resolve();

  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      queue = queue
        .then(() => ready)
        .then(() => safeAppendFile(filePath, line, options))
        .catch(() => undefined);
    },
    flush: async () => {
      await queue;
    },
  };

  writers.set(filePath, writer);
  return writer;
}
