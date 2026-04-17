const DEFAULT_SLASH_CALLBACK_PATH = "/api/channels/mattermost/command";

type MattermostSlashCommandConfigInput = {
  callbackPath?: unknown;
  callbackUrl?: unknown;
};

type MattermostAccountConfigInput = {
  commands?: MattermostSlashCommandConfigInput;
};

type MattermostConfigInput = MattermostAccountConfigInput & {
  accounts?: Record<string, unknown>;
};

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCallbackPath(value: unknown): string {
  const trimmed = readTrimmedString(value);
  if (!trimmed) {
    return DEFAULT_SLASH_CALLBACK_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function readMattermostCommands(value: unknown): MattermostSlashCommandConfigInput | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MattermostSlashCommandConfigInput)
    : undefined;
}

function isMattermostBypassPath(path: string): boolean {
  return path === DEFAULT_SLASH_CALLBACK_PATH || path.startsWith("/api/channels/mattermost/");
}

export function collectMattermostSlashCallbackPaths(
  raw?: MattermostSlashCommandConfigInput,
): string[] {
  const paths = new Set<string>([normalizeCallbackPath(raw?.callbackPath)]);
  const callbackUrl = readTrimmedString(raw?.callbackUrl);
  if (callbackUrl) {
    try {
      const pathname = new URL(callbackUrl).pathname;
      if (pathname) {
        paths.add(pathname);
      }
    } catch {
      // Keep the normalized callback path when the configured URL is invalid.
    }
  }
  return [...paths];
}

export function resolveMattermostGatewayAuthBypassPaths(cfg: {
  channels?: Record<string, unknown>;
}): string[] {
  const base =
    cfg.channels?.mattermost && typeof cfg.channels.mattermost === "object"
      ? (cfg.channels.mattermost as MattermostConfigInput)
      : undefined;
  const callbackPaths = new Set(
    collectMattermostSlashCallbackPaths(readMattermostCommands(base?.commands)).filter(
      isMattermostBypassPath,
    ),
  );
  const accounts = base?.accounts ?? {};
  for (const account of Object.values(accounts)) {
    const accountConfig =
      account && typeof account === "object" && !Array.isArray(account)
        ? (account as MattermostAccountConfigInput)
        : undefined;
    for (const path of collectMattermostSlashCallbackPaths(
      readMattermostCommands(accountConfig?.commands),
    )) {
      if (isMattermostBypassPath(path)) {
        callbackPaths.add(path);
      }
    }
  }
  return [...callbackPaths];
}
