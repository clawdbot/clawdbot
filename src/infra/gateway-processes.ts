// Inspects local gateway processes for status and diagnostics.
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { isGatewayArgv, parseProcCmdline } from "./gateway-process-argv.js";
import { findGatewayPidsOnPortSync as findUnixGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsProcessArgsSync,
} from "./windows-port-pids.js";

// Gateway process helpers verify argv before signaling or reporting listener
// PIDs so stale port owners cannot be mistaken for OpenClaw.
/** Read command argv for a PID using the current platform's process APIs. */
export function readGatewayProcessArgsSync(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      return parseProcCmdline(fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (ps.error || ps.status !== 0) {
      return null;
    }
    const command = ps.stdout.trim();
    return command ? command.split(/\s+/) : null;
  }
  if (process.platform === "win32") {
    return readWindowsProcessArgsSync(pid);
  }
  return null;
}

/** Signal a PID only after its argv matches a gateway process. */
export function signalVerifiedGatewayPidSync(pid: number, signal: "SIGTERM" | "SIGUSR1"): void {
  const args = readGatewayProcessArgsSync(pid);
  if (!args || !isGatewayArgv(args, { allowGatewayBinary: true })) {
    throw new Error(`refusing to signal non-gateway process pid ${pid}`);
  }
  process.kill(pid, signal);
}

/** Find listener PIDs on `port` and keep only verified gateway processes. */
export function findVerifiedGatewayListenerPidsOnPortSync(port: number): number[] {
  const rawPids =
    process.platform === "win32"
      ? readWindowsListeningPidsOnPortSync(port)
      : findUnixGatewayPidsOnPortSync(port);

  return uniqueValues(rawPids)
    .filter((pid): pid is number => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => {
      const args = readGatewayProcessArgsSync(pid);
      return args != null && isGatewayArgv(args, { allowGatewayBinary: true });
    });
}

/** Format gateway PIDs for human-facing diagnostics. */
export function formatGatewayPidList(pids: number[]): string {
  return pids.join(", ");
}
