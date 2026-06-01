import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { assertWebCredsPathRegularFileOrMissing, resolveWebCredsPath } from "./creds-files.js";

const CREDS_FILE_MODE = 0o600;
const CREDS_SAVE_FLUSH_TIMEOUT_MS = 15_000;

const credsSaveQueues = new Map<string, Promise<void>>();

export type CredsQueueWaitResult = "drained" | "timed_out";

async function stringifyCreds(creds: unknown): Promise<string> {
  const { BufferJSON } = await import("./session.runtime.js");
  return JSON.stringify(creds, BufferJSON.replacer);
}

export async function writeWebCredsRawAtomically(params: {
  filePath: string;
  content: string;
  tempPrefix: string;
}): Promise<void> {
  await assertWebCredsPathRegularFileOrMissing(params.filePath);
  await replaceFileAtomic({
    filePath: params.filePath,
    content: params.content,
    dirMode: 0o700,
    mode: CREDS_FILE_MODE,
    tempPrefix: params.tempPrefix,
    syncTempFile: true,
    syncParentDir: true,
    beforeRename: async ({ filePath }) => {
      await assertWebCredsPathRegularFileOrMissing(filePath);
    },
  });
}

export async function writeCredsJsonAtomically(authDir: string, creds: unknown): Promise<void> {
  await writeWebCredsRawAtomically({
    filePath: resolveWebCredsPath(authDir),
    content: await stringifyCreds(creds),
    tempPrefix: ".creds",
  });
}

export function enqueueCredsSave(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  onError: (error: unknown) => void,
): void {
  const previous = credsSaveQueues.get(authDir) ?? Promise.resolve();
  const next = previous
    .then(() => saveCreds())
    .catch((error: unknown) => {
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
  const boundedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, CREDS_SAVE_FLUSH_TIMEOUT_MS, 0);
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    waitForCredsSaveQueue(authDir).then(() => "drained" as const),
    new Promise<CredsQueueWaitResult>((resolve) => {
      flushTimeout = setTimeout(() => resolve("timed_out"), boundedTimeoutMs);
    }),
  ]).finally(() => {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
    }
  });
}
