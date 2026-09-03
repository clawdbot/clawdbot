// Respawns the gateway process when no supervisor handles restart.
import { spawn, type ChildProcess } from "node:child_process";
import { scheduleDetachedLaunchdRestartHandoff } from "../daemon/launchd-restart-handoff.js";
import { isContainerEnvironment } from "./container-environment.js";
import { isTruthyEnvValue } from "./env.js";
import { formatErrorMessage } from "./errors.js";
import { triggerOpenClawRestart } from "./restart.js";
import { detectGatewayRespawnSupervisor } from "./supervisor-markers.js";

type GatewayRespawnResult = {
  mode: "supervised" | "disabled" | "failed";
  detail?: string;
  handoffSpawned?: Promise<boolean>;
};

type GatewayUpdateRespawnResult = {
  mode: "spawned" | "disabled" | "failed";
  pid?: number;
  detail?: string;
  child?: ChildProcess;
};
type GatewayRespawnOptions = {
  env?: NodeJS.ProcessEnv;
};

const PNPM_VERSIONED_OPENCLAW_ENTRY_PATTERN =
  /^(.*?)([\\/])node_modules\2\.pnpm\2openclaw@[^\\/]+\2node_modules\2openclaw\2.+$/;

function rewritePnpmVersionedOpenClawEntryPath(entryPath: string): string {
  // pnpm can expose argv[1] as a versioned realpath that self-update removes.
  // Respawn through the stable OpenClaw package wrapper instead.
  return entryPath.replace(
    PNPM_VERSIONED_OPENCLAW_ENTRY_PATTERN,
    "$1$2node_modules$2openclaw$2openclaw.mjs",
  );
}

/**
 * Attempt to restart this process with a fresh PID.
 * - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
 * - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
 * - unmanaged environments: caller should keep in-process restart behavior so
 *   custom supervisors keep tracking the same gateway PID
 */
export function restartGatewayProcessWithFreshPid(
  _opts: GatewayRespawnOptions = {},
): GatewayRespawnResult {
  if (isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  const supervisor = detectGatewayRespawnSupervisor(process.env);
  if (supervisor) {
    if (supervisor === "launchd") {
      const handoff = scheduleDetachedLaunchdRestartHandoff({
        mode: "start-after-exit",
        waitForPid: process.pid,
      });
      return handoff.ok
        ? { mode: "supervised", handoffSpawned: handoff.value }
        : { mode: "failed", detail: handoff.error };
    }
    if (supervisor === "schtasks") {
      const restart = triggerOpenClawRestart();
      if (!restart.ok) {
        return {
          mode: "failed",
          detail: restart.detail ?? `${restart.method} restart failed`,
        };
      }
    }
    return { mode: "supervised" };
  }
  // Unmanaged Windows or containers cannot safely surrender their tracked process.
  const detail =
    process.platform === "win32"
      ? "win32: detached respawn unsupported without Scheduled Task markers"
      : isContainerEnvironment()
        ? "container: use in-process restart to keep PID 1 alive"
        : "unmanaged: use in-process restart to keep custom supervisor PID tracking stable";
  return { mode: "disabled", detail };
}

/**
 * Update restarts must replace the OS process so the new code runs from a
 * fresh module graph after package files have changed on disk.
 *
 * The caller resolves supervisor ownership first; this path is only for an
 * unmanaged process whose installed package contents have been replaced.
 */
export function respawnGatewayProcessForUpdate(
  opts: GatewayRespawnOptions = {},
): GatewayUpdateRespawnResult {
  if (isTruthyEnvValue(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" };
  }
  try {
    const [entryArg, ...entryArgs] = process.argv.slice(1);
    const args = [
      ...process.execArgv,
      ...(entryArg ? [rewritePnpmVersionedOpenClawEntryPath(entryArg)] : []),
      ...entryArgs,
    ];
    const child = spawn(process.execPath, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached: true,
      stdio: "inherit",
    });
    // Register before unref: late detached-spawn failures must not crash the parent.
    child.on("error", () => {});
    child.unref();
    return { mode: "spawned", pid: child.pid ?? undefined, child };
  } catch (err) {
    return { mode: "failed", detail: formatErrorMessage(err) };
  }
}
