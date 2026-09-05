// CLI respawn skip policy for help, interactive TTY commands, and foreground Gateway runs.
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { getCommandPathWithRootOptions } from "./argv.js";
import { isForegroundGatewayRunArgv } from "./gateway-run-argv.js";

const INTERACTIVE_TTY_COMMANDS = new Set(["tui", "terminal", "chat"]);

/** Gmail owns a shutdown grace period longer than the generic respawn wrapper allows. */
export function isForegroundGmailRunArgv(argv: string[]): boolean {
  return getCommandPathWithRootOptions(argv, 3).join(" ") === "webhooks gmail run";
}

export function isNativeHookRelayArgv(argv: string[]): boolean {
  const { commandPath } = resolveCliArgvInvocation(argv);
  return commandPath[0] === "hooks" && commandPath[1] === "relay";
}

export function shouldKeepNativeHookRelayInProcess(
  argv: string[],
  platform: NodeJS.Platform,
): boolean {
  return platform !== "win32" && isNativeHookRelayArgv(argv);
}

function isInteractiveTtyCommandArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return invocation.primary !== null && INTERACTIVE_TTY_COMMANDS.has(invocation.primary);
}

export function isTerminalInteractiveRespawnArgv(argv: string[]): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  return invocation.primary === null || INTERACTIVE_TTY_COMMANDS.has(invocation.primary);
}

/** Returns whether CLI startup should avoid the general respawn wrapper for this argv. */
export function shouldSkipRespawnForArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  const isGatewayStatus =
    invocation.commandPath.length === 2 &&
    invocation.commandPath[0] === "gateway" &&
    invocation.commandPath[1] === "status";
  return (
    invocation.hasHelpOrVersion ||
    isInteractiveTtyCommandArgv(argv) ||
    isForegroundGmailRunArgv(argv) ||
    shouldKeepNativeHookRelayInProcess(argv, platform) ||
    // Status commonly overlaps the running Gateway; a warning-only wrapper doubles
    // transient CLI memory. Startup-environment respawn remains separately owned.
    isGatewayStatus ||
    (invocation.primary === "gateway" && isForegroundGatewayRunArgv(argv))
  );
}

/** Returns whether startup-environment respawn should be skipped without suppressing TUI respawn policy. */
export function shouldSkipStartupEnvironmentRespawnForArgv(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const invocation = resolveCliArgvInvocation(argv);
  return (
    invocation.hasHelpOrVersion ||
    isForegroundGmailRunArgv(argv) ||
    // Codex owns the relay subprocess timeout. A detached startup respawn can
    // outlive the launcher when Codex kills it, stranding the relay child.
    shouldKeepNativeHookRelayInProcess(argv, platform) ||
    (invocation.primary === "gateway" && isForegroundGatewayRunArgv(argv))
  );
}
