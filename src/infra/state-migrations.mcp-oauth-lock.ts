import { randomUUID } from "node:crypto";
import path from "node:path";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withFsSafeFileLock } from "./file-lock.js";
import type { Root } from "./fs-safe.js";
import { isDefinitelyStaleLegacyMcpOAuthLock } from "./state-migrations.mcp-oauth-lock-stale.js";

const LOCK_RETRIES = 20;
const LOCK_RETRY_FACTOR = 1.3;
const LOCK_RETRY_MIN_MS = 25;
const LOCK_RETRY_MAX_MS = 500;
function createLockPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const starttime = getFileLockProcessStartTime(process.pid);
  if (starttime !== null) {
    payload.starttime = starttime;
  }
  return payload;
}

/** Share the retired runtime's sidecar protocol without leaving the pinned state root. */
export async function withRootBoundedLegacyFileLock<T>(
  params: { stateRoot: Root; targetRelativePath: string },
  run: () => Promise<T>,
): Promise<T> {
  const targetPath = path.resolve(params.stateRoot.rootReal, params.targetRelativePath);
  return await withFsSafeFileLock(
    targetPath,
    {
      managerKey: "openclaw.mcp-oauth-legacy-migration",
      lockPath: `${targetPath}.lock`,
      lockRoot: params.stateRoot,
      retry: {
        retries: LOCK_RETRIES,
        factor: LOCK_RETRY_FACTOR,
        minTimeout: LOCK_RETRY_MIN_MS,
        maxTimeout: LOCK_RETRY_MAX_MS,
      },
      staleRecovery: "fail-closed",
      payload: createLockPayload,
      parsePayload: (raw) => ({ raw }),
      shouldReclaim: ({ payload }) =>
        isDefinitelyStaleLegacyMcpOAuthLock({
          raw: typeof payload?.raw === "string" ? payload.raw : "",
        }),
    },
    run,
  );
}
