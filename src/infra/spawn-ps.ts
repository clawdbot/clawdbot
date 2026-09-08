import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { resolveDiagnosticProcessEnv } from "./process-env.js";

/** Run a bounded ps probe without letting an ignored SIGTERM extend the synchronous wait. */
export function spawnPsSync(args: readonly string[], timeoutMs: number): SpawnSyncReturns<string> {
  return spawnSync("ps", args, {
    env: resolveDiagnosticProcessEnv(),
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: timeoutMs,
  });
}
