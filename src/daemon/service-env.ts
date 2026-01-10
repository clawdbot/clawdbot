import path from "node:path";

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

export function getMinimalServicePathParts(
  options: MinimalServicePathOptions = {},
): string[] {
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

export function buildMinimalServicePath(
  options: BuildServicePathOptions = {},
): string {
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
  // Include the profile so the service knows which profile it's running under
  return {
    PATH: buildMinimalServicePath({ env }),
    CLAWDBOT_PROFILE: env.CLAWDBOT_PROFILE,
    CLAWDBOT_STATE_DIR: env.CLAWDBOT_STATE_DIR,
    CLAWDBOT_CONFIG_PATH: env.CLAWDBOT_CONFIG_PATH,
    CLAWDBOT_GATEWAY_PORT: String(port),
    CLAWDBOT_GATEWAY_TOKEN: token,
    CLAWDBOT_LAUNCHD_LABEL: launchdLabel,
  };
}
