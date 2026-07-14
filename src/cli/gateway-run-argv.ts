// Fast-path argv parser for `openclaw gateway ...` without full Commander registration.
import { consumeRootOptionToken, isValueToken } from "../infra/cli-root-options.js";

const GATEWAY_RUN_VALUE_FLAGS = new Set([
  "--port",
  "--bind",
  "--token",
  "--token-file",
  "--auth",
  "--password",
  "--password-file",
  "--hosting-profile",
  "--runtime-id",
  "--incarnation-id",
  "--tailscale",
  "--ws-log",
  "--raw-stream-path",
]);

const GATEWAY_RUN_BOOLEAN_FLAGS = new Set([
  "--tailscale-reset-on-exit",
  "--allow-unconfigured",
  "--dev",
  "--reset",
  "--force",
  "--verbose",
  "--cli-backend-logs",
  "--claude-cli-logs",
  "--compact",
  "--raw-stream",
]);

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

function resolveGatewayCommandStart(argv: string[]): {
  args: string[];
  startIndex: number;
} | null {
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === "--") {
      return null;
    }
    const consumed = consumeRootOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg === "gateway" ? { args, startIndex: index + 1 } : null;
  }
  return null;
}

/** Resolve the gateway command path from raw argv for catalog/policy lookups. */
export function resolveGatewayCatalogCommandPath(argv: string[]): string[] | null {
  const gateway = resolveGatewayCommandStart(argv);
  if (!gateway) {
    return null;
  }
  for (let index = gateway.startIndex; index < gateway.args.length; index += 1) {
    const arg = gateway.args[index];
    if (!arg || arg === "--") {
      break;
    }
    const consumed = consumeGatewayRunOptionToken(gateway.args, index);
    if (consumed > 0) {
      index += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return ["gateway", arg];
  }

  return ["gateway"];
}

/** Resolve destructive gateway-run flags before Commander registration. */
export function resolveGatewayRunPreBootstrapOptions(
  argv: string[],
): { force: boolean; reset: boolean } | null {
  const gateway = resolveGatewayCommandStart(argv);
  if (!gateway) {
    return null;
  }
  let force = false;
  let reset = false;
  let sawRun = false;

  for (let index = gateway.startIndex; index < gateway.args.length; index += 1) {
    const arg = gateway.args[index];
    if (!arg || arg === "--") {
      break;
    }
    if (!sawRun && arg === "run") {
      sawRun = true;
      continue;
    }
    const consumed = consumeGatewayRunPreBootstrapOptionToken(gateway.args, index);
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
