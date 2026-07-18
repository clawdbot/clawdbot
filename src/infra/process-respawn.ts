// Respawns the gateway process when no supervisor handles restart.
import { spawn, type ChildProcess } from "node:child_process";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isContainerEnvironment } from "./container-environment.js";
import { formatErrorMessage } from "./errors.js";
import { triggerOpenClawRestart } from "./restart.js";
import { detectGatewayRespawnSupervisor } from "./supervisor-markers.js";

type RespawnMode = "spawned" | "supervised" | "disabled" | "failed";

type GatewayRespawnResult = {
  mode: RespawnMode;
  pid?: number;
  detail?: string;
};

type GatewayUpdateRespawnResult = GatewayRespawnResult & {
  child?: ChildProcess;
};
type GatewayRespawnOptions = {
  env?: NodeJS.ProcessEnv;
};

function isTruthy(value: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

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

function spawnDetachedGatewayProcess(opts: GatewayRespawnOptions = {}): {
  child: ChildProcess;
  pid?: number;
} {
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
  // Detached spawn failures can arrive asynchronously after spawn() returns.
  // Keep this listener before unref() so the parent does not crash during handoff.
  child.on("error", () => {});
  child.unref();
  return { child, pid: child.pid ?? undefined };
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
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled" };
  }
  const supervisor = detectGatewayRespawnSupervisor(process.env);
  if (supervisor) {
    // On macOS launchd, exit cleanly and let KeepAlive relaunch the service.
    // Avoid detached kickstart/start handoffs here so restart timing stays tied
    // to launchd's native supervision rather than a second helper process.
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
  if (process.platform === "win32") {
    // Detached respawn is unsafe on Windows without an identified Scheduled Task:
    // the child becomes orphaned if the original process exits.
    return {
      mode: "disabled",
      detail: "win32: detached respawn unsupported without Scheduled Task markers",
    };
  }
  if (isContainerEnvironment()) {
    return {
      mode: "disabled",
      detail: "container: use in-process restart to keep PID 1 alive",
    };
  }

  return {
    mode: "disabled",
    detail: "unmanaged: use in-process restart to keep custom supervisor PID tracking stable",
  };
}

/**
 * Update restarts must replace the OS process so the new code runs from a
 * fresh module graph after package files have changed on disk.
 *
 * Unlike the generic restart path, update mode allows detached respawn on
 * unmanaged Windows installs because there is no safe in-process fallback once
 * the installed package contents have been replaced.
 */
export function respawnGatewayProcessForUpdate(
  opts: GatewayRespawnOptions = {},
): GatewayUpdateRespawnResult {
  const supervisor = detectGatewayRespawnSupervisor(process.env, process.platform, {
    includeLinuxOpenClawGatewayServiceMarker: true,
  });
  if (supervisor) {
    // Managed update handoffs require the original PID to exit before the
    // detached helper can mutate the install, even when respawn is disabled.
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
  if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) {
    return { mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" };
  }
  try {
    const { child, pid } = spawnDetachedGatewayProcess(opts);
    return { mode: "spawned", pid, child };
  } catch (err) {
    return {
      mode: "failed",
      detail: formatErrorMessage(err),
    };
  }
}
