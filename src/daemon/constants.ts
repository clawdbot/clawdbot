// Default service labels (for backward compatibility and when no profile specified)
export const GATEWAY_LAUNCH_AGENT_LABEL = "com.clawdbot.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "clawdbot-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "Clawdbot Gateway";

// Profile-aware label resolution
export function resolveGatewayLaunchAgentLabel(profile?: string): string {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `com.clawdbot.${trimmed}`;
}

export function resolveGatewaySystemdServiceName(profile?: string): string {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return GATEWAY_SYSTEMD_SERVICE_NAME;
  }
  return `clawdbot-gateway-${trimmed}`;
}

export function resolveGatewayWindowsTaskName(profile?: string): string {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return GATEWAY_WINDOWS_TASK_NAME;
  }
  return `Clawdbot Gateway (${trimmed})`;
}

export const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS = [
  "com.steipete.clawdbot.gateway",
  "com.steipete.clawdis.gateway",
  "com.clawdis.gateway",
];
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES = ["clawdis-gateway"];
export const LEGACY_GATEWAY_WINDOWS_TASK_NAMES = ["Clawdis Gateway"];
