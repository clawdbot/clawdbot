// Preparsed route specs for commands implemented outside Commander action registration.
import { cliCommandCatalog, type CliCommandCatalogEntry } from "../command-catalog.js";
import { matchesCommandPath } from "../command-path-matches.js";
import {
  routedCommandDefinitions,
  type AnyRoutedCommandDefinition,
} from "./routed-command-definitions.js";

/** Runtime route with argument validation before shared CLI startup. */
export type RouteSpec = {
  matches: (path: string[]) => boolean;
  canRun?: (argv: string[]) => boolean;
  run: (argv: string[]) => Promise<boolean>;
};

function createParsedRoute(params: {
  entry: CliCommandCatalogEntry;
  definition: AnyRoutedCommandDefinition;
}): RouteSpec {
  return {
    matches: (path) =>
      matchesCommandPath(path, params.entry.commandPath, { exact: params.entry.exact }),
    canRun: (argv) => Boolean(params.definition.parseArgs(argv)),
    run: async (argv) => {
      const args = params.definition.parseArgs(argv);
      if (!args) {
        return false;
      }
      await params.definition.runParsedArgs(args as never);
      return true;
    },
  };
}

/** Route specs generated from catalog entries with parseable routed-command definitions. */
export const routedCommands: RouteSpec[] = cliCommandCatalog
  .filter(
    (
      entry,
    ): entry is CliCommandCatalogEntry & { route: { id: keyof typeof routedCommandDefinitions } } =>
      Boolean(entry.route),
  )
  .flatMap((entry) => {
    const definition = routedCommandDefinitions[entry.route.id];
    return definition ? [createParsedRoute({ entry, definition })] : [];
  });
