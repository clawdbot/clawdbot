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
import { buildPlatformServiceStartHints } from "../../daemon/runtime-hints.js";
import { hasSudoToRootSystemdUserManagerMismatch } from "../../daemon/systemd-exec.js";
import { resolveGatewayServiceMutationError } from "../../infra/gateway-supervision.js";
import { formatCliCommand } from "../command-format.js";
import { parsePort } from "../shared/parse-port.js";
import { createDaemonActionContext } from "./response.js";

export { formatRuntimeStatus };
export { parsePort };

/** Create install action context with JSON flag normalization. */
export function createDaemonInstallActionContext(jsonFlag: unknown) {
  const json = Boolean(jsonFlag);
  return {
    json,
    ...createDaemonActionContext({ action: "install", json }),
  };
}

/** Resolve installation refusal before service or state inspection. */
export function resolveDaemonInstallBlockMessage(
  service: "gateway" | "node",
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (resolveIsNixMode(env)) {
    return "Nix mode detected; service install is disabled.";
  }
  // Node installation shares the Nix gate, not Gateway ownership policy.
  if (service === "node") {
    return undefined;
  }
  const mutationError = resolveGatewayServiceMutationError(
    "install or rewrite the gateway service",
    env,
  );
  if (mutationError) {
    return `Gateway install blocked: ${String(mutationError)}`;
  }
  if (process.platform === "linux" && hasSudoToRootSystemdUserManagerMismatch(env)) {
    return (
      "Gateway install blocked: Refusing a sudo-to-root systemd user-service install because " +
      "OpenClaw state and service files would belong to root while systemctl targets the " +
      "invoking user's manager. Rerun the same command without sudo. If [unsafe-permissions] " +
      "blocked the non-sudo command, repair the reported directory with `chmod go-w <path>` " +
      "and retry; do not use sudo or --force to bypass it. " +
      "See https://docs.openclaw.ai/cli/gateway#install-identity."
    );
  }
  return undefined;
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
  // Same as call.ts: self-connections should always target loopback.
  // bind=lan controls which interfaces the server listens on (0.0.0.0),
  // but co-located CLI probes should connect via 127.0.0.1.
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

/** Render install/start hints for the current service platform/container context. */
export function renderGatewayServiceStartHints(env: NodeJS.ProcessEnv = process.env): string[] {
  const container = resolveDaemonContainerContext(env);
  if (container) {
    return [`Restart the container or the service that manages it for ${container}.`];
  }
  const profile = env.OPENCLAW_PROFILE;
  const installHint =
    resolveDaemonInstallBlockMessage("gateway", env) ??
    formatCliCommand("openclaw gateway install", env);
  return buildPlatformServiceStartHints({
    installHint,
    startCommand: formatCliCommand("openclaw gateway start", env),
    launchAgentPlistPath: `~/Library/LaunchAgents/${resolveGatewayLaunchAgentLabel(profile)}.plist`,
    systemdServiceName: resolveGatewaySystemdServiceName(profile),
    windowsTaskName: resolveGatewayWindowsTaskName(profile),
  });
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
