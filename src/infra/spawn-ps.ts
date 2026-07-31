import { spawnSync, type SpawnSyncReturns } from "node:child_process";

/** Run a bounded ps probe without letting an ignored SIGTERM extend the synchronous wait. */
export function spawnPsSync(args: readonly string[], timeoutMs: number): SpawnSyncReturns<string> {
  return spawnSync("ps", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  });
}
