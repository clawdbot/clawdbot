/** Serializes deterministic sandbox scope provisioning and cleanup across processes. */
import path from "node:path";
import { acquireFileLock } from "../../infra/file-lock.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { hashTextSha256 } from "./hash.js";

const scopeLocks = new Map<string, Promise<void>>();
const STALE_MS = 60 * 60 * 1000;
const RETRIES = 60 * 60 * 10;

async function withSandboxScopeLock<T>(scopeKey: string, run: () => Promise<T>): Promise<T> {
  const key = scopeKey.trim() || "main";
  const previous = scopeLocks.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  scopeLocks.set(key, tail);
  await previous.catch(() => undefined);
  let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
  try {
    lock = await acquireFileLock(
      path.join(SANDBOX_STATE_DIR, "locks", "scope", `scope-${hashTextSha256(key)}.jsonl`),
      {
        retries: { retries: RETRIES, factor: 1, minTimeout: 100, maxTimeout: 100 },
        stale: STALE_MS,
      },
    );
    return await run();
  } finally {
    try {
      await lock?.release();
    } finally {
      releaseQueue();
      if (scopeLocks.get(key) === tail) {
        scopeLocks.delete(key);
      }
    }
  }
}

export async function withSandboxScopeLocks<T>(
  scopeKeys: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const [scopeKey, ...remaining] = Array.from(
    new Set(scopeKeys.map((key) => key.trim()).filter(Boolean)),
  ).toSorted();
  return scopeKey
    ? await withSandboxScopeLock(scopeKey, () => withSandboxScopeLocks(remaining, run))
    : await run();
}
