// Normalizes Chrome MCP profile options and subprocess arguments.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import parseArgs from "yargs-parser";
import type {
  ChromeMcpOptionsInput,
  ChromeMcpProfileOptions,
  NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import { BrowserProfileUnavailableError } from "./errors.js";

const DEFAULT_CHROME_MCP_COMMAND = "npx";
// Optional npm audits must not delay the handshake. Use =false so npx does not
// consume the package name as a value for --no-audit and drop Chrome MCP's flags.
const DEFAULT_CHROME_MCP_PACKAGE_ARGS = ["-y", "--audit=false", "chrome-devtools-mcp@1.8.0"];
const DEFAULT_CHROME_MCP_FEATURE_ARGS = [
  "--no-usage-statistics",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
];
const CHROME_MCP_USAGE_STATISTICS_FLAG_RE = /^--(?:no-)?usage-?statistics(?:=.*)?$/i;

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
  if (typeof input === "object" && input && "command" in input && "args" in input) {
    return input;
  }
  const options = typeof input === "string" ? { userDataDir: input } : (input ?? {});
  const command = normalizeOptionalString(options.mcpCommand) ?? DEFAULT_CHROME_MCP_COMMAND;
  const extraArgs = normalizeChromeMcpStringList(options.mcpArgs);
  // Match Chrome MCP's Yargs grammar, including short groups and camel-case
  // aliases. Policy and direct CDP operations must use the endpoint it launches.
  const { argv, error } = parseArgs.detailed(extraArgs, {
    alias: { browserUrl: "u", wsEndpoint: "w" },
    string: ["browserUrl", "wsEndpoint", "userDataDir"],
    boolean: ["autoConnect"],
    configuration: { "strip-aliased": true, "strip-dashed": true },
  });
  const endpoint: unknown = argv.wsEndpoint ?? argv.browserUrl;
  if (
    error ||
    (argv.browserUrl !== undefined && argv.wsEndpoint !== undefined) ||
    (endpoint !== undefined && (typeof endpoint !== "string" || !URL.canParse(endpoint))) ||
    (argv.autoConnect !== undefined && typeof argv.autoConnect !== "boolean")
  ) {
    throw new BrowserProfileUnavailableError(
      "Chrome MCP endpoint arguments must select one valid browserUrl or wsEndpoint URL. Remove duplicate, conflicting, or empty endpoint arguments from mcpArgs.",
    );
  }
  if (
    typeof endpoint === "string" &&
    !(argv.wsEndpoint !== undefined ? /^wss?:$/ : /^https?:$/).test(new URL(endpoint).protocol)
  ) {
    throw new BrowserProfileUnavailableError(
      "Chrome MCP endpoint arguments require http(s) for browserUrl or ws(s) for wsEndpoint.",
    );
  }
  const overridesConnection = endpoint !== undefined || argv.autoConnect !== undefined;
  const browserUrl = overridesConnection
    ? typeof endpoint === "string"
      ? endpoint
      : undefined
    : normalizeOptionalString(options.cdpUrl);
  const userDataDir = normalizeOptionalString(options.userDataDir);
  const connectionArgs = overridesConnection
    ? []
    : browserUrl
      ? [/^wss?:\/\//i.test(browserUrl) ? "--wsEndpoint" : "--browserUrl", browserUrl]
      : ["--autoConnect"];
  const defaultFeatureArgs = extraArgs.some((arg) => CHROME_MCP_USAGE_STATISTICS_FLAG_RE.test(arg))
    ? DEFAULT_CHROME_MCP_FEATURE_ARGS.filter((arg) => arg !== "--no-usage-statistics")
    : DEFAULT_CHROME_MCP_FEATURE_ARGS;
  return {
    command,
    userDataDir,
    browserUrl,
    args: [
      ...(command === DEFAULT_CHROME_MCP_COMMAND ? DEFAULT_CHROME_MCP_PACKAGE_ARGS : []),
      ...connectionArgs,
      ...defaultFeatureArgs,
      // Stable custom launchers may still need the opt-in flag; pinned 1.8 enables it by default.
      ...(command === DEFAULT_CHROME_MCP_COMMAND ? [] : ["--experimental-page-id-routing"]),
      ...(!overridesConnection && !browserUrl && userDataDir && argv.userDataDir === undefined
        ? ["--userDataDir", userDataDir]
        : []),
      ...extraArgs,
    ],
  };
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
    options.args,
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
