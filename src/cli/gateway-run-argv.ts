// Fast-path argv parser for `openclaw gateway ...` without full Commander registration.
import {
  consumeRootOptionToken,
  findRootCommandIndex,
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
  const rootConsumed = consumeRootOptionToken(args, index);
  if (rootConsumed > 0) {
    return rootConsumed;
  }
  const consumed = consumeGatewayRunOptionToken(args, index);
  if (consumed > 0) {
    return consumed;
  }
  const arg = args[index];
  if (arg && GATEWAY_RUN_VALUE_FLAGS.has(arg) && args[index + 1] !== undefined) {
    // Commander will reject option-looking required values later. Consume them here so malformed
    // input cannot accidentally enable a destructive flag before parsing reaches that error.
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

function resolveGatewayCommandStart(argv: string[]): number | null {
  const index = findRootCommandIndex(argv);
  return index !== null && argv[index] === "gateway" ? index + 1 : null;
}

/** Resolve the gateway command path from raw argv without full Commander registration. */
export function resolveGatewayCommandPath(argv: string[], depth = 2): string[] | null {
  const startIndex = resolveGatewayCommandStart(argv);
  if (startIndex === null) {
    return null;
  }
  const commandPath = ["gateway"];
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") {
      break;
    }
    const rootConsumed = consumeRootOptionToken(argv, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    const consumed = consumeGatewayRunOptionToken(argv, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    commandPath.push(arg);
    if (commandPath.length >= depth) {
      return commandPath;
    }
  }

  return commandPath;
}

/** Resolve the gateway command path used by catalog and startup-policy lookups. */
export function resolveGatewayCatalogCommandPath(argv: string[]): string[] | null {
  return resolveGatewayCommandPath(argv, 2);
}

/** Resolve destructive gateway-run flags before Commander registration. */
export function resolveGatewayRunPreBootstrapOptions(
  argv: string[],
): { force: boolean; reset: boolean } | null {
  const startIndex = resolveGatewayCommandStart(argv);
  if (startIndex === null) {
    return null;
  }
  let force = false;
  let reset = false;
  let sawRun = false;

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") {
      break;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    const consumed = consumeGatewayRunPreBootstrapOptionToken(argv, index);
    if (consumed > 0) {
      if (arg === "--force") {
        force = true;
      } else if (arg === "--reset") {
        reset = true;
      }
      index += consumed - 1;
      continue;
    }
    if (arg === "--force") {
      force = true;
    } else if (arg === "--reset") {
      reset = true;
    }
    if (!arg.startsWith("-")) {
      return null;
    }
  }

  return { force, reset };
}
