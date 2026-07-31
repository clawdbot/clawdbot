// Classifies OpenClaw gateway startup and lifecycle RPC command layouts.
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const GATEWAY_OPTIONS_WITH_VALUE = new Set([
  "--auth",
  "--bind",
  "--container",
  "--log-level",
  "--password",
  "--password-file",
  "--port",
  "--profile",
  "--raw-stream-path",
  "--tailscale",
  "--token",
  "--ws-log",
]);
const GATEWAY_CALL_OPTIONS_WITH_VALUE = new Set([
  "--params",
  "--password",
  "--timeout",
  "--token",
  "--url",
]);
const GATEWAY_READ_ONLY = new Set([
  "diagnostics",
  "discover",
  "health",
  "logs",
  "probe",
  "stability",
  "status",
  "usage-cost",
]);
const LIFECYCLE_RPC_METHODS = new Set([
  "gateway.restart.request",
  "gateway.suspend.prepare",
  "gateway.suspend.resume",
  "update.run",
]);

function normalizedToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("`", "").replaceAll("^", "");
}

function scanFirstPositional(
  argv: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string>,
): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
    const name = normalizedToken(token).split("=", 1)[0] ?? "";
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return argv.length;
}

function hasEffectiveHelpOrVersion(argv: readonly string[], start: number): boolean {
  const optionsWithValue = new Set([
    ...GATEWAY_OPTIONS_WITH_VALUE,
    ...GATEWAY_CALL_OPTIONS_WITH_VALUE,
  ]);
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      break;
    }
    const name = normalizedToken(token).split("=", 1)[0] ?? "";
    if (optionsWithValue.has(name) && !token.includes("=")) {
      index += 1;
    } else if (HELP_OR_VERSION_FLAGS.has(token)) {
      return true;
    }
  }
  return false;
}

/** Return true when gateway argv starts a process or invokes a lifecycle RPC. */
export function classifyOpenClawGatewayArgv(argv: readonly string[], start: number): boolean {
  if (hasEffectiveHelpOrVersion(argv, start)) {
    return false;
  }
  const actionIndex = scanFirstPositional(argv, start, GATEWAY_OPTIONS_WITH_VALUE);
  const action = normalizedToken(argv[actionIndex]);
  if (!action) {
    return true;
  }
  if (action === "call") {
    const methodIndex = scanFirstPositional(argv, actionIndex + 1, GATEWAY_CALL_OPTIONS_WITH_VALUE);
    return LIFECYCLE_RPC_METHODS.has(normalizedToken(argv[methodIndex]));
  }
  return !GATEWAY_READ_ONLY.has(action);
}

/** Return true when an unresolved reference occupies the gateway RPC method position. */
export function unresolvedGatewayMethodMayHideLifecycle(
  argv: readonly string[],
  start: number,
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  const actionIndex = scanFirstPositional(argv, start, GATEWAY_OPTIONS_WITH_VALUE);
  if (normalizedToken(argv[actionIndex]) !== "call") {
    return false;
  }
  const methodIndex = scanFirstPositional(argv, actionIndex + 1, GATEWAY_CALL_OPTIONS_WITH_VALUE);
  return isUnresolved(argv[methodIndex]);
}
