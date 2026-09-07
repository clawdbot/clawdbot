// Fast-path argv parser for `openclaw gateway ...` without full Commander registration.
import { WINDOWS_TASK_SUPERVISOR_FLAG } from "../daemon/windows-task-supervisor-contract.js";
import {
  consumeRootCommandOptionToken,
  getCommandArgsWithRootOptions,
  getCommandPositionalsWithRootOptions,
  isValueToken,
} from "../infra/cli-root-options.js";

const GATEWAY_RUN_VALUE_FLAGS = new Set([
  "--port",
  "--bind",
  "--token",
  "--token-file",
  "--auth",
  "--password",
  "--password-file",
  "--tailscale",
  "--ws-log",
  "--raw-stream-path",
]);

const GATEWAY_RUN_BOOLEAN_FLAGS = new Set([
  "--tailscale-reset-on-exit",
  "--allow-unconfigured",
  "--dev",
  "--ambient-channels",
  "--dev-ambient-channels",
  "--reset",
  "--force",
  "--verbose",
  "--cli-backend-logs",
  "--claude-cli-logs",
  "--compact",
  "--raw-stream",
]);

export function isForegroundGatewayRunArgv(argv: string[]): boolean {
  const positionals = getCommandPositionalsWithRootOptions(argv, {
    commandPath: ["gateway"],
    booleanFlags: [...GATEWAY_RUN_BOOLEAN_FLAGS],
    valueFlags: [...GATEWAY_RUN_VALUE_FLAGS],
    mode: "command-path",
  });
  if (!positionals) {
    return false;
  }
  // Foreground gateway owns the terminal/process environment itself; respawning would
  // add an extra parent process around the long-lived server.
  return positionals.length === 0 || (positionals.length === 1 && positionals[0] === "run");
}

/** Return how many argv tokens a gateway-run option consumes, or 0 when not recognized. */
export function consumeGatewayRunOptionToken(args: ReadonlyArray<string>, index: number): number {
  const arg = args[index];
  if (!arg || arg === "--" || !arg.startsWith("-")) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (GATEWAY_RUN_BOOLEAN_FLAGS.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!GATEWAY_RUN_VALUE_FLAGS.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return isValueToken(args[index + 1]) ? 2 : 0;
}

function consumeGatewayRunPreBootstrapOptionToken(
  args: ReadonlyArray<string>,
  index: number,
): number {
  const rootConsumed = consumeRootCommandOptionToken(args, index);
  if (rootConsumed > 0) {
    return rootConsumed;
  }
  const consumed = consumeGatewayRunOptionToken(args, index);
  if (consumed > 0) {
    return consumed;
  }
  const arg = args[index];
  if (arg && GATEWAY_RUN_VALUE_FLAGS.has(arg) && args[index + 1] !== undefined) {
    // Required values can look like flags; consume them before considering destructive options.
    return 2;
  }
  return 0;
}

/** Return how many root fast-path tokens are consumed before the `gateway` command. */
export function consumeGatewayFastPathRootOptionToken(
  args: ReadonlyArray<string>,
  index: number,
): number {
  const arg = args[index];
  if (!arg || arg === "--") {
    return 0;
  }
  if (arg === "--no-color") {
    return 1;
  }
  if (arg.startsWith("--profile=")) {
    return arg.slice("--profile=".length).trim() ? 1 : 0;
  }
  if (arg === "--profile") {
    return isValueToken(args[index + 1]) ? 2 : 0;
  }
  return 0;
}

/** Resolve the gateway command path from raw argv without full Commander registration. */
export function resolveGatewayCommandPath(argv: string[], depth = 2): string[] | null {
  const positionals = getCommandPositionalsWithRootOptions(argv, {
    commandPath: ["gateway"],
    // Supervisor commands use full parsing but still need Gateway startup selection.
    booleanFlags: [...GATEWAY_RUN_BOOLEAN_FLAGS, WINDOWS_TASK_SUPERVISOR_FLAG],
    valueFlags: [...GATEWAY_RUN_VALUE_FLAGS],
    maxPositionals: depth - 1,
    mode: "command-path",
  });
  return positionals ? ["gateway", ...positionals] : null;
}

/** Resolve the gateway command path used by catalog and startup-policy lookups. */
export function resolveGatewayCatalogCommandPath(argv: string[]): string[] | null {
  return resolveGatewayCommandPath(argv, 2);
}

/** Resolve destructive gateway-run flags before Commander registration. */
export function resolveGatewayRunPreBootstrapOptions(
  argv: string[],
): { force: boolean; reset: boolean } | null {
  const args = getCommandArgsWithRootOptions(argv, {
    commandPath: ["gateway"],
    mode: "command-path",
  });
  if (!args) {
    return null;
  }
  let force = false;
  let reset = false;
  let sawRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      break;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    const consumed = consumeGatewayRunPreBootstrapOptionToken(args, index);
    if (consumed > 0) {
      if (arg === "--force") {
        force = true;
      } else if (arg === "--reset") {
        reset = true;
      }
      index += consumed - 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return null;
    }
  }

  return { force, reset };
}
