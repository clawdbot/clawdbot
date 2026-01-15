// Default service labels (for backward compatibility and when no profile specified)
export const GATEWAY_LAUNCH_AGENT_LABEL = "com.clawdbot.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "clawdbot-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "Clawdbot Gateway";
export const GATEWAY_SERVICE_MARKER = "clawdbot";
export const GATEWAY_SERVICE_KIND = "gateway";
export const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS = ["com.steipete.clawdbot.gateway"];
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[] = [];
export const LEGACY_GATEWAY_WINDOWS_TASK_NAMES: string[] = [];

export function resolveGatewayLaunchAgentLabel(profile?: string): string {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `com.clawdbot.${trimmed}`;
}

function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return null;
  return trimmed;
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

export function formatGatewayServiceDescription(params?: {
  profile?: string;
  version?: string;
}): string {
  const profile = normalizeGatewayProfile(params?.profile);
  const version = params?.version?.trim();
  const parts: string[] = [];
  if (profile) parts.push(`profile: ${profile}`);
  if (version) parts.push(`v${version}`);
  if (parts.length === 0) return "Clawdbot Gateway";
  return `Clawdbot Gateway (${parts.join(", ")})`;
}
