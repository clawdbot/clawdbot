// Classifies commands that mutate OpenClaw's own exec approval policy.
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const OPTIONS_WITH_VALUE = new Set([
  "--agent",
  "--ask",
  "--ask-fallback",
  "--file",
  "--host",
  "--node",
  "--reason",
  "--security",
  "--timeout",
]);

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

function positionals(argv: readonly string[], start: number): string[] {
  const values: string[] = [];
  let parsingOptions = true;
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    const name = optionName(token);
    if (parsingOptions && HELP_OR_VERSION_FLAGS.has(token)) {
      return [];
    }
    if (parsingOptions && OPTIONS_WITH_VALUE.has(name)) {
      if (!token.includes("=")) {
        index += 1;
      }
    } else if (!parsingOptions || !token.startsWith("-") || token === "-") {
      values.push(token.toLowerCase());
    }
  }
  return values;
}

/** Return true when approvals or exec-policy argv changes or resolves approval state. */
export function classifyOpenClawApprovalPolicyArgv(
  command: string,
  argv: readonly string[],
  start: number,
): boolean {
  const args = positionals(argv, start);
  const action = args[0] ?? "";
  if (command === "exec-policy") {
    return ["preset", "set"].includes(action);
  }
  if (["resolve", "set"].includes(action)) {
    return true;
  }
  return action === "allowlist" && ["add", "remove"].includes(args[1] ?? "");
}

/** Return true when an unresolved reference can select an approval-policy mutation. */
export function unresolvedOpenClawApprovalPolicyActionMayMutate(
  command: string,
  argv: readonly string[],
  start: number,
  isUnresolved: (value: string | undefined) => boolean,
): boolean {
  const args = positionals(argv, start);
  if (isUnresolved(args[0])) {
    return true;
  }
  return command !== "exec-policy" && args[0] === "allowlist" && isUnresolved(args[1]);
}
