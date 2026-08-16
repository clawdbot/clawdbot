// Normalized argv invocation summary used before Commander command dispatch.
import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
} from "./argv.js";
import { resolveParentAwareCommandPath } from "./parent-command-path.js";

/** Resolves startup policy paths while consuming known parent-command option values. */
export function resolveCliStartupCommandPath(argv: string[]): string[] {
  return resolveParentAwareCommandPath(argv) ?? getCommandPathWithRootOptions(argv, 2);
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
