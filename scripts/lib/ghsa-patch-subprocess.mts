import { spawnSync } from "node:child_process";

// GHSA patch performs multiple sequential GitHub API reads and writes. Keep enough
// headroom for GitHub latency while preventing one stalled request from blocking
// the maintainer command indefinitely.
export const GHSA_COMMAND_TIMEOUT_MS = 60_000;

interface GhCommandParams {
  spawnSyncImpl?: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; killSignal: "SIGKILL"; timeout: number },
  ) => {
    error?: Error;
    status: number | null;
    stderr: string;
    stdout: string;
  };
  timeoutMs?: number;
}

export function runGhCommand(args: string[], params: GhCommandParams = {}) {
  const spawnSyncImpl: NonNullable<GhCommandParams["spawnSyncImpl"]> =
    params.spawnSyncImpl ??
    ((command, commandArgs, options) => spawnSync(command, commandArgs, options));
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
