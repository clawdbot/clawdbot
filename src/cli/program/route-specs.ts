import { hasFlag } from "../argv.js";
import { cliCommandCatalog, type CliCommandCatalogEntry } from "../command-catalog.js";
import { matchesCommandPath } from "../command-path-matches.js";
import { resolveCliCommandPathPolicy } from "../command-path-policy.js";
import {
  routedCommandDefinitions,
  type AnyRoutedCommandDefinition,
} from "./routed-command-definitions.js";

export type RouteSpec = {
  matches: (path: string[]) => boolean;
  canRun?: (argv: string[]) => boolean;
  loadPlugins?: boolean | ((argv: string[]) => boolean);
  run: (argv: string[]) => Promise<boolean>;
};

function createCommandLoadPlugins(commandPath: readonly string[]): (argv: string[]) => boolean {
  return (argv) => {
    const loadPlugins = resolveCliCommandPathPolicy([...commandPath]).loadPlugins;
    return loadPlugins === "always" || (loadPlugins === "text-only" && !hasFlag(argv, "--json"));
  };
}

function createParsedRoute(params: {
  entry: CliCommandCatalogEntry;
  definition: AnyRoutedCommandDefinition;
}): RouteSpec {
  return {
    matches: (path) =>
      matchesCommandPath(path, params.entry.commandPath, { exact: params.entry.exact }),
    canRun: (argv) => Boolean(params.definition.parseArgs(argv)),
    loadPlugins: params.entry.route?.preloadPlugins
      ? createCommandLoadPlugins(params.entry.commandPath)
      : undefined,
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

export const routedCommands: RouteSpec[] = cliCommandCatalog
  .filter(
    (
      entry,
    ): entry is CliCommandCatalogEntry & { route: { id: keyof typeof routedCommandDefinitions } } =>
      Boolean(entry.route),
  )
  .map((entry) =>
    createParsedRoute({
      entry,
      definition: routedCommandDefinitions[entry.route.id],
    }),
  );
