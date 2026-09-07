/** Platform-specific doctor notes for macOS gateway launchd state and startup tuning. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import {
  findStaleOpenClawUpdateLaunchdJobs,
  isLaunchAgentEnabled,
  isLaunchAgentLoaded,
  launchAgentPlistExists,
  resolveLaunchAgentLabel,
} from "../daemon/launchd.js";
import { resolveGatewayService } from "../daemon/service.js";
import { runExec } from "../process/exec.js";
import { shortenHomePath } from "../utils.js";

const DOCTOR_LAUNCHCTL_TIMEOUT_MS = 5_000;

/** Returns the macOS marker warning when LaunchAgent writes are locally disabled. */
function collectMacLaunchAgentOverrideWarning(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  const markerPath = path.join(
    process.env.HOME ?? os.homedir(),
    ".openclaw",
    "disable-launchagent",
  );
  if (!fs.existsSync(markerPath)) {
    return null;
  }

  const displayMarkerPath = shortenHomePath(markerPath);
  return [
    `- LaunchAgent writes are disabled via ${displayMarkerPath}.`,
    "- To restore default behavior:",
    `  rm ${displayMarkerPath}`,
  ].join("\n");
}

/** Emits the macOS LaunchAgent override warning when present. */
export async function noteMacLaunchAgentOverrides() {
  const warning = collectMacLaunchAgentOverrideWarning();
  if (warning) {
    note(warning, "Gateway (macOS)");
  }
}

/** Diagnose persistent disablement without taking activation authority from update or Doctor. */
export async function noteMacDisabledGatewayLaunchAgent(env: NodeJS.ProcessEnv = process.env) {
  if (
    process.platform !== "darwin" ||
    !(await launchAgentPlistExists(env)) ||
    (await isLaunchAgentLoaded({ env })) ||
    (await isLaunchAgentEnabled({ env }))
  ) {
    return;
  }
  const label = resolveLaunchAgentLabel(env);
  const labelEnv = env.OPENCLAW_LAUNCHD_LABEL?.trim() ? `OPENCLAW_LAUNCHD_LABEL=${label} ` : "";
  note(
    [
      `Gateway LaunchAgent ${label} is installed but unloaded and disabled in launchd.`,
      "A terminated update helper can leave it disabled across logins. Doctor does not automatically re-enable it.",
      `After verifying the installation is safe to run, use ${labelEnv}${formatCliCommand("openclaw gateway start", env)} to re-enable and start it. Keep the same state/config overrides.`,
      `If an update was interrupted or installation safety is uncertain, run ${formatCliCommand("openclaw update", env)} or ${formatCliCommand("openclaw doctor", env)} and ${formatCliCommand("openclaw triage", env)} before starting it.`,
    ].join("\n"),
    "Gateway (macOS)",
  );
}

/** Returns a warning for stale OpenClaw updater launchd jobs left after interrupted updates. */
async function collectMacStaleOpenClawUpdateLaunchdJobsWarning(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const scanEnv = await resolveGatewayServiceEnvForPlatformNotes();
  const jobs = await findStaleOpenClawUpdateLaunchdJobs(scanEnv).catch(() => []);
  if (jobs.length === 0) {
    return null;
  }

  return [
    "- Stale OpenClaw updater launchd job(s) detected.",
    ...jobs.map((job) => {
      const exitStatus =
        job.lastExitStatus !== undefined ? `, last exit ${job.lastExitStatus}` : "";
      const pid = job.pid !== undefined ? `, pid ${job.pid}` : "";
      return `- ${job.label}${pid}${exitStatus}`;
    }),
    "- Fix after confirming no update is running:",
    "  launchctl remove <label>",
    `  ${formatCliCommand("openclaw gateway restart")}`,
  ].join("\n");
}

/** Emits stale updater launchd job notes using the gateway service environment when available. */
export async function noteMacStaleOpenClawUpdateLaunchdJobs() {
  const warning = await collectMacStaleOpenClawUpdateLaunchdJobsWarning();
  if (warning) {
    note(warning, "Gateway (macOS)");
  }
}

async function launchctlGetenv(name: string): Promise<string | undefined> {
  try {
    const result = await runExec("/bin/launchctl", ["getenv", name], {
      logOutput: false,
      timeoutMs: DOCTOR_LAUNCHCTL_TIMEOUT_MS,
    });
    return normalizeOptionalString(result.stdout);
  } catch {
    return undefined;
  }
}

function hasConfigGatewayCreds(cfg: OpenClawConfig): boolean {
  const localPassword = cfg.gateway?.auth?.password;
  const remoteToken = cfg.gateway?.remote?.token;
  const remotePassword = cfg.gateway?.remote?.password;
  return (
    hasConfiguredSecretInput(cfg.gateway?.auth?.token, cfg.secrets?.defaults) ||
    hasConfiguredSecretInput(localPassword, cfg.secrets?.defaults) ||
    hasConfiguredSecretInput(remoteToken, cfg.secrets?.defaults) ||
    hasConfiguredSecretInput(remotePassword, cfg.secrets?.defaults)
  );
}

