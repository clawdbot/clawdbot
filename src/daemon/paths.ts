/** Resolves daemon state, home, and generated task-script paths. */
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayProfileSuffix } from "./constants.js";

const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;

/** Resolves the home directory used for daemon state paths. */
// Daemon unit files must not use infra/home-dir because runtime overrides cannot leak into services.
export function resolveDaemonHomeDir(env: Record<string, string | undefined>): string {
  const home = normalizeOptionalString(env.HOME) || normalizeOptionalString(env.USERPROFILE);
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

function normalizeLoginUsername(value: string | undefined): string | undefined {
  const username = normalizeOptionalString(value);
  if (!username || username === "." || username === ".." || /[/\\\0]/.test(username)) {
    return undefined;
  }
  return username;
}

function resolveLoginUsername(env: Record<string, string | undefined>): string | undefined {
  try {
    const username = normalizeLoginUsername(os.userInfo().username);
    if (username) {
      return username;
    }
  } catch {
    // Fall through to environment compatibility values.
  }
  for (const value of [env.USER, env.LOGNAME]) {
    const username = normalizeLoginUsername(value);
    if (username) {
      return username;
    }
  }
  return undefined;
}

/**
 * Resolves the macOS home whose Library/LaunchAgents launchd can bootstrap.
 * State, logs, and generated environment artifacts intentionally keep using
 * resolveDaemonHomeDir so an external HOME remains the user's data location.
 */
export function resolveLaunchAgentHomeDir(env: Record<string, string | undefined>): string {
  const home = resolveDaemonHomeDir(env);
  let rootDevice: number;
  try {
    rootDevice = fsSync.statSync("/").dev;
    if (rootDevice === fsSync.statSync(home).dev) {
      return home;
    }
  } catch {
    return home;
  }
  const username = resolveLoginUsername(env);
  if (!username) {
    return home;
  }
  const canonicalHome = path.posix.join("/Users", username);
  try {
    return fsSync.statSync(canonicalHome).dev === rootDevice ? canonicalHome : home;
  } catch {
    return home;
  }
}

function resolveUserPathWithHome(input: string, home?: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    if (!home) {
      throw new Error("Missing HOME");
    }
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, () => home);
    return path.resolve(expanded);
  }
  if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) {
    // Do not path.resolve Windows paths on POSIX hosts during cross-platform
    // service rendering; it would corrupt drive and UNC prefixes.
    return trimmed;
  }
  return path.resolve(trimmed);
}

export function resolveGatewayStateDir(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  if (override) {
    const home = override.startsWith("~") ? resolveDaemonHomeDir(env) : undefined;
    return resolveUserPathWithHome(override, home);
  }
  const home = resolveDaemonHomeDir(env);
  const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
  // Profile suffixes isolate managed service files while preserving the default
  // historical ~/.openclaw state path.
  return path.join(home, `.openclaw${suffix}`);
}

export function resolveGatewayTaskScriptPath(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_TASK_SCRIPT);
  if (override) {
    return override;
  }
  const scriptName = normalizeOptionalString(env.OPENCLAW_TASK_SCRIPT_NAME) || "gateway.cmd";
  if (/[/\\]|\.\./.test(scriptName)) {
    throw new Error(
      `OPENCLAW_TASK_SCRIPT_NAME must be a file name only, not a path: ${scriptName}`,
    );
  }
  return path.join(resolveGatewayStateDir(env), scriptName);
}
