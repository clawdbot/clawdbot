// Normalized argv invocation summary used before Commander command dispatch.
import {
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
} from "./argv.js";
import { resolveGatewayCatalogCommandPath } from "./gateway-run-argv.js";
import { resolveCliParentCommandPath } from "./parent-command-path.js";

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
    commandPath:
      resolveGatewayCatalogCommandPath(argv) ??
      resolveCliParentCommandPath(argv) ??
      getCommandPathWithRootOptions(argv, 2),
    primary: getPrimaryCommand(argv),
    hasHelpOrVersion: isHelpOrVersionInvocation(argv),
    isRootHelpInvocation: isRootHelpInvocation(argv),
  };
}
