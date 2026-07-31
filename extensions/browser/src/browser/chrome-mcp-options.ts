// Normalizes Chrome MCP profile options and subprocess arguments.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CHROME_MCP_CONNECTION_FLAGS,
  CHROME_MCP_USAGE_STATISTICS_FLAG_RE,
  CHROME_MCP_USER_DATA_DIR_FLAGS,
  DEFAULT_CHROME_MCP_COMMAND,
  DEFAULT_CHROME_MCP_FEATURE_ARGS,
  DEFAULT_CHROME_MCP_PACKAGE_ARGS,
  type ChromeMcpOptionsInput,
  type ChromeMcpProfileOptions,
  type NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";

function normalizeChromeMcpUserDataDir(userDataDir?: string): string | undefined {
  const trimmed = userDataDir?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeChromeMcpStringList(values?: string[]): string[] {
  return Array.isArray(values)
    ? values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
}

export function normalizeChromeMcpOptions(
  input?: ChromeMcpOptionsInput,
): NormalizedChromeMcpProfileOptions {
  if (typeof input === "object" && input && "command" in input && "extraArgs" in input) {
    return input;
  }
  const options = typeof input === "string" ? { userDataDir: input } : (input ?? {});
  const command = normalizeOptionalString(options.mcpCommand) ?? DEFAULT_CHROME_MCP_COMMAND;
  return {
    command,
    userDataDir: normalizeChromeMcpUserDataDir(options.userDataDir),
    browserUrl: normalizeOptionalString(options.cdpUrl),
    extraArgs: normalizeChromeMcpStringList(options.mcpArgs),
  };
}

function hasFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) => {
    const [name] = arg.split("=", 1);
    return flags.has(name ?? arg);
  });
}

function isChromeMcpWebSocketEndpoint(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

function buildChromeMcpConnectionArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)) {
    return [];
  }
  if (options.browserUrl) {
    return isChromeMcpWebSocketEndpoint(options.browserUrl)
      ? ["--wsEndpoint", options.browserUrl]
      : ["--browserUrl", options.browserUrl];
  }
  return ["--autoConnect"];
}

function buildChromeMcpUserDataDirArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (
    !options.userDataDir ||
    options.browserUrl ||
    hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS) ||
    hasFlag(options.extraArgs, CHROME_MCP_USER_DATA_DIR_FLAGS)
  ) {
    return [];
  }
  return ["--userDataDir", options.userDataDir];
}

export function buildChromeMcpSessionCacheKey(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): string {
  return JSON.stringify([
    profileName,
    options.userDataDir ?? "",
    options.browserUrl ?? "",
    options.command,
    options.extraArgs,
  ]);
}

export function chromeMcpProfileOptionsFromParams(params: {
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
}): string | ChromeMcpProfileOptions | undefined {
  return params.profile ?? params.userDataDir;
}

export function cacheKeyMatchesProfileName(cacheKey: string, profileName: string): boolean {
  try {
    const parsed = JSON.parse(cacheKey);
    return Array.isArray(parsed) && parsed[0] === profileName;
  } catch {
    return false;
  }
}

export function buildChromeMcpArgsFromOptions(
  options: NormalizedChromeMcpProfileOptions,
): string[] {
  const commandPrefix =
    options.command === DEFAULT_CHROME_MCP_COMMAND ? DEFAULT_CHROME_MCP_PACKAGE_ARGS : [];
  const defaultFeatureArgs = options.extraArgs.some((arg) =>
    CHROME_MCP_USAGE_STATISTICS_FLAG_RE.test(arg),
  )
    ? DEFAULT_CHROME_MCP_FEATURE_ARGS.filter((arg) => arg !== "--no-usage-statistics")
    : DEFAULT_CHROME_MCP_FEATURE_ARGS;
  return [
    ...commandPrefix,
    ...buildChromeMcpConnectionArgs(options),
    ...defaultFeatureArgs,
    ...buildChromeMcpUserDataDirArgs(options),
    ...options.extraArgs,
  ];
}
