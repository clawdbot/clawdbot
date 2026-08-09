// Shared Gateway service CLI helpers: status styles, env filtering, port parsing, and hints.
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { resolveIsNixMode } from "../../config/paths.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveDaemonContainerContext } from "../../daemon/container-context.js";
import { formatRuntimeStatus } from "../../daemon/runtime-format.js";
import {
  buildPlatformRuntimeLogHints,
  buildPlatformServiceStartHints,
} from "../../daemon/runtime-hints.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { formatCliCommand } from "../command-format.js";
import { parsePort } from "../shared/parse-port.js";
import { createDaemonActionContext } from "./response.js";

export { formatRuntimeStatus };
export { parsePort };
export { resolveDaemonContainerContext };

/** Create install action context with JSON flag normalization. */
export function createDaemonInstallActionContext(jsonFlag: unknown) {
  const json = Boolean(jsonFlag);
  return {
    json,
    ...createDaemonActionContext({ action: "install", json }),
  };
}

/** Block service installation in Nix mode, where managed service install is unsupported. */
export function failIfNixDaemonInstallMode(
  fail: (message: string, hints?: string[]) => void,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!resolveIsNixMode(env)) {
    return false;
  }
  fail("Nix mode detected; service install is disabled.");
  return true;
}

/** Build terminal style helpers for status output with no-color fallback. */
export function createCliStatusTextStyles() {
  const rich = isRich();
  return {
    rich,
    label: (value: string) => colorize(rich, theme.muted, value),
    accent: (value: string) => colorize(rich, theme.accent, value),
    infoText: (value: string) => colorize(rich, theme.info, value),
    okText: (value: string) => colorize(rich, theme.success, value),
    warnText: (value: string) => colorize(rich, theme.warn, value),
    errorText: (value: string) => colorize(rich, theme.error, value),
  };
}

/** Pick the color function for a runtime status label. */
export function resolveRuntimeStatusColor(status: string | undefined): (value: string) => string {
  const runtimeStatus = status ?? "unknown";
  return runtimeStatus === "running"
    ? theme.success
    : runtimeStatus === "stopped"
      ? theme.error
      : runtimeStatus === "unknown"
        ? theme.muted
        : theme.warn;
}

/** Extract `--port` from service ProgramArguments. */
export function parsePortFromArgs(programArguments: string[] | undefined): number | null {
  return parseTcpPortFromArgs(programArguments);
}

/** Pick the best local probe host for a configured Gateway bind mode. */
export function pickProbeHostForBind(
  bindMode: string,
  tailnetIPv4: string | undefined,
  customBindHost?: string,
) {
  if (bindMode === "custom" && customBindHost?.trim()) {
    return customBindHost.trim();
  }
  if (bindMode === "tailnet") {
    return tailnetIPv4 ?? "127.0.0.1";
  }
  if (bindMode === "lan") {
    // Same as call.ts: self-connections should always target loopback.
    // bind=lan controls which interfaces the server listens on (0.0.0.0),
    // but co-located CLI probes should connect via 127.0.0.1.
    return "127.0.0.1";
  }
  return "127.0.0.1";
}

const SAFE_DAEMON_ENV_KEYS = [
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_NIX_MODE",
];

/** Keep only daemon env keys safe to print in diagnostics. */
export function filterDaemonEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) {
    return {};
  }
  const filtered: Record<string, string> = {};
  for (const key of SAFE_DAEMON_ENV_KEYS) {
    const value = env[key];
    if (!value?.trim()) {
      continue;
    }
    filtered[key] = value.trim();
  }
  return filtered;
}

/** Format safe daemon env entries for status output. */
export function safeDaemonEnv(env: Record<string, string> | undefined): string[] {
  const filtered = filterDaemonEnv(env);
  return Object.entries(filtered).map(([key, value]) => `${key}=${value}`);
}

/** Normalize listener address strings from platform socket tools. */
export function normalizeListenerAddress(raw: string): string {
  let value = raw.trim();
  if (!value) {
    return value;
  }
  value = value.replace(/^TCP\s+/i, "");
  value = value.replace(/\s+\(LISTEN\)\s*$/i, "");
  return value.trim();
}

/** Render platform-specific hints for missing/stopped Gateway runtimes. */
export function renderRuntimeHints(
  runtime:
    | {
        missingUnit?: boolean;
        missingSupervision?: boolean;
        missingGuiSession?: boolean;
        status?: string;
      }
    | undefined,
  env: NodeJS.ProcessEnv = process.env,
  logFile?: string | null,
): string[] {
  if (!runtime) {
    return [];
  }
  const hints: string[] = [];
  const fileLog = logFile ?? null;
  if (runtime.missingUnit) {
    hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.missingGuiSession) {
    hints.push(
      "LaunchAgent requires a logged-in macOS GUI session; SSH/headless/sudo shells cannot bootstrap gui/$UID.",
    );
    hints.push(
      `Sign in to the macOS desktop as this user, then run: ${formatCliCommand("openclaw gateway restart", env)}`,
    );
    hints.push(
      "For headless VM setups, enable auto-login for the target user or use a custom LaunchDaemon (not shipped).",
    );
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.missingSupervision) {
    hints.push(
      `LaunchAgent installed but not loaded. Run: ${formatCliCommand("openclaw gateway restart", env)}`,
    );
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    return hints;
  }
  if (runtime.status === "stopped") {
    if (fileLog) {
      hints.push(`File logs: ${fileLog}`);
    }
    hints.push(
      ...buildPlatformRuntimeLogHints({
        env,
        systemdServiceName: resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE),
        windowsTaskName: resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE),
      }),
    );
  }
  return hints;
}

/** Render install/start hints for the current service platform/container context. */
export function renderGatewayServiceStartHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const profile = env.OPENCLAW_PROFILE;
  const container = resolveDaemonContainerContext(env);
  const hints = buildPlatformServiceStartHints({
    installCommand: formatCliCommand("openclaw gateway install", env),
    startCommand: formatCliCommand("openclaw gateway", env),
    launchAgentPlistPath: `~/Library/LaunchAgents/${resolveGatewayLaunchAgentLabel(profile)}.plist`,
    systemdServiceName: resolveGatewaySystemdServiceName(profile),
    windowsTaskName: resolveGatewayWindowsTaskName(profile),
  });
  if (!container) {
    return hints;
  }
  return [`Restart the container or the service that manages it for ${container}.`];
}

/** Drop generic systemd hints when a container-specific hint is clearer. */
export function filterContainerGenericHints(
  hints: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!resolveDaemonContainerContext(env)) {
    return hints;
  }
  return hints.filter(
    (hint) =>
      !hint.includes("If you're in a container, run the gateway in the foreground instead of") &&
      !hint.includes("systemd user services are unavailable; install/enable systemd"),
  );
}
