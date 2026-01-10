// Default service labels (for backward compatibility and when no profile specified)
export const GATEWAY_LAUNCH_AGENT_LABEL = "com.clawdbot.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "clawdbot-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "Clawdbot Gateway";

// Profile-aware label resolution
export function resolveGatewayLaunchAgentLabel(
  env: Record<string, string | undefined>,
): string {
  const profile = env.CLAWDBOT_PROFILE?.trim();
  if (!profile || profile.toLowerCase() === "default") {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `com.clawdbot.${profile}`;
}

export function resolveGatewaySystemdServiceName(
  env: Record<string, string | undefined>,
): string {
  const profile = env.CLAWDBOT_PROFILE?.trim();
  if (!profile || profile.toLowerCase() === "default") {
    return GATEWAY_SYSTEMD_SERVICE_NAME;
  }
  return `clawdbot-gateway-${profile}`;
}

export function resolveGatewayWindowsTaskName(
  env: Record<string, string | undefined>,
): string {
  const profile = env.CLAWDBOT_PROFILE?.trim();
  if (!profile || profile.toLowerCase() === "default") {
    return GATEWAY_WINDOWS_TASK_NAME;
  }
  return `Clawdbot Gateway (${profile})`;
}

export const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS = [
  "com.steipete.clawdbot.gateway",
  "com.steipete.clawdis.gateway",
  "com.clawdis.gateway",
];
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES = ["clawdis-gateway"];
export const LEGACY_GATEWAY_WINDOWS_TASK_NAMES = ["Clawdis Gateway"];
