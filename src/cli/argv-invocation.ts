// Normalized argv invocation summary used before Commander command dispatch.
import {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  isValueToken,
} from "../infra/cli-root-options.js";
import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
} from "./argv.js";

const AGENT_PARENT_BOOLEAN_FLAGS = new Set(["--local", "--deliver", "--json"]);
const AGENT_PARENT_VALUE_FLAGS = new Set([
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
]);

function consumeAgentParentOption(args: readonly string[], index: number): number {
  const arg = args[index];
  if (!arg?.startsWith("-") || arg === FLAG_TERMINATOR) {
    return 0;
  }
  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
  if (AGENT_PARENT_BOOLEAN_FLAGS.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }
  if (!AGENT_PARENT_VALUE_FLAGS.has(flag)) {
    return 0;
  }
  if (equalsIndex !== -1) {
    return arg.slice(equalsIndex + 1).trim() ? 1 : 0;
  }
  return isValueToken(args[index + 1]) ? 2 : 0;
}

function resolveAgentCommandPath(argv: string[]): string[] | null {
  const args = argv.slice(2);
  let sawAgent = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    if (!sawAgent) {
      const rootConsumed = consumeRootOptionToken(args, index);
      if (rootConsumed > 0) {
        index += rootConsumed - 1;
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
      if (arg !== "agent") {
        return null;
      }
      sawAgent = true;
      continue;
    }
    const rootConsumed = consumeRootOptionToken(args, index);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      const consumed = consumeAgentParentOption(args, index);
      if (consumed === 0) {
        return ["agent"];
      }
      index += consumed - 1;
      continue;
    }
    return ["agent", arg];
  }
  return sawAgent ? ["agent"] : null;
}

/** Resolves startup policy paths while consuming known parent-command option values. */
export function resolveCliStartupCommandPath(argv: string[]): string[] {
  return resolveAgentCommandPath(argv) ?? getCommandPathWithRootOptions(argv, 2);
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
