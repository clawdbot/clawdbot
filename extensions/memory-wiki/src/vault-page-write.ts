// Memory Wiki plugin module: shared guarded write for vault pages.
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";

type VaultRoot = Awaited<ReturnType<typeof fsRoot>>;

type FileStatLike = {
  isFile?: unknown;
  nlink?: unknown;
};

export function isRegularFileStat(value: unknown): value is FileStatLike & { nlink: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const stat = value as FileStatLike;
  const isFile =
    typeof stat.isFile === "function"
      ? (stat.isFile as () => boolean).call(stat)
      : stat.isFile === true;
  return isFile && typeof stat.nlink === "number";
}

// A concurrent atomic rewrite (write-temp + rename) of the same vault page by
// the memory bridge re-export makes fs-safe's opened-fd identity check fail with
// `path-mismatch` (see @openclaw/fs-safe opened-realpath): the file we opened is
// replaced under us mid-operation. It is transient (resolves sub-ms) and benign,
// so a short retry closes the window. Symlink/path-alias swaps and persistent
// guard failures (e.g. a directory collision) carry their own code and still
// hard-fail unchanged below.
const isConcurrentRewriteRace = (error: unknown): boolean =>
  error instanceof FsSafeError && error.code === "path-mismatch";

/**
 * Write `content` to a vault page, breaking an accidental hardlink first, and map
 * fs-safe guard failures to a labeled error. A transient concurrent-rewrite race
 * is retried briefly; on exhaustion (or any other guard failure) the error
 * propagates so the caller's safety contract is unchanged.
 */
export async function writeGuardedVaultPage(params: {
  vault: VaultRoot;
  pagePath: string;
  content: string;
  pageStat: unknown;
  pageLabel: string;
}): Promise<void> {
  try {
    await retryAsync(
      async () => {
        if (isRegularFileStat(params.pageStat) && params.pageStat.nlink > 1) {
          await params.vault.remove(params.pagePath);
        }
        await params.vault.write(params.pagePath, params.content);
      },
      {
        attempts: 3,
        minDelayMs: 25,
        maxDelayMs: 50,
        label: `memory-wiki write ${params.pageLabel} ${params.pagePath}`,
        shouldRetry: isConcurrentRewriteRace,
      },
    );
  } catch (error) {
    if (error instanceof FsSafeError) {
      if (error.code !== "symlink" && error.code !== "path-alias") {
        throw new Error(
          `Refusing to write ${params.pageLabel} (${error.code}): ${params.pagePath}: ${error.message}`,
          { cause: error },
        );
      }
      throw new Error(`Refusing to write ${params.pageLabel} through symlink: ${params.pagePath}`, {
        cause: error,
      });
    }
    throw error;
  }
}