/** Returns a warning for host-wide launchctl gateway auth env overrides. */
async function collectMacLaunchctlGatewayEnvOverrideWarning(
  cfg: OpenClawConfig,
): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  if (!hasConfigGatewayCreds(cfg)) {
    return null;
  }

  const envToken = await launchctlGetenv("OPENCLAW_GATEWAY_TOKEN");
  const envPassword = await launchctlGetenv("OPENCLAW_GATEWAY_PASSWORD");
  if (!envToken && !envPassword) {
    return null;
  }

  return [
    "- Host-wide launchctl gateway auth overrides detected.",
    "- Current managed Gateway installs do not need these values unless config intentionally references the env var.",
    envToken
      ? "- `OPENCLAW_GATEWAY_TOKEN` is set; explicit environment URL or node-host targets can use a different token than gateway.auth.token."
      : undefined,
    envPassword
      ? "- `OPENCLAW_GATEWAY_PASSWORD` is set; explicit environment URL or node-host targets can use a different password than gateway.auth.password."
      : undefined,
    "- Clear overrides and restart the app/gateway:",
    envToken ? "  launchctl unsetenv OPENCLAW_GATEWAY_TOKEN" : undefined,
    envPassword ? "  launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD" : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/** Emits macOS launchctl gateway auth override warnings. */
export async function noteMacLaunchctlGatewayEnvOverrides(cfg: OpenClawConfig) {
  const warning = await collectMacLaunchctlGatewayEnvOverrideWarning(cfg);
  if (warning) {
    note(warning, "Gateway (macOS)");
  }
}

async function resolveGatewayServiceEnvForPlatformNotes(): Promise<NodeJS.ProcessEnv> {
  const baseEnv = process.env;
  const service = resolveGatewayService();
  const command = await service.readCommand(baseEnv).catch(() => null);
  return command?.environment
    ? {
        ...baseEnv,
        ...command.environment,
      }
    : baseEnv;
}

/** Collects all macOS gateway platform warnings without emitting notes. */
export async function collectMacGatewayPlatformWarnings(
  cfg: OpenClawConfig,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  const launchAgentWarning = collectMacLaunchAgentOverrideWarning();
  if (launchAgentWarning) {
    warnings.push(launchAgentWarning);
  }
  const staleUpdateWarning = await collectMacStaleOpenClawUpdateLaunchdJobsWarning();
  if (staleUpdateWarning) {
    warnings.push(staleUpdateWarning);
  }
  const launchctlWarning = await collectMacLaunchctlGatewayEnvOverrideWarning(cfg);
  if (launchctlWarning) {
    warnings.push(launchctlWarning);
  }
  return warnings;
}

function isTmpCompileCachePath(cachePath: string): boolean {
  const normalized = cachePath.trim().replace(/\/+$/, "");
  return (
    normalized === "/tmp" ||
    normalized.startsWith("/tmp/") ||
    normalized === "/private/tmp" ||
    normalized.startsWith("/private/tmp/")
  );
}

/** Emits startup tuning hints for low-power Linux hosts when env settings are suboptimal. */
export function noteStartupOptimizationHints(env: NodeJS.ProcessEnv = process.env) {
  const platform = process.platform;
  if (platform === "win32") {
    return;
  }
  const arch = os.arch();
  const totalMemBytes = os.totalmem();
  const isArmHost = arch === "arm" || arch === "arm64";
  const isLowMemoryLinux =
    platform === "linux" && totalMemBytes > 0 && totalMemBytes <= 8 * 1024 ** 3;
  const isStartupTuneTarget = platform === "linux" && (isArmHost || isLowMemoryLinux);
  if (!isStartupTuneTarget) {
    return;
  }

  const compileCache = normalizeOptionalString(env.NODE_COMPILE_CACHE) ?? "";
  const disableCompileCache = normalizeOptionalString(env.NODE_DISABLE_COMPILE_CACHE) ?? "";
  const noRespawn = normalizeOptionalString(env.OPENCLAW_NO_RESPAWN) ?? "";
  const lines: string[] = [];

  if (!compileCache) {
    lines.push(
      "- NODE_COMPILE_CACHE is not set; repeated CLI runs can be slower on small hosts (Raspberry Pi/VM).",
    );
  } else if (isTmpCompileCachePath(compileCache)) {
    lines.push(
      "- NODE_COMPILE_CACHE points to /tmp; use /var/tmp so cache survives reboots and warms startup reliably.",
    );
  }

  if (disableCompileCache) {
    lines.push("- NODE_DISABLE_COMPILE_CACHE is set; startup compile cache is disabled.");
  }

  if (noRespawn !== "1") {
    lines.push(
      "- OPENCLAW_NO_RESPAWN is not set to 1; set it when you want routine gateway restarts to stay in-process instead of handing off to a managed supervisor.",
    );
  }

  if (lines.length === 0) {
    return;
  }

  const suggestions = [
    "- Suggested env for low-power hosts:",
    "  export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache",
    "  mkdir -p /var/tmp/openclaw-compile-cache",
    "  export OPENCLAW_NO_RESPAWN=1",
    disableCompileCache ? "  unset NODE_DISABLE_COMPILE_CACHE" : undefined,
  ].filter((line): line is string => Boolean(line));

  note([...lines, ...suggestions].join("\n"), "Startup optimization");
}
