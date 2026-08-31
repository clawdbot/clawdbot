/** Reads persisted LaunchAgent stdio paths so status does not invent them. */
import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { parseLaunchdPlistStdioPaths } from "./launchd-plist.js";
import { resolveLaunchAgentPlistPath } from "./launchd-service-files.js";
import type { GatewayServiceEnv } from "./service-types.js";

const LAUNCHD_NULL_STDIO_PATH = "/dev/null";

// Type predicate so advertised-file callers get a real path. A plain boolean
// leaves `string | null` in the file branch and fails check-prod-types.
export function isLaunchdStdioSuppressed(
  path: string | null | undefined,
): path is null | undefined | "" | typeof LAUNCHD_NULL_STDIO_PATH {
  return !path || path === LAUNCHD_NULL_STDIO_PATH;
}

/** Returns the installed LaunchAgent stderr path, or null when it is absent or unreadable. */
export function readPersistedLaunchdStderrPath(env: GatewayServiceEnv): string | null {
  try {
    const contents = fs.readFileSync(resolveLaunchAgentPlistPath(env), "utf8");
    return parseLaunchdPlistStdioPaths(contents).stderrPath;
  } catch {
    return null;
  }
}

/** Advertises stderr only when the installed plist actually writes that file. */
export function resolveAdvertisedLaunchdStderr(
  persistedStderrPath: string | null,
): { kind: "file"; path: string } | { kind: "suppressed" } {
  if (isLaunchdStdioSuppressed(persistedStderrPath)) {
    return { kind: "suppressed" };
  }
  return { kind: "file", path: persistedStderrPath };
}

export type LaunchdStderrRewriteCommands = {
  restartCommand: string;
  forceInstallCommand: string;
};

const GATEWAY_LAUNCHD_STDERR_REWRITE_COMMANDS: LaunchdStderrRewriteCommands = {
  restartCommand: "openclaw gateway restart",
  forceInstallCommand: "openclaw gateway install --force",
};

/** Loaded LaunchAgents skip a plain install; restart or install --force rewrites stderr. */
export function formatLaunchdStderrRewriteGuidance(
  env: GatewayServiceEnv = process.env,
  commands: LaunchdStderrRewriteCommands = GATEWAY_LAUNCHD_STDERR_REWRITE_COMMANDS,
): string {
  return `Rewrite the LaunchAgent with ${formatCliCommand(commands.restartCommand, env)} or ${formatCliCommand(commands.forceInstallCommand, env)}.`;
}
