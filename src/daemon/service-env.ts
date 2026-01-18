import path from "node:path";

import { VERSION } from "../version.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";

export type MinimalServicePathOptions = {
  platform?: NodeJS.Platform;
  extraDirs?: string[];
};

type BuildServicePathOptions = MinimalServicePathOptions & {
  env?: Record<string, string | undefined>;
};

function resolveSystemPathDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  }
  if (platform === "linux") {
    return ["/usr/local/bin", "/usr/bin", "/bin"];
  }
  return [];
}

export function getMinimalServicePathParts(options: MinimalServicePathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return [];

  const parts: string[] = [];
  const extraDirs = options.extraDirs ?? [];
  const systemDirs = resolveSystemPathDirs(platform);

  const add = (dir: string) => {
    if (!dir) return;
    if (!parts.includes(dir)) parts.push(dir);
  };

  for (const dir of extraDirs) add(dir);
  for (const dir of systemDirs) add(dir);

  return parts;
}

export function buildMinimalServicePath(options: BuildServicePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return env.PATH ?? "";
  }

  return getMinimalServicePathParts(options).join(path.delimiter);
}

export function buildServiceEnvironment(params: {
  env: Record<string, string | undefined>;
  port: number;
  token?: string;
  launchdLabel?: string;
}): Record<string, string | undefined> {
  const { env, port, token, launchdLabel } = params;
  const profile = env.CLAWDBOT_PROFILE;
  const resolvedLaunchdLabel =
    launchdLabel ||
    (process.platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : undefined);
  const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
  return {
    PATH: buildMinimalServicePath({ env }),
    CLAWDBOT_PROFILE: profile,
    CLAWDBOT_STATE_DIR: env.CLAWDBOT_STATE_DIR,
    CLAWDBOT_CONFIG_PATH: env.CLAWDBOT_CONFIG_PATH,
    CLAWDBOT_GATEWAY_PORT: String(port),
    CLAWDBOT_GATEWAY_TOKEN: token,
    CLAWDBOT_LAUNCHD_LABEL: resolvedLaunchdLabel,
    CLAWDBOT_SYSTEMD_UNIT: systemdUnit,
    CLAWDBOT_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
    CLAWDBOT_SERVICE_KIND: GATEWAY_SERVICE_KIND,
    CLAWDBOT_SERVICE_VERSION: VERSION,
  };
}

export function buildNodeServiceEnvironment(params: {
  env: Record<string, string | undefined>;
}): Record<string, string | undefined> {
  const { env } = params;
  return {
    PATH: buildMinimalServicePath({ env }),
    CLAWDBOT_STATE_DIR: env.CLAWDBOT_STATE_DIR,
    CLAWDBOT_CONFIG_PATH: env.CLAWDBOT_CONFIG_PATH,
    CLAWDBOT_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    CLAWDBOT_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    CLAWDBOT_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    CLAWDBOT_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    CLAWDBOT_LOG_PREFIX: "node",
    CLAWDBOT_SERVICE_MARKER: NODE_SERVICE_MARKER,
    CLAWDBOT_SERVICE_KIND: NODE_SERVICE_KIND,
    CLAWDBOT_SERVICE_VERSION: VERSION,
  };
}
