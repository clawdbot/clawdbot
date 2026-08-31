/** Reads persisted LaunchAgent stdio paths so status does not invent them. */
import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { parseLaunchdPlistStdioPaths } from "./launchd-plist.js";
import { resolveLaunchAgentPlistPath } from "./launchd-service-files.js";
import type { GatewayServiceEnv } from "./service-types.js";

const LAUNCHD_NULL_STDIO_PATH = "/dev/null";

export function isLaunchdStdioSuppressed(path: string | null | undefined): boolean {
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

/** Loaded LaunchAgents skip a plain install; restart or install --force rewrites stderr. */
export function formatLaunchdStderrRewriteGuidance(env: GatewayServiceEnv = process.env): string {
  return `Rewrite the LaunchAgent with ${formatCliCommand("openclaw gateway restart", env)} or ${formatCliCommand("openclaw gateway install --force", env)}.`;
}
