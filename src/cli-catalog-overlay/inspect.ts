import { matchesCommandPath } from "../cli/command-path-matches.js";
import type { CliCatalogList } from "./list.js";

type CliCommandInspection = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "command-inventory-inspect";
  readonly commandPath: readonly string[];
  readonly resolvedCommandPath: readonly string[];
  readonly found: boolean;
  readonly descriptors: CliCatalogList["cli"]["descriptors"];
  readonly routes: CliCatalogList["cli"]["commandRoutes"];
  readonly routedOperations: CliCatalogList["cli"]["routedOperations"];
  readonly runtimeCommands: CliCatalogList["cli"]["runtimeCommands"];
  readonly pluginCommands: CliCatalogList["cli"]["pluginCommands"];
  readonly nodeCommands: CliCatalogList["cli"]["nodeCommands"];
};

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function resolveRuntimeCommandPath(
  commands: CliCatalogList["cli"]["runtimeCommands"],
  commandPath: readonly string[],
): readonly string[] {
  const resolved: string[] = [];
  for (const segment of commandPath) {
    const match = commands.find(
      (command) =>
        samePath(command.parentPath, resolved) &&
        (command.name === segment || command.aliases.includes(segment)),
    );
    if (!match) {
      return commandPath;
    }
    resolved.push(match.name);
  }
  return resolved;
}

export function inspectCommand(
  list: CliCatalogList,
  commandPath: readonly string[],
): CliCommandInspection {
  const resolvedCommandPath = resolveRuntimeCommandPath(list.cli.runtimeCommands, commandPath);
  const descriptors =
    resolvedCommandPath.length === 1
      ? list.cli.descriptors.filter((descriptor) => descriptor.name === resolvedCommandPath[0])
      : [];
  const routes = list.cli.commandRoutes.filter((route) =>
    matchesCommandPath([...resolvedCommandPath], route.commandPath, { exact: route.exact }),
  );
  const hasExactRoute = routes.some((route) => samePath(route.commandPath, resolvedCommandPath));
  const matchedRouteIds = new Set<string>(
    routes.flatMap((route) => (route.routeId ? [route.routeId] : [])),
  );
  const routedOperations = list.cli.routedOperations.filter((operation) =>
    matchedRouteIds.has(operation.id),
  );
  const hasExactRoutedOperation = routedOperations.some((operation) =>
    operation.commandPaths.some((path) => samePath(path, resolvedCommandPath)),
  );
  const runtimeCommands = list.cli.runtimeCommands.filter((command) =>
    samePath(command.commandPath, resolvedCommandPath),
  );
  const pluginCommands = list.cli.pluginCommands.filter((command) =>
    samePath(command.commandPath, resolvedCommandPath),
  );
  const nodeCommands = list.cli.nodeCommands.filter(
    (command) => command.command === resolvedCommandPath.join(" "),
  );
  const found =
    descriptors.length +
      Number(hasExactRoute) +
      Number(hasExactRoutedOperation) +
      runtimeCommands.length +
      pluginCommands.length +
      nodeCommands.length >
    0;

  return {
    schemaVersion: 1,
    generatedFrom: "command-inventory-inspect",
    commandPath,
    resolvedCommandPath,
    found,
    descriptors,
    routes,
    routedOperations,
    runtimeCommands,
    pluginCommands,
    nodeCommands,
  };
}

export function renderCommandInspectionMarkdown(inspection: CliCommandInspection): string {
  const path = inspection.commandPath.join(" ");
  if (!inspection.found) {
    return `# Command: ${path}\n\nNo matching command was found.\n`;
  }
  const json = JSON.stringify(inspection, null, 2);
  const longestFence = Math.max(0, ...Array.from(json.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return [
    `# Command: ${path}`,
    "",
    `- Descriptors: ${inspection.descriptors.length}`,
    `- Routes: ${inspection.routes.length}`,
    `- Routed operations: ${inspection.routedOperations.length}`,
    `- Runtime registrations: ${inspection.runtimeCommands.length}`,
    `- Plugin registrations: ${inspection.pluginCommands.length}`,
    `- Node commands: ${inspection.nodeCommands.length}`,
    "",
    `${fence}json`,
    json,
    fence,
    "",
  ].join("\n");
}
