// Normalized argv invocation summary used before Commander command dispatch.
import {
  getCommandPositionalsWithRootOptions,
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
} from "./argv.js";

const AGENT_PARENT_BOOLEAN_FLAGS = ["--local", "--deliver", "--json"];
const AGENT_PARENT_VALUE_FLAGS = [
  "-m",
  "--message",
  "--message-file",
  "-t",
  "--to",
  "--session-key",
  "--session-id",
  "--agent",
  "--model",
  "--thinking",
  "--verbose",
  "--channel",
  "--reply-to",
  "--reply-channel",
  "--reply-account",
  "--timeout",
];
const MODELS_PARENT_BOOLEAN_FLAGS = ["--json", "--status-json", "--status-plain"];
const MODELS_PARENT_VALUE_FLAGS = ["--agent"];

function resolveParentCommandPath(
  argv: string[],
  command: string,
  options: { booleanFlags: string[]; valueFlags: string[] },
): string[] | null {
  if (getPrimaryCommand(argv) !== command) {
    return null;
  }
  const child = getCommandPositionalsWithRootOptions(argv, {
    commandPath: [command],
    ...options,
    maxPositionals: 1,
  })?.[0];
  return child ? [command, child] : [command];
}

/** Resolves startup policy paths while consuming known parent-command option values. */
export function resolveCliStartupCommandPath(argv: string[]): string[] {
  return (
    resolveParentCommandPath(argv, "agent", {
      booleanFlags: AGENT_PARENT_BOOLEAN_FLAGS,
      valueFlags: AGENT_PARENT_VALUE_FLAGS,
    }) ??
    resolveParentCommandPath(argv, "models", {
      booleanFlags: MODELS_PARENT_BOOLEAN_FLAGS,
      valueFlags: MODELS_PARENT_VALUE_FLAGS,
    }) ??
    getCommandPathWithRootOptions(argv, 2)
  );
}

type CliArgvInvocation = {
  argv: string[];
  commandPath: string[];
  primary: string | null;
  hasHelpOrVersion: boolean;
  isRootHelpInvocation: boolean;
};

/** Resolves command path and help/version mode from a raw process argv array. */
export function resolveCliArgvInvocation(argv: string[]): CliArgvInvocation {
  return {
    argv,
    commandPath: resolveCliStartupCommandPath(argv),
    primary: getPrimaryCommand(argv),
    hasHelpOrVersion: isHelpOrVersionInvocation(argv),
    isRootHelpInvocation: isRootHelpInvocation(argv),
  };
}
