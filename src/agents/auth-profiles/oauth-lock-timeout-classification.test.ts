import { describe, expect, it } from "vitest";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, type FileLockTimeoutError } from "../../infra/file-lock.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import { resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";

function createLockTimeoutError(lockPath: string): FileLockTimeoutError {
  return Object.assign(new Error(`file lock timeout for ${lockPath.slice(0, -5)}`), {
    code: FILE_LOCK_TIMEOUT_ERROR_CODE as typeof FILE_LOCK_TIMEOUT_ERROR_CODE,
    lockPath,
  });
}

describe("OAuth refresh lock timeout classification", () => {
  it("matches only the global refresh lock path", () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const refreshLockPath = resolveOAuthRefreshLockPath(provider, profileId);
    const authStoreLockPath = resolveAuthStorePath("/tmp/openclaw-oauth-lock-timeout/agent");

    expect(
      isGlobalRefreshLockTimeoutError(
        createLockTimeoutError(`${refreshLockPath}.lock`),
        refreshLockPath,
      ),
    ).toBe(true);
    expect(
      isGlobalRefreshLockTimeoutError(
        createLockTimeoutError(`${authStoreLockPath}.lock`),
        refreshLockPath,
      ),
    ).toBe(false);
  });

  it("builds refresh_contention errors that preserve the file-lock cause", () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const refreshLockPath = resolveOAuthRefreshLockPath(provider, profileId);
    const cause = createLockTimeoutError(`${refreshLockPath}.lock`);

    const error = buildRefreshContentionError({ provider, profileId, cause });

    expect(error.code).toBe("refresh_contention");
    expect(error.cause).toBe(cause);
    expect(cause.code).toBe(FILE_LOCK_TIMEOUT_ERROR_CODE);
    expect(cause.lockPath).toBe(`${refreshLockPath}.lock`);
    expect(error.message).toContain("another process is already refreshing");
    expect(error.message).toContain("Please wait for the in-flight refresh to finish and retry.");
  });
});
