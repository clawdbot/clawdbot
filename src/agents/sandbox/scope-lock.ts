/** Serializes deterministic sandbox scope provisioning and cleanup across processes. */
import path from "node:path";
import { acquireFileLock } from "../../infra/file-lock.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import { hashTextSha256 } from "./hash.js";

const STALE_MS = 60 * 60 * 1000;
const RETRIES = 60 * 60 * 10;

export async function withSandboxScopeLock<T>(scopeKey: string, run: () => Promise<T>): Promise<T> {
  const key = scopeKey.trim() || "main";
  const lock = await acquireFileLock(
    path.join(SANDBOX_STATE_DIR, "locks", "scope", `scope-${hashTextSha256(key)}.jsonl`),
    {
      retries: { retries: RETRIES, factor: 1, minTimeout: 100, maxTimeout: 100 },
      stale: STALE_MS,
    },
  );
  try {
    return await run();
  } finally {
    await lock.release();
  }
}
