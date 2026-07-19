import { spawnSync } from "node:child_process";

// GHSA patch performs multiple sequential GitHub API reads and writes. Keep enough
// headroom for GitHub latency while preventing one stalled request from blocking
// the maintainer command indefinitely.
export const GHSA_COMMAND_TIMEOUT_MS = 60_000;

export function runGhCommand(args, params = {}) {
  const spawnSyncImpl = params.spawnSyncImpl ?? spawnSync;
  const proc = spawnSyncImpl("gh", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: params.timeoutMs ?? GHSA_COMMAND_TIMEOUT_MS,
  });
  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `gh ${args.join(" ")} failed`);
  }
  return proc.stdout;
}
