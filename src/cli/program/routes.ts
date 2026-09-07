import { cliCommandCatalog } from "../command-catalog.js";
import { matchesCommandPath } from "../command-path-matches.js";
import { routedCommandDefinitions } from "./routed-command-definitions.js";

/** Bind validated arguments before startup; defer command imports and execution until afterward. */
export function findRoutedCommand(path: string[], argv: string[]): (() => Promise<void>) | null {
  for (const entry of cliCommandCatalog) {
    if (!entry.route || !matchesCommandPath(path, entry.commandPath, { exact: entry.exact })) {
      continue;
    }
    const run = routedCommandDefinitions[entry.route.id](argv);
    if (run) {
      return run;
    }
  }
  return null;
}
