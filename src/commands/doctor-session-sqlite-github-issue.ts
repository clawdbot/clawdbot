/** Creates GitHub issues for sanitized session SQLite recovery reports. */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { SessionSqliteMigrationFailureIssue } from "./doctor-session-sqlite-types.js";

type SessionSqliteGithubIssueCreateResult =
  | { ok: true; url: string }
  | { fallbackUrl: string; message: string; ok: false };

type SpawnGh = (
  args: readonly string[],
  options: { input: string },
) => Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout">;

/** Creates an openclaw/openclaw issue through the GitHub CLI using sanitized stdin. */
export function createSessionSqliteGithubIssue(
  issue: SessionSqliteMigrationFailureIssue,
  spawnGh: SpawnGh = defaultSpawnGh,
): SessionSqliteGithubIssueCreateResult {
  const result = spawnGh(
    ["issue", "create", "--repo", "openclaw/openclaw", "--title", issue.title, "--body-file", "-"],
    { input: issue.body },
  );
  if (!result.error && result.status === 0) {
    const url = String(result.stdout).trim().split(/\r?\n/).at(-1);
    return {
      ok: true,
      url: url && url.length > 0 ? url : "https://github.com/openclaw/openclaw/issues",
    };
  }
  const stderr = String(result.stderr).trim();
  const error = result.error
    ? result.error.message
    : stderr || `gh exited ${result.status ?? "unknown"}`;
  return {
    fallbackUrl: issue.url,
    message: error,
    ok: false,
  };
}

function defaultSpawnGh(
  args: readonly string[],
  options: { input: string },
): Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "stderr" | "stdout"> {
  return spawnSync("gh", [...args], {
    encoding: "buffer",
    input: options.input,
    maxBuffer: 1024 * 1024,
  });
}
