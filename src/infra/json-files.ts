import "./fs-safe-defaults.js";
import {
  JsonFileReadError,
  readJson as readJsonImpl,
  readJsonIfExists as readJsonIfExistsImpl,
} from "@openclaw/fs-safe/json";
import { replaceFileAtomic } from "./replace-file.js";

export {
  JsonFileReadError,
  readJsonSync,
  readRootJsonObjectSync,
  readRootJsonSync,
  readRootStructuredFileSync,
  tryReadJsonSync,
  tryReadJsonSync as readJsonFileSync,
  writeJson,
  writeJson as writeJsonAtomic,
  writeJsonSync,
} from "@openclaw/fs-safe/json";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 50;

/**
 * Recursively walks the error cause chain to detect
 * "File changed during read" errors wrapped inside
 * JsonFileReadError by @openclaw/fs-safe.
 */
function isFileChangedDuringRead(err: unknown): boolean {
  let current: unknown = err;
  while (current) {
    if (current instanceof Error) {
      if (
        typeof current.message === "string" &&
        current.message.includes("File changed during read")
      ) {
        return true;
      }
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

async function withRetryOnFileChanged<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isFileChangedDuringRead(err) && attempt < RETRY_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  try {
    return await withRetryOnFileChanged(() => readJsonImpl<T>(filePath));
  } catch (err) {
    throw err instanceof JsonFileReadError ? err : new JsonFileReadError(filePath, "read", err);
  }
}

export async function readJsonFileStrict<T>(filePath: string): Promise<T> {
  return readJson<T>(filePath);
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return await withRetryOnFileChanged(() => readJsonIfExistsImpl<T>(filePath));
  } catch (err) {
    if (err instanceof JsonFileReadError) {
      throw err;
    }
    throw new JsonFileReadError(filePath, "read", err);
  }
}

export async function readDurableJsonFile<T>(filePath: string): Promise<T | null> {
  return readJsonIfExists<T>(filePath);
}

/**
 * tryReadJson delegates to readJsonIfExists instead of the internal
 * tryReadJsonImpl from @openclaw/fs-safe. The fs-safe implementation
 * swallows all errors internally and returns null, which prevents
 * the retry wrapper from detecting transient "File changed during read"
 * race conditions.
 *
 * By routing through readJsonIfExists, fs-safe propagates errors on
 * race conditions, our retry wrapper intercepts and retries them,
 * and the outer try-catch still handles parse errors / file-not-found
 * gracefully.
 */
export async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonIfExists<T>(filePath);
  } catch {
    return null;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  return tryReadJson<T>(filePath);
}

export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export type WriteTextAtomicOptions = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  durable?: boolean;
};

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: WriteTextAtomicOptions,
): Promise<void> {
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  await replaceFileAtomic({
    filePath,
    content: payload,
    mode: options?.mode ?? 0o600,
    dirMode: options?.dirMode ?? 0o777 & ~process.umask(),
    copyFallbackOnPermissionError: true,
    syncTempFile: options?.durable !== false,
    syncParentDir: options?.durable !== false,
  });
}
