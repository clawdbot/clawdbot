// Classifies direct OpenClaw node-host service lifecycle commands.
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const NODE_SERVICE_MUTATIONS = new Set([
  "install",
  "restart",
  "run",
  "start",
  "stop",
  "uninstall",
  "worker",
]);
const NODE_SERVICE_OPTIONS_WITH_VALUE = new Set([
  "--context-path",
  "--display-name",
  "--host",
  "--node-id",
  "--port",
  "--runtime",
  "--tls-fingerprint",
]);

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function actionIndex(argv: readonly string[], start: number): number {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return index + 1;
    }
    const name = optionName(token);
    if (NODE_SERVICE_OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
  }
  return argv.length;
}

function hasEffectiveHelpOrVersion(argv: readonly string[], start: number): boolean {
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (token === "--") {
      return false;
    }
    const name = optionName(token);
    if (HELP_OR_VERSION_FLAGS.has(name)) {
      return true;
    }
    if (NODE_SERVICE_OPTIONS_WITH_VALUE.has(name) && !token.includes("=")) {
      index += 1;
    }
  }
  return false;
}

/** Return true when direct `openclaw node` argv changes node-host runtime state. */
export function classifyOpenClawNodeServiceArgv(argv: readonly string[], start: number): boolean {
  const index = actionIndex(argv, start);
  const action = (argv[index] ?? "").trim().toLowerCase();
  return NODE_SERVICE_MUTATIONS.has(action) && !hasEffectiveHelpOrVersion(argv, start);
}

/** Return true when a dynamic value occupies the node-service action position. */
export function unresolvedOpenClawNodeServiceActionMayMutate(
  argv: readonly string[],
  start: number,
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  return isUnresolved(argv[actionIndex(argv, start)]);
}
