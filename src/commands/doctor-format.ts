/** Formatting helpers for gateway runtime summaries and doctor repair hints. */
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../daemon/constants.js";
import { formatRuntimeStatus } from "../daemon/runtime-format.js";
import { buildGatewayRuntimeRecoveryHints } from "../daemon/runtime-hints.js";
import {
  getSystemdCgroupHygieneSummary,
  isSystemdCgroupHygieneRisk,
  isSystemdStartLimitHit,
  type GatewayServiceRuntime,
} from "../daemon/service-runtime.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../daemon/systemd-hints.js";
import { classifySystemdUnavailableDetail } from "../daemon/systemd-unavailable.js";
import { isWSLEnv } from "../infra/wsl.js";
import { getResolvedLoggerSettings } from "../logging.js";

type RuntimeHintOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

/** Formats the platform-specific gateway service runtime into a compact status line. */
export function formatGatewayRuntimeSummary(
  runtime: GatewayServiceRuntime | undefined,
): string | null {
  return formatRuntimeStatus(runtime);
}

/** Builds follow-up hints for stopped, missing, or unhealthy gateway service runtimes. */
export function buildGatewayRuntimeHints(
  runtime: GatewayServiceRuntime | undefined,
  options: RuntimeHintOptions = {},
): string[] {
  const hints: string[] = [];
  if (!runtime) {
    return hints;
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  const systemdDetail = runtime.inspectionFailure?.detail ?? runtime.detail;
  if (platform === "linux" && isSystemdUnavailableDetail(systemdDetail)) {
    hints.push(
      ...renderSystemdUnavailableHints({
        wsl: isWSLEnv(env),
        kind: classifySystemdUnavailableDetail(systemdDetail),
        env,
      }),
    );
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.cachedLabel && platform === "darwin") {
    const label = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
    hints.push(
      `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${label}`,
    );
    hints.push(`Then reinstall: ${formatCliCommand("openclaw gateway install", env)}`);
  }
  if (runtime.missingUnit) {
    hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  const missingGuiSession = runtime.missingGuiSession && platform === "darwin";
  if (missingGuiSession || runtime.status === "stopped") {
    if (!missingGuiSession && platform === "linux" && isSystemdStartLimitHit(runtime)) {
      // start-limit-hit means systemd gave up restarting after repeated crashes;
      // a plain "exited immediately" hint would hide that recovery needs a restart.
      hints.push(
        "systemd stopped restarting the gateway after repeated crashes.",
        `Recover with: ${formatCliCommand("openclaw gateway restart", env)}, then inspect logs if it keeps crashing.`,
      );
    } else if (!missingGuiSession) {
      hints.push("Service is loaded but not running (likely exited immediately).");
    }
    hints.push(
      ...buildGatewayRuntimeRecoveryHints({
        kind: missingGuiSession ? "gui-session" : "stopped",
        restartCommand: formatCliCommand("openclaw gateway restart", env),
        logFile: fileLog,
        platform,
        env,
      }),
    );
    if (missingGuiSession) {
      return hints;
    }
  }
  if (platform === "linux" && isSystemdCgroupHygieneRisk(runtime.systemd)) {
    const unit =
      runtime.systemd?.unit ?? `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
    const summary = getSystemdCgroupHygieneSummary(runtime.systemd);
    if (summary) {
      hints.push(
        `Systemd cgroup hygiene looks elevated: ${summary}.`,
        "This usually means old helper or browser processes may still be attached to the gateway service.",
        `Run: systemctl --user show ${unit} -p KillMode -p TasksCurrent -p MemoryCurrent -p MainPID`,
        `Run: systemd-cgls --user-unit ${unit}`,
        `After reviewing service settings, run: ${formatCliCommand("openclaw gateway restart", env)}`,
      );
    }
  }
  return hints;
}
