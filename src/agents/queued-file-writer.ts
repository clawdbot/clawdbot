import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile, resolveRegularFileAppendFlags } from "../infra/fs-safe.js";

export type QueuedFileWriteResult = "queued" | "dropped";

export type QueuedFileWriter = {
  filePath: string;
  write: (line: string) => unknown;
  flush: () => Promise<void>;
};

type QueuedFileWriterOptions = {
  maxFileBytes?: number;
  maxQueuedBytes?: number;
  yieldBeforeWrite?: boolean;
};

export const resolveQueuedFileAppendFlags = resolveRegularFileAppendFlags;

async function safeAppendFile(
  filePath: string,
  line: string,
  options: QueuedFileWriterOptions,
): Promise<void> {
  await appendRegularFile({
    filePath,
    content: line,
    maxFileBytes: options.maxFileBytes,
    rejectSymlinkParents: true,
  });
}

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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
  let queue: Promise<unknown> = Promise.resolve();
  let queuedBytes = 0;

  const writer: QueuedFileWriter = {
    filePath,
    write: (line: string) => {
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (
        options.maxQueuedBytes !== undefined &&
        queuedBytes + lineBytes > options.maxQueuedBytes
      ) {
        return "dropped";
      }
      queuedBytes += lineBytes;
      queue = queue
        .then(() => ready)
        .then(() => (options.yieldBeforeWrite ? waitForImmediate() : undefined))
        .then(() => safeAppendFile(filePath, line, options))
        .catch(() => undefined)
        .finally(() => {
          queuedBytes = Math.max(0, queuedBytes - lineBytes);
        });
      return "queued";
    },
    flush: async () => {
      await queue;
    },
  };

  writers.set(filePath, writer);
  return writer;
}
