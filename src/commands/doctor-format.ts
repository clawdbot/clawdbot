/** Formatting helpers for gateway runtime summaries and doctor repair hints. */
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../daemon/constants.js";
import { resolveDaemonContainerContext } from "../daemon/container-context.js";
import { formatRuntimeStatus } from "../daemon/runtime-format.js";
import { buildPlatformRuntimeLogHints } from "../daemon/runtime-hints.js";
import {
  getSystemdCgroupHygieneSummary,
  isSystemdCgroupHygieneRisk,
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
  const container = Boolean(resolveDaemonContainerContext(env));
  const fileLog = (() => {
    try {
      return getResolvedLoggerSettings().file;
    } catch {
      return null;
    }
  })();
  if (platform === "linux" && isSystemdUnavailableDetail(runtime.detail)) {
    hints.push(
      ...renderSystemdUnavailableHints({
        wsl: isWSLEnv(),
        kind: classifySystemdUnavailableDetail(runtime.detail),
        container,
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
  if (runtime.missingSupervision && platform === "darwin") {
    hints.push(
      `LaunchAgent installed but not loaded. Run: ${formatCliCommand("openclaw gateway restart", env)}`,
    );
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.status === "stopped") {
    hints.push("Service is loaded but not running (likely exited immediately).");
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    hints.push(
      ...buildPlatformRuntimeLogHints({
        platform,
        env,
        systemdServiceName: resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE),
        windowsTaskName: resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE),
      }),
    );
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
