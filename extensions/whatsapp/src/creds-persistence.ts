import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWebCredsPath } from "./creds-files.js";

const CREDS_FILE_MODE = 0o600;
const CREDS_SAVE_FLUSH_TIMEOUT_MS = 15_000;

const credsSaveQueues = new Map<string, Promise<void>>();

export type CredsQueueWaitResult = "drained" | "timed_out";

async function stringifyCreds(creds: unknown): Promise<string> {
  const { BufferJSON } = await import("./session.runtime.js");
  return JSON.stringify(creds, BufferJSON.replacer);
}

async function syncDirectory(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch {
    // best-effort on platforms that do not support directory fsync
  } finally {
    await handle?.close().catch(() => {
      // best-effort close
    });
  }
}

export async function writeCredsJsonAtomically(authDir: string, creds: unknown): Promise<void> {
  const credsPath = resolveWebCredsPath(authDir);
  const tempPath = path.join(authDir, `.creds.${process.pid}.${randomUUID()}.tmp`);
  const json = await stringifyCreds(creds);

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tempPath, "w", CREDS_FILE_MODE);
    await handle.writeFile(json, { encoding: "utf-8" });
    await handle.sync();
    await handle.close();
    handle = undefined;

    await fs.rename(tempPath, credsPath);
    await fs.chmod(credsPath, CREDS_FILE_MODE).catch(() => {
      // best-effort on platforms that support it
    });
    await syncDirectory(path.dirname(credsPath));
  } catch (error) {
    await handle?.close().catch(() => {
      // best-effort close
    });
    await fs.rm(tempPath, { force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  }
}

export function enqueueCredsSave(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  onError: (error: unknown) => void,
): void {
  const previous = credsSaveQueues.get(authDir) ?? Promise.resolve();
  const next = previous
    .then(() => saveCreds())
    .catch((error) => {
      onError(error);
    })
    .finally(() => {
      if (credsSaveQueues.get(authDir) === next) {
        credsSaveQueues.delete(authDir);
      }
    });
  credsSaveQueues.set(authDir, next);
}

export function waitForCredsSaveQueue(authDir?: string): Promise<void> {
  if (authDir) {
    return credsSaveQueues.get(authDir) ?? Promise.resolve();
  }
  return Promise.all(credsSaveQueues.values()).then(() => {});
}

export async function waitForCredsSaveQueueWithTimeout(
  authDir: string,
  timeoutMs = CREDS_SAVE_FLUSH_TIMEOUT_MS,
): Promise<CredsQueueWaitResult> {
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    waitForCredsSaveQueue(authDir).then(() => "drained" as const),
    new Promise<CredsQueueWaitResult>((resolve) => {
      flushTimeout = setTimeout(() => resolve("timed_out"), timeoutMs);
    }),
  ]).finally(() => {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
    }
  });
}
