// Inspects local gateway processes for status and diagnostics.
import fsSync from "node:fs";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { isGatewayArgv, parseProcCmdline } from "./gateway-process-argv.js";
import { probePortUsage } from "./ports-probe.js";
import { findGatewayPidsOnPortSync as findUnixGatewayPidsOnPortSync } from "./restart-stale-pids.js";
import { spawnPsSync } from "./spawn-ps.js";
import {
  readWindowsListeningPidsOnPortSync,
  readWindowsProcessArgsSync,
} from "./windows-port-pids.js";

// Gateway process helpers verify argv before signaling or reporting listener
// PIDs so stale port owners cannot be mistaken for OpenClaw.
const GATEWAY_PS_PROBE_TIMEOUT_MS = 1_000;

/** Read command argv for a PID using the current platform's process APIs. */
function readGatewayProcessArgsSync(pid: number): string[] | null {
  if (process.platform === "linux") {
    try {
      return parseProcCmdline(fsSync.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const ps = spawnPsSync(["-o", "command=", "-p", String(pid)], GATEWAY_PS_PROBE_TIMEOUT_MS);
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
  try {
    process.kill(pid, signal);
  } catch (err) {
    // The verified process can exit between argv inspection and signaling;
    // ESRCH already satisfies the requested stop or restart handoff.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      throw err;
    }
  }
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

/**
 * Fail when `port` still has an owner that PID discovery could not name.
 *
 * Finding no PID does not prove the gateway is down: `lsof` may be missing on
 * minimal containers and the gateway lock may be absent or stale while the
 * process keeps serving. Callers that would otherwise report "not running"
 * use this to turn that ambiguity into an explicit error instead of a
 * false success.
 */
export async function assertGatewayPortFreeWhenPidUnknown(port: number): Promise<void> {
  const status = await probePortUsage(port).catch(() => "unknown" as const);
  if (status === "free") {
    return;
  }
  // Both remaining statuses stay fail-closed, but they describe different
  // situations: "busy" observed a listener, while "unknown" means the probe
  // itself could not answer. Reporting the port as in use for "unknown" would
  // send operators looking for a listener that may not exist.
  throw new Error(
    status === "busy"
      ? `port ${port} is in use but the gateway process could not be identified (lsof unavailable or the gateway lock is missing/stale); run "openclaw gateway status --deep" to investigate`
      : `could not determine whether port ${port} is still in use, so the gateway cannot be confirmed stopped; run "openclaw gateway status --deep" to investigate`,
  );
}
